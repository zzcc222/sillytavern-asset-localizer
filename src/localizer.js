import fs from 'node:fs';
import path from 'node:path';
import { CHARACTERS_DIR, ASSETS_DIR, LEGACY_ASSETS_DIR, CACHE_DIR, CONFIG_FILE, DEFAULT_CONFIG, PLUGIN_ID, sanitizeFolderName } from './constants.js';
import { scanCard, parseCardData, getCardBaseName, getDirStats, scanAllCards } from './scanner.js';
import { batchDownload } from './downloader.js';
import { writePngTextChunk } from './png-parser.js';

export function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
        }
    } catch {}
    return { ...DEFAULT_CONFIG };
}

export function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf-8');
}

export function getGlobalStats() {
    if (!fs.existsSync(ASSETS_DIR)) {
        fs.mkdirSync(ASSETS_DIR, { recursive: true });
    }
    const folders = fs.readdirSync(ASSETS_DIR).filter(f => {
        try {
            return fs.statSync(path.join(ASSETS_DIR, f)).isDirectory();
        } catch { return false; }
    });

    let totalFiles = 0;
    let totalSizeBytes = 0;

    for (const folder of folders) {
        const stats = getDirStats(path.join(ASSETS_DIR, folder));
        totalFiles += stats.count;
        totalSizeBytes += stats.sizeBytes;
    }

    let totalSizeFormatted = `${totalSizeBytes} B`;
    if (totalSizeBytes > 1024 * 1024 * 1024) {
        totalSizeFormatted = `${(totalSizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (totalSizeBytes > 1024 * 1024) {
        totalSizeFormatted = `${(totalSizeBytes / (1024 * 1024)).toFixed(2)} MB`;
    } else if (totalSizeBytes > 1024) {
        totalSizeFormatted = `${(totalSizeBytes / 1024).toFixed(1)} KB`;
    }

    return {\n        assetsDir: ASSETS_DIR,\n        totalFolders: folders.length,\n        totalFiles,\n        totalSizeBytes,\n        totalSizeFormatted\n    };\n}\n\n// Get rich card asset inventory for details modal\nexport function getCardDetail(cardFileName) {\n    const cardData = parseCardData(cardFileName);\n    if (!cardData) {\n        throw new Error('Card not found');\n    }\n\n    const scan = scanCard(cardFileName);\n    const baseName = scan.baseName;\n    const safeName = scan.safeName;\n    const localPrefix = `/api/plugins/${PLUGIN_ID}/assets/${safeName}`;\n\n    // Get files list from disk\n    const assetDir = path.join(ASSETS_DIR, safeName);\n    const legacyDir = path.join(LEGACY_ASSETS_DIR, baseName);\n    const targetDir = fs.existsSync(assetDir) ? assetDir : legacyDir;\n    const diskFiles = fs.existsSync(targetDir) ? fs.readdirSync(targetDir) : [];\n\n    const detailedFiles = diskFiles.map(filename => {\n        let sizeBytes = 0;\n        try {\n            sizeBytes = fs.statSync(path.join(targetDir, filename)).size;\n        } catch {}\n\n        let sizeFormatted = `${sizeBytes} B`;\n        if (sizeBytes > 1024 * 1024) {\n            sizeFormatted = `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;\n        } else if (sizeBytes > 1024) {\n            sizeFormatted = `${(sizeBytes / 1024).toFixed(1)} KB`;\n        }\n\n        return {\n            filename,\n            sizeBytes,\n            sizeFormatted,\n            localUrl: `${localPrefix}/${filename}`\n        };\n    });\n\n    return {\n        cardFileName,\n        baseName,\n        safeName,\n        isFullyLocalized: scan.isFullyLocalized,\n        localPrefix,\n        diskFolder: `data/shared_card_assets/${safeName}`,\n        diskCount: diskFiles.length,\n        diskSizeFormatted: scan.diskSizeFormatted,\n        missingCount: scan.missingOnDiskCount,\n        missingFiles: scan.missingFiles || [],\n        totalExternalCount: scan.totalExternalCount || 0,\n        files: detailedFiles\n    };\n}\n\nexport async function localizeCard(cardFileName, onProgress = () => {}) {\n    const cardData = parseCardData(cardFileName);\n    if (!cardData) {\n        throw new Error('Card not found or missing metadata');\n    }\n\n    const scan = scanCard(cardFileName);\n    const baseName = scan.baseName;\n    const safeName = scan.safeName;\n    const targetAssetDir = path.join(ASSETS_DIR, safeName);\n    const config = loadConfig();\n\n    if (!fs.existsSync(targetAssetDir)) {\n        fs.mkdirSync(targetAssetDir, { recursive: true });\n    }\n\n    // 1. Download missing/external images\n    let downloadResult = { completed: 0, failed: 0, total: 0 };\n    if (scan.downloadTasks && scan.downloadTasks.length > 0) {\n        downloadResult = await batchDownload(scan.downloadTasks, targetAssetDir, config, onProgress);\n    }\n\n    // 2. Backup card to .bak before modifying\n    const cardPath = path.join(CHARACTERS_DIR, cardFileName);\n    const bakPath = path.join(CHARACTERS_DIR, `${cardFileName}.bak`);\n    if (!fs.existsSync(bakPath)) {\n        fs.copyFileSync(cardPath, bakPath);\n    }\n\n    // 3. Replace remote links with local server route\n    const localPrefix = `/api/plugins/${PLUGIN_ID}/assets/${safeName}`;\n    let newDecoded = cardData.decoded;\n\n    // Detect GitHub Raw repos in card\n    const ghRepoMatches = [...new Set(newDecoded.match(/https:\\/\\/raw\\.githubusercontent\\.com\\/[^\\/'\"`\\\\]+\\/[^\\/'\"`\\\\]+\\/[^\\/'\"`\\\\]+/g) || [])];\n    for (const ghBase of ghRepoMatches) {\n        newDecoded = newDecoded.split(ghBase).join(localPrefix);\n    }\n\n    // Replace Catbox prefix\n    if (newDecoded.includes('https://files.catbox.moe/')) {\n        newDecoded = newDecoded.split('https://files.catbox.moe/').join(`${localPrefix}/`);\n    }\n\n    // Also migrate any previous legacy /card_assets/ paths to new universal route\n    newDecoded = newDecoded.split(`/card_assets/${baseName}`).join(localPrefix);\n\n    // Replace specific individual tasks\n    if (scan.downloadTasks && scan.downloadTasks.length > 0) {\n        for (const task of scan.downloadTasks) {\n            const localFileUrl = `${localPrefix}/${task.filename}`;\n            if (task.url && newDecoded.includes(task.url)) {\n                newDecoded = newDecoded.split(task.url).join(localFileUrl);\n            }\n        }\n    }\n\n    // Embed metadata tag\n    try {\n        const parsed = JSON.parse(newDecoded);\n        if (!parsed.data) parsed.data = {};\n        if (!parsed.data.extensions) parsed.data.extensions = {};\n        if (!parsed.data.extensions.st_asset_localizer) parsed.data.extensions.st_asset_localizer = {};\n        parsed.data.extensions.st_asset_localizer.localized_at = new Date().toISOString();\n        newDecoded = JSON.stringify(parsed);\n    } catch {}\n\n    // 4. Write back to PNG buffer\n    const newRawBase64 = Buffer.from(newDecoded, 'utf-8').toString('base64');\n    const newPngBuffer = writePngTextChunk(cardData.buffer, cardData.key, newRawBase64);\n    fs.writeFileSync(cardPath, newPngBuffer);\n\n    // 5. Clear SillyTavern character cache\n    try {\n        if (fs.existsSync(CACHE_DIR)) {\n            const cachedFiles = fs.readdirSync(CACHE_DIR);\n            for (const f of cachedFiles) {\n                const fp = path.join(CACHE_DIR, f);\n                if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);\n            }\n        }\n    } catch {}\n\n    try {\n        fs.chmodSync(targetAssetDir, 0o777);\n    } catch {}\n\n    const postScan = scanCard(cardFileName);\n    return {\n        success: true,\n        baseName,\n        safeName,\n        downloadResult,\n        postScan\n    };\n}\n\nexport function cleanOrphans() {\n    if (!fs.existsSync(ASSETS_DIR)) return { deleted: [], count: 0 };\n    const allCards = scanAllCards();\n    const activeSafeNames = new Set(allCards.map(c => c.safeName));\n\n    const folders = fs.readdirSync(ASSETS_DIR).filter(f => {\n        try { return fs.statSync(path.join(ASSETS_DIR, f)).isDirectory(); } catch { return false; }\n    });\n\n    const deleted = [];\n    for (const folder of folders) {\n        if (!activeSafeNames.has(folder)) {\n            const target = path.join(ASSETS_DIR, folder);\n            try {\n                fs.rmSync(target, { recursive: true, force: true });\n                deleted.push(folder);\n            } catch {}\n        }\n    }\n\n    return { deleted, count: deleted.length };\n}\n