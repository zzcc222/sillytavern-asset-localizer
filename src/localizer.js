import fs from 'node:fs';
import path from 'node:path';
import { CHARACTERS_DIR, ASSETS_DIR, LEGACY_ASSETS_DIR, CACHE_DIR, CONFIG_FILE, DEFAULT_CONFIG, PLUGIN_ID, sanitizeFolderName } from './constants.js';
import { scanCard, parseCardData, getCardBaseName, getDirStats, scanAllCards } from './scanner.js';
import { batchDownload } from './downloader.js';
import { writePngTextChunk, readPngTextChunks } from './png-parser.js';

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

    return {
        assetsDir: ASSETS_DIR,
        totalFolders: folders.length,
        totalFiles,
        totalSizeBytes,
        totalSizeFormatted
    };
}

// Get rich card detail for the settings modal
export function getCardDetail(cardFileName) {
    const cardData = parseCardData(cardFileName);
    if (!cardData) {
        throw new Error('Card not found');
    }

    const scan = scanCard(cardFileName);
    const baseName = scan.baseName;
    const safeName = scan.safeName;
    const localPrefix = `/api/plugins/${PLUGIN_ID}/assets/${safeName}`;

    let decoded = cardData.decoded;
    let originalUrls = {};

    // 1. Try to read from JSON registry
    try {
        const parsed = JSON.parse(decoded);
        if (parsed.data?.extensions?.st_asset_localizer?.original_urls) {
            originalUrls = parsed.data.extensions.st_asset_localizer.original_urls;
        }
    } catch {}

    // 2. If no registry, try reading from .png.bak
    const bakPath = path.join(CHARACTERS_DIR, `${cardFileName}.bak`);
    if (Object.keys(originalUrls).length === 0 && fs.existsSync(bakPath)) {
        try {
            const bakBuf = fs.readFileSync(bakPath);
            const chunks = readPngTextChunks(bakBuf);
            const rawBak = chunks.chara || chunks.ccv3;
            if (rawBak) {
                const bakDecoded = Buffer.from(rawBak, 'base64').toString('utf-8');
                // Extract gh / catbox prefixes from bak
                const ghMatches = [...new Set(bakDecoded.match(/https:\/\/raw\.githubusercontent\.com\/[^\/'"`\\]+\/[^\/'"`\\]+\/[^\/'"`\\]+/g) || [])];
                for (const gh of ghMatches) {
                    originalUrls[localPrefix] = gh;
                }
                if (bakDecoded.includes('https://files.catbox.moe/')) {
                    originalUrls[`${localPrefix}/`] = 'https://files.catbox.moe/';
                }
            }
        } catch {}
    }

    // 3. Fallback for Catbox cards
    if (Object.keys(originalUrls).length === 0 && (scan.externalCatboxCount > 0 || scan.diskFilesCount > 100)) {
        originalUrls[`${localPrefix}/`] = 'https://files.catbox.moe/';
    }

    // Detect detected external prefix
    let detectedOriginalPrefix = Object.values(originalUrls)[0] || '';
    if (!detectedOriginalPrefix) {
        if (scan.externalGhCount > 0) detectedOriginalPrefix = 'GitHub Raw Repository';
        else if (scan.externalCatboxCount > 0) detectedOriginalPrefix = 'https://files.catbox.moe/';
        else detectedOriginalPrefix = '本地内置 / 暂无外部原链';
    }

    // Get files list sample
    const assetDir = path.join(ASSETS_DIR, safeName);
    const legacyDir = path.join(LEGACY_ASSETS_DIR, baseName);
    const targetDir = fs.existsSync(assetDir) ? assetDir : legacyDir;
    const diskFiles = fs.existsSync(targetDir) ? fs.readdirSync(targetDir) : [];

    // Build sample mapping
    const sampleMappings = diskFiles.slice(0, 15).map(filename => {
        let orig = 'https://.../' + filename;
        if (originalUrls[localPrefix]) {
            orig = `${originalUrls[localPrefix]}/${filename}`;
        } else if (originalUrls[`${localPrefix}/`]) {
            orig = `${originalUrls[`${localPrefix}/`]}${filename}`;
        }
        return {
            filename,
            localUrl: `${localPrefix}/${filename}`,
            originalUrl: orig
        };
    });

    return {
        cardFileName,
        baseName,
        safeName,
        currentMode: scan.isFullyLocalized ? 'local' : 'remote',
        localPrefix,
        originalPrefix: detectedOriginalPrefix,
        canRevert: scan.hasRevertBackup || Object.keys(originalUrls).length > 0 || fs.existsSync(bakPath),
        hasBakFile: scan.hasBakFile,
        diskCount: scan.diskFilesCount,
        diskSizeFormatted: scan.diskSizeFormatted,
        sampleMappings,
        totalMappingsCount: diskFiles.length
    };
}

export async function localizeCard(cardFileName, onProgress = () => {}) {
    const cardData = parseCardData(cardFileName);
    if (!cardData) {
        throw new Error('Card not found or missing metadata');
    }

    const scan = scanCard(cardFileName);
    const baseName = scan.baseName;
    const safeName = scan.safeName;
    const targetAssetDir = path.join(ASSETS_DIR, safeName);
    const config = loadConfig();

    if (!fs.existsSync(targetAssetDir)) {
        fs.mkdirSync(targetAssetDir, { recursive: true });
    }

    // 1. Download missing/external images
    let downloadResult = { completed: 0, failed: 0, total: 0 };
    if (scan.downloadTasks && scan.downloadTasks.length > 0) {
        downloadResult = await batchDownload(scan.downloadTasks, targetAssetDir, config, onProgress);
    }

    // 2. Backup card to .bak before modifying
    const cardPath = path.join(CHARACTERS_DIR, cardFileName);
    const bakPath = path.join(CHARACTERS_DIR, `${cardFileName}.bak`);
    if (!fs.existsSync(bakPath)) {
        fs.copyFileSync(cardPath, bakPath);
    }

    // 3. Build reverse mapping registry
    const localPrefix = `/api/plugins/${PLUGIN_ID}/assets/${safeName}`;
    const reverseMap = {};

    let newDecoded = cardData.decoded;

    // Detect GitHub Raw repos in card
    const ghRepoMatches = [...new Set(newDecoded.match(/https:\/\/raw\.githubusercontent\.com\/[^\/'"`\\]+\/[^\/'"`\\]+\/[^\/'"`\\]+/g) || [])];
    for (const ghBase of ghRepoMatches) {
        reverseMap[localPrefix] = ghBase;
        newDecoded = newDecoded.split(ghBase).join(localPrefix);
    }

    // Replace Catbox prefix
    if (newDecoded.includes('https://files.catbox.moe/')) {
        reverseMap[`${localPrefix}/`] = 'https://files.catbox.moe/';
        newDecoded = newDecoded.split('https://files.catbox.moe/').join(`${localPrefix}/`);
    }

    // Also migrate any previous legacy /card_assets/ paths to new universal route
    newDecoded = newDecoded.split(`/card_assets/${baseName}`).join(localPrefix);

    // Replace specific individual tasks
    if (scan.downloadTasks && scan.downloadTasks.length > 0) {
        for (const task of scan.downloadTasks) {
            const localFileUrl = `${localPrefix}/${task.filename}`;
            if (task.url && newDecoded.includes(task.url)) {
                reverseMap[localFileUrl] = task.url;
                newDecoded = newDecoded.split(task.url).join(localFileUrl);
            }
        }
    }

    // Embed reverse mapping into card JSON under data.extensions.st_asset_localizer.original_urls
    try {
        const parsed = JSON.parse(newDecoded);
        if (!parsed.data) parsed.data = {};
        if (!parsed.data.extensions) parsed.data.extensions = {};
        if (!parsed.data.extensions.st_asset_localizer) parsed.data.extensions.st_asset_localizer = {};
        
        const existing = parsed.data.extensions.st_asset_localizer.original_urls || {};
        parsed.data.extensions.st_asset_localizer.original_urls = { ...existing, ...reverseMap };
        parsed.data.extensions.st_asset_localizer.localized_at = new Date().toISOString();
        newDecoded = JSON.stringify(parsed);
    } catch {}

    // 4. Write back to PNG buffer
    const newRawBase64 = Buffer.from(newDecoded, 'utf-8').toString('base64');
    const newPngBuffer = writePngTextChunk(cardData.buffer, cardData.key, newRawBase64);
    fs.writeFileSync(cardPath, newPngBuffer);

    // 5. Clear SillyTavern character cache
    try {
        if (fs.existsSync(CACHE_DIR)) {
            const cachedFiles = fs.readdirSync(CACHE_DIR);
            for (const f of cachedFiles) {
                const fp = path.join(CACHE_DIR, f);
                if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
            }
        }
    } catch {}

    try {
        fs.chmodSync(targetAssetDir, 0o777);
    } catch {}

    const postScan = scanCard(cardFileName);
    return {
        success: true,
        baseName,
        safeName,
        downloadResult,
        postScan
    };
}

export async function revertCard(cardFileName, customOriginalBase = null) {
    const cardData = parseCardData(cardFileName);
    if (!cardData) {
        throw new Error('Card not found or missing metadata');
    }

    const scan = scanCard(cardFileName);
    const baseName = scan.baseName;
    const safeName = scan.safeName;
    const localPrefix = `/api/plugins/${PLUGIN_ID}/assets/${safeName}`;

    let decoded = cardData.decoded;
    let reverseMap = {};

    try {
        const parsed = JSON.parse(decoded);
        reverseMap = parsed.data?.extensions?.st_asset_localizer?.original_urls || {};
    } catch {}

    const cardPath = path.join(CHARACTERS_DIR, cardFileName);
    const bakPath = path.join(CHARACTERS_DIR, `${cardFileName}.bak`);

    if (customOriginalBase) {
        // User provided custom base URL to revert to
        decoded = decoded.split(localPrefix).join(customOriginalBase);
        decoded = decoded.split(`/card_assets/${baseName}`).join(customOriginalBase);
    } else if (Object.keys(reverseMap).length > 0) {
        // Precise reversion via registry
        for (const [localUrl, origUrl] of Object.entries(reverseMap)) {
            decoded = decoded.split(localUrl).join(origUrl);
        }
    } else if (fs.existsSync(bakPath)) {
        // Fallback: restore from .bak file
        fs.copyFileSync(bakPath, cardPath);
        return { success: true, cardFileName, method: 'bak_file', postScan: scanCard(cardFileName) };
    } else {
        // Smart fallback: if card is Catbox
        decoded = decoded.split(localPrefix + '/').join('https://files.catbox.moe/');
        decoded = decoded.split(`/card_assets/${baseName}/`).join('https://files.catbox.moe/');
    }

    try {
        const parsed = JSON.parse(decoded);
        if (parsed.data?.extensions?.st_asset_localizer) {
            delete parsed.data.extensions.st_asset_localizer;
        }
        decoded = JSON.stringify(parsed);
    } catch {}

    const newRawBase64 = Buffer.from(decoded, 'utf-8').toString('base64');
    const newPngBuffer = writePngTextChunk(cardData.buffer, cardData.key, newRawBase64);
    fs.writeFileSync(cardPath, newPngBuffer);

    // Clear cache
    try {
        if (fs.existsSync(CACHE_DIR)) {
            const cachedFiles = fs.readdirSync(CACHE_DIR);
            for (const f of cachedFiles) {
                const fp = path.join(CACHE_DIR, f);
                if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
            }
        }
    } catch {}

    const postScan = scanCard(cardFileName);
    return {
        success: true,
        cardFileName,
        postScan
    };
}

export function cleanOrphans() {
    if (!fs.existsSync(ASSETS_DIR)) return { deleted: [], count: 0 };
    const allCards = scanAllCards();
    const activeSafeNames = new Set(allCards.map(c => c.safeName));

    const folders = fs.readdirSync(ASSETS_DIR).filter(f => {
        try { return fs.statSync(path.join(ASSETS_DIR, f)).isDirectory(); } catch { return false; }
    });

    const deleted = [];
    for (const folder of folders) {
        if (!activeSafeNames.has(folder)) {
            const target = path.join(ASSETS_DIR, folder);
            try {
                fs.rmSync(target, { recursive: true, force: true });
                deleted.push(folder);
            } catch {}
        }
    }

    return { deleted, count: deleted.length };
}
