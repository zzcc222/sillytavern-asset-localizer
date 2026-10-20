import fs from 'node:fs';
import path from 'node:path';
import { CHARACTERS_DIR, ASSETS_DIR, LEGACY_ASSETS_DIR, CACHE_DIR, CONFIG_FILE, DEFAULT_CONFIG, PLUGIN_ID, sanitizeFolderName } from './constants.js';
import { scanCard, parseCardData, getCardBaseName, getDirStats, scanAllCards, unescapeUrl } from './scanner.js';
import { batchDownload } from './downloader.js';
import { writePngTextChunk } from './png-parser.js';

function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function replaceUrlVariants(text, fromUrl, toUrl) {
    if (!text || !fromUrl || !toUrl) return text;

    const fromNoSlash = fromUrl.replace(/\/+$/, '');
    const toNoSlash = toUrl.replace(/\/+$/, '');
    const toWithSlash = `${toNoSlash}/`;

    const bases = [fromNoSlash];
    if (fromNoSlash.startsWith('https://')) {
        bases.push('http://' + fromNoSlash.slice(8));
    }

    let result = text;
    for (const base of bases) {
        const directSlash = `${base}/`;
        const escapedSlash = directSlash.replace(/\//g, '\\/');
        const directNoSlash = base;
        const escapedNoSlash = base.replace(/\//g, '\\/');

        // Delimiter pattern: closing quotes, backslash-escaped quote, backtick, whitespace, comma, bracket, brace, or end of string
        const delim = '(?=["\'`<>\\s,;}\\]]|\\\\["\'`]|$)';
        const targetAtEnd = toUrl.endsWith('/') ? toWithSlash : toNoSlash;

        // 1. Solidus with trailing slash at end of URL (before delimiter) -> honor trailing slash preference
        result = result.replace(new RegExp(escapeRegExp(escapedSlash) + delim, 'g'), targetAtEnd);
        result = result.replace(new RegExp(escapeRegExp(directSlash) + delim, 'g'), targetAtEnd);

        // 2. Solidus within path (followed by non-delimiter, e.g. filename) -> MUST preserve trailing slash separator
        result = result.replace(new RegExp(escapeRegExp(escapedSlash), 'g'), toWithSlash);
        result = result.replace(new RegExp(escapeRegExp(directSlash), 'g'), toWithSlash);

        // 3. No trailing slash
        result = result.replace(new RegExp(escapeRegExp(escapedNoSlash), 'g'), toNoSlash);
        result = result.replace(new RegExp(escapeRegExp(directNoSlash), 'g'), toNoSlash);
    }

    return result;
}

export function loadConfig() {
    try {
        if (fs.existsSync(CONFIG_FILE)) {
            return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')) };
        }
    } catch {}
    return { ...DEFAULT_CONFIG };
}

export function saveConfig(cfg) {
    const dir = path.dirname(CONFIG_FILE);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const current = loadConfig();
    const merged = { ...current, ...(cfg || {}) };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
    return merged;
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

export function getCardDetail(cardFileName) {
    const cardData = parseCardData(cardFileName);
    if (!cardData) {
        throw new Error('Card not found');
    }

    const scan = scanCard(cardFileName);
    const baseName = scan.baseName;
    const safeName = scan.safeName;
    const localPrefix = `/api/plugins/${PLUGIN_ID}/assets/${safeName}`;

    const assetDir = path.join(ASSETS_DIR, safeName);
    const legacyDir = path.join(LEGACY_ASSETS_DIR, baseName);
    const targetDir = fs.existsSync(assetDir) ? assetDir : legacyDir;
    const diskFiles = fs.existsSync(targetDir)
        ? fs.readdirSync(targetDir).filter(f => {
            try { return fs.statSync(path.join(targetDir, f)).isFile(); } catch { return false; }
        })
        : [];

    const detailedFiles = diskFiles.map(filename => {
        let sizeBytes = 0;
        try {
            sizeBytes = fs.statSync(path.join(targetDir, filename)).size;
        } catch {}

        let sizeFormatted = `${sizeBytes} B`;
        if (sizeBytes > 1024 * 1024) {
            sizeFormatted = `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
        } else if (sizeBytes > 1024) {
            sizeFormatted = `${(sizeBytes / 1024).toFixed(1)} KB`;
        }

        return {
            filename,
            sizeBytes,
            sizeFormatted,
            localUrl: `${localPrefix}/${filename}`
        };
    });

    return {
        cardFileName,
        baseName,
        safeName,
        isFullyLocalized: scan.isFullyLocalized,
        localPrefix,
        diskFolder: `data/shared_card_assets/${safeName}`,
        diskCount: diskFiles.length,
        diskSizeFormatted: scan.diskSizeFormatted,
        missingCount: scan.missingOnDiskCount,
        missingFiles: scan.missingFiles || [],
        totalExternalCount: scan.totalExternalCount || 0,
        files: detailedFiles
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
    const cardPath = cardData.cardPath || (path.isAbsolute(cardFileName) ? cardFileName : path.join(CHARACTERS_DIR, cardFileName));
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
    const bakPath = `${cardPath}.bak`;
    if (!fs.existsSync(bakPath) && fs.existsSync(cardPath)) {
        fs.copyFileSync(cardPath, bakPath);
    }

    // 3. Replace remote links with local server route
    const localPrefix = `/api/plugins/${PLUGIN_ID}/assets/${safeName}`;
    const originalUrls = {};

    // Sort by URL length descending to prevent shorter prefix collisions
    const sortedBaseUrls = [...(scan.externalBaseUrls || [])].sort((a, b) => b.length - a.length);
    const sortedTasks = [...(scan.downloadTasks || [])].sort((a, b) => (b.url?.length || 0) - (a.url?.length || 0));

    // Update each metadata chunk (e.g. both 'ccv3' and 'chara' if present)
    let newPngBuffer = cardData.buffer;
    const targetKeys = cardData.keys && cardData.keys.length > 0 ? cardData.keys : [cardData.key];

    for (const k of targetKeys) {
        let chunkText = cardData.decodedMap?.[k] || cardData.decoded;

        // A. Replace specific individual image tasks (longer, specific URLs first to prevent prefix truncation)
        for (const task of sortedTasks) {
            const localFileUrl = `${localPrefix}/${task.filename}`;
            if (task.url) {
                originalUrls[task.url] = localFileUrl;
                chunkText = replaceUrlVariants(chunkText, task.url, localFileUrl);
            }
        }

        // B. Replace base URLs from charactersData and baseUrlMap
        for (const bUrl of sortedBaseUrls) {
            originalUrls[bUrl] = localPrefix;
            chunkText = replaceUrlVariants(chunkText, bUrl, localPrefix);
        }

        // C. Replace Catbox domain prefixes
        originalUrls['https://files.catbox.moe/'] = `${localPrefix}/`;
        originalUrls['https://catbox.moe/'] = `${localPrefix}/`;
        chunkText = replaceUrlVariants(chunkText, 'https://files.catbox.moe/', `${localPrefix}/`);
        chunkText = replaceUrlVariants(chunkText, 'http://files.catbox.moe/', `${localPrefix}/`);
        chunkText = replaceUrlVariants(chunkText, 'https://catbox.moe/', `${localPrefix}/`);
        chunkText = replaceUrlVariants(chunkText, 'http://catbox.moe/', `${localPrefix}/`);

        // D. Also migrate any previous legacy /card_assets/ paths to new universal route
        chunkText = replaceUrlVariants(chunkText, `/card_assets/${baseName}`, localPrefix);

        // E. Embed metadata tag into card JSON
        try {
            const parsed = JSON.parse(chunkText);
            if (!parsed.data) parsed.data = {};
            if (!parsed.data.extensions) parsed.data.extensions = {};
            if (!parsed.data.extensions.st_asset_localizer) parsed.data.extensions.st_asset_localizer = {};
            parsed.data.extensions.st_asset_localizer.localized_at = new Date().toISOString();
            if (Object.keys(originalUrls).length > 0) {
                parsed.data.extensions.st_asset_localizer.original_urls = {
                    ...(parsed.data.extensions.st_asset_localizer.original_urls || {}),
                    ...originalUrls
                };
            }
            chunkText = JSON.stringify(parsed);
        } catch {}

        const newRawBase64 = Buffer.from(chunkText, 'utf-8').toString('base64');
        newPngBuffer = writePngTextChunk(newPngBuffer, k, newRawBase64);
    }

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

export function revertCard(cardFileName) {
    const cardData = parseCardData(cardFileName);
    if (!cardData) {
        throw new Error('Card not found or missing metadata');
    }

    const cardPath = cardData.cardPath;
    const bakPath = `${cardPath}.bak`;

    // 1. If .bak file exists on disk, restore directly
    if (fs.existsSync(bakPath)) {
        fs.copyFileSync(bakPath, cardPath);

        // Clear SillyTavern cache
        try {
            if (fs.existsSync(CACHE_DIR)) {
                for (const f of fs.readdirSync(CACHE_DIR)) {
                    const fp = path.join(CACHE_DIR, f);
                    if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
                }
            }
        } catch {}

        const postScan = scanCard(cardFileName);
        return {
            success: true,
            method: 'bak_file',
            postScan
        };
    }

    // 2. Revert from embedded original_urls mapping
    try {
        let originalUrls = null;
        for (const k of (cardData.keys || [cardData.key])) {
            const chunk = cardData.decodedMap?.[k] || cardData.decoded;
            try {
                const parsed = JSON.parse(chunk);
                const target = parsed.data || parsed;
                if (target.extensions?.st_asset_localizer?.original_urls) {
                    originalUrls = target.extensions.st_asset_localizer.original_urls;
                    break;
                }
            } catch {}
        }

        if (originalUrls && typeof originalUrls === 'object' && Object.keys(originalUrls).length > 0) {
            let newPngBuffer = cardData.buffer;
            const targetKeys = cardData.keys && cardData.keys.length > 0 ? cardData.keys : [cardData.key];
            for (const k of targetKeys) {
                let chunkText = cardData.decodedMap?.[k] || cardData.decoded;
                // Invert replacements: localUrl -> remoteUrl
                for (const [remoteUrl, localUrl] of Object.entries(originalUrls)) {
                    chunkText = replaceUrlVariants(chunkText, localUrl, remoteUrl);
                }
                // Strip plugin extension metadata
                try {
                    const cleanParsed = JSON.parse(chunkText);
                    const cleanTarget = cleanParsed.data || cleanParsed;
                    if (cleanTarget.extensions?.st_asset_localizer) {
                        delete cleanTarget.extensions.st_asset_localizer;
                        if (Object.keys(cleanTarget.extensions).length === 0) {
                            delete cleanTarget.extensions;
                        }
                    }
                    chunkText = JSON.stringify(cleanParsed);
                } catch {}

                const newRawBase64 = Buffer.from(chunkText, 'utf-8').toString('base64');
                newPngBuffer = writePngTextChunk(newPngBuffer, k, newRawBase64);
            }
            fs.writeFileSync(cardPath, newPngBuffer);

            // Clear SillyTavern cache
            try {
                if (fs.existsSync(CACHE_DIR)) {
                    for (const f of fs.readdirSync(CACHE_DIR)) {
                        const fp = path.join(CACHE_DIR, f);
                        if (fs.statSync(fp).isFile()) fs.unlinkSync(fp);
                    }
                }
            } catch {}

            const postScan = scanCard(cardFileName);
            return {
                success: true,
                method: 'original_urls_reversion',
                postScan
            };
        }
    } catch {}

    throw new Error('No backup (.bak) or original URL metadata found to revert card');
}

export function cleanOrphans() {
    if (!fs.existsSync(ASSETS_DIR)) return { deleted: [], count: 0 };
    const allCards = scanAllCards();
    // Safety guard: never wipe assets if no cards are detected or readable
    if (allCards.length === 0) return { deleted: [], count: 0 };

    const activeSafeNames = new Set();
    for (const c of allCards) {
        if (c.safeName) {
            activeSafeNames.add(c.safeName.toLowerCase());
        }
        if (c.baseName) {
            activeSafeNames.add(c.baseName.toLowerCase());
        }
        if (c.cardFileName) {
            const derivedBase = getCardBaseName(path.basename(c.cardFileName));
            activeSafeNames.add(sanitizeFolderName(derivedBase).toLowerCase());
            activeSafeNames.add(derivedBase.toLowerCase());
        }
    }

    const folders = fs.readdirSync(ASSETS_DIR).filter(f => {
        try {
            if (f.startsWith('.') || f.startsWith('_')) return false;
            return fs.statSync(path.join(ASSETS_DIR, f)).isDirectory();
        } catch { return false; }
    });

    const deleted = [];
    for (const folder of folders) {
        if (!activeSafeNames.has(folder.toLowerCase())) {
            const target = path.join(ASSETS_DIR, folder);
            try {
                fs.rmSync(target, { recursive: true, force: true });
                deleted.push(folder);
            } catch {}
        }
    }

    return { deleted, count: deleted.length };
}
