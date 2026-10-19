import fs from 'node:fs';
import path from 'node:path';
import { CHARACTERS_DIR, ASSETS_DIR, LEGACY_ASSETS_DIR, PLUGIN_ID, sanitizeFolderName } from './constants.js';
import { readPngTextChunks } from './png-parser.js';

export function getCardBaseName(cardFileName) {
    return cardFileName.replace(/\.png$/i, '');
}

export function parseCardData(cardFileName) {
    const cardPath = path.join(CHARACTERS_DIR, cardFileName);
    if (!fs.existsSync(cardPath)) return null;

    const buf = fs.readFileSync(cardPath);
    const chunks = readPngTextChunks(buf);
    const raw = chunks.chara || chunks.ccv3;
    if (!raw) return null;

    const key = chunks.chara ? 'chara' : 'ccv3';
    let decoded;
    try {
        decoded = Buffer.from(raw, 'base64').toString('utf-8');
    } catch {
        decoded = raw;
    }

    return { key, decoded, buffer: buf };
}

export function getDirStats(dirPath) {
    if (!fs.existsSync(dirPath)) return { count: 0, sizeBytes: 0, sizeFormatted: '0 B' };
    let count = 0;
    let sizeBytes = 0;
    try {
        const files = fs.readdirSync(dirPath);
        for (const f of files) {
            const fp = path.join(dirPath, f);
            try {
                const stat = fs.statSync(fp);
                if (stat.isFile()) {
                    count++;
                    sizeBytes += stat.size;
                }
            } catch {}
        }
    } catch {}

    let sizeFormatted = `${sizeBytes} B`;
    if (sizeBytes > 1024 * 1024 * 1024) {
        sizeFormatted = `${(sizeBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    } else if (sizeBytes > 1024 * 1024) {
        sizeFormatted = `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB`;
    } else if (sizeBytes > 1024) {
        sizeFormatted = `${(sizeBytes / 1024).toFixed(1)} KB`;
    }

    return { count, sizeBytes, sizeFormatted };
}

export function scanCard(cardFileName) {
    const cardData = parseCardData(cardFileName);
    if (!cardData) {
        return { error: 'Card not found or has no valid metadata', cardFileName };
    }

    const { decoded } = cardData;
    const baseName = getCardBaseName(cardFileName);
    const safeName = sanitizeFolderName(baseName);

    const assetDir = path.join(ASSETS_DIR, safeName);
    const legacyDir = path.join(LEGACY_ASSETS_DIR, baseName);

    const diskFiles = new Set();
    if (fs.existsSync(assetDir)) {
        for (const f of fs.readdirSync(assetDir)) diskFiles.add(f);
    }
    if (fs.existsSync(legacyDir)) {
        for (const f of fs.readdirSync(legacyDir)) diskFiles.add(f);
    }

    const SFW_CATS = ['uniform', 'daily', 'outing', 'training', 'naked'];
    const SFW_EMOS = ['calm', 'happy', 'distress', 'dazed'];
    const NSFW_VARS = ['blowjob', 'footjob', 'holding_pee', 'sex', 'anal', 'orgasm', 'anal_training', 'training', 'exhibition', 'nude_selfie', 'outdoor_selfie', 'indoor_selfie'];

    const downloadTasks = [];
    const externalUrls = new Set();

    // 1. Dynamic charactersData blocks
    const charBlocks = [...decoded.matchAll(/id:\s*'([^']+)'[\s\S]*?sfwBase:\s*'([^']+)'[\s\S]*?nsfwBase:\s*'([^']+)'[\s\S]*?pregBase:\s*'([^']+)'/g)];
    if (charBlocks.length > 0) {
        for (const b of charBlocks) {
            const cid = b[1];
            const sfwBase = b[2];
            const nsfwBase = b[3];
            const pregBase = b[4];

            if (sfwBase.startsWith('http')) {
                for (const cat of SFW_CATS) {
                    for (const emo of SFW_EMOS) {
                        const fname = `${cid}_${cat}_${emo}.png`;
                        downloadTasks.push({ filename: fname, url: `${sfwBase}/${fname}` });
                        externalUrls.add(`${sfwBase}/${fname}`);
                    }
                }
            }
            if (nsfwBase.startsWith('http')) {
                for (const v of NSFW_VARS) {
                    const fname = `${cid}_${v}.png`;
                    downloadTasks.push({ filename: fname, url: `${nsfwBase}/${fname}` });
                    externalUrls.add(`${nsfwBase}/${fname}`);
                }
            }
            if (pregBase.startsWith('http')) {
                for (const cat of SFW_CATS) {
                    const fname = `${cid}_pregnant_${cat}.png`;
                    downloadTasks.push({ filename: fname, url: `${pregBase}/${fname}` });
                    externalUrls.add(`${pregBase}/${fname}`);
                }
            }
        }
    }

    // 2. baseUrlMap blocks
    const baseMapMatch = decoded.match(/baseUrlMap\s*=\s*\{([^}]+)\}/);
    if (baseMapMatch) {
        const entries = [...baseMapMatch[1].matchAll(/([a-zA-Z0-9_]+):\s*['"](https?:\/\/[^'"]+)['"]/g)];
        for (const e of entries) {
            const charCode = e[1];
            const baseUrl = e[2];
            for (const v of NSFW_VARS) {
                const fname = `${charCode}_${v}.png`;
                if (!downloadTasks.some(t => t.filename === fname)) {
                    downloadTasks.push({ filename: fname, url: `${baseUrl}/${fname}` });
                    externalUrls.add(`${baseUrl}/${fname}`);
                }
            }
        }
    }

    // 3. Catbox URLs
    const catboxMatches = [...new Set(decoded.match(/https:\/\/files\.catbox\.moe\/[a-zA-Z0-9_\-\.]+\.(?:webp|png|jpg|jpeg|gif)/gi) || [])];
    for (const u of catboxMatches) {
        const fname = path.basename(u);
        if (!downloadTasks.some(t => t.filename === fname)) {
            downloadTasks.push({ filename: fname, url: u });
            externalUrls.add(u);
        }
    }

    // 4. GitHub Raw direct image URLs
    const ghRawMatches = [...new Set(decoded.match(/https:\/\/raw\.githubusercontent\.com\/[^\s"'`<>\\,]+?\.(?:png|jpg|jpeg|webp|gif)/gi) || [])];
    for (const u of ghRawMatches) {
        const fname = path.basename(u);
        if (!downloadTasks.some(t => t.filename === fname)) {
            downloadTasks.push({ filename: fname, url: u });
            externalUrls.add(u);
        }
    }

    // 5. Generic external image URLs
    const genericImgMatches = [...new Set(decoded.match(/https?:\/\/[^\s"'`<>\\,]+?\.(?:png|jpg|jpeg|webp|gif)/gi) || [])];
    for (const u of genericImgMatches) {
        if (!u.includes('catbox.moe') && !u.includes('w3.org') && !u.includes('shields.io') && !u.includes('github.com/')) {
            const fname = path.basename(u);
            if (!downloadTasks.some(t => t.filename === fname)) {
                downloadTasks.push({ filename: fname, url: u });
                externalUrls.add(u);
            }
        }
    }

    const newLocalMatches = (decoded.match(new RegExp(`/api/plugins/${PLUGIN_ID}/assets/${safeName}`, 'g')) || []).length;
    const legacyLocalMatches = (decoded.match(new RegExp(`/card_assets/${baseName}`, 'g')) || []).length;
    const totalLocalMatches = newLocalMatches + legacyLocalMatches;

    const ghCount = (decoded.match(/https:\/\/raw\.githubusercontent\.com/g) || []).length;
    const cbCount = (decoded.match(/https:\/\/files\.catbox\.moe/g) || []).length;
    const totalExternalCount = ghCount + cbCount + (downloadTasks.length > 0 && ghCount === 0 && cbCount === 0 ? downloadTasks.length : 0);

    let missingFiles = [];
    if (downloadTasks.length > 0) {
        for (const t of downloadTasks) {
            if (!diskFiles.has(t.filename)) {
                missingFiles.push(t.filename);
            }
        }
    }

    // Check backup availability: registry in JSON OR .png.bak on disk OR known external pattern
    const bakPath = path.join(CHARACTERS_DIR, `${cardFileName}.bak`);
    const hasBakFile = fs.existsSync(bakPath);

    let hasRevertBackup = hasBakFile;
    let originalUrlsCount = 0;
    try {
        const parsedJson = JSON.parse(decoded);
        const backupUrls = parsedJson.data?.extensions?.st_asset_localizer?.original_urls;
        if (backupUrls && typeof backupUrls === 'object' && Object.keys(backupUrls).length > 0) {
            hasRevertBackup = true;
            originalUrlsCount = Object.keys(backupUrls).length;
        }
    } catch {}

    const dirStats = getDirStats(fs.existsSync(assetDir) ? assetDir : legacyDir);
    const isFullyLocalized = totalExternalCount === 0 && (totalLocalMatches > 0 || (downloadTasks.length === 0 && dirStats.count === 0));

    return {
        cardFileName,
        baseName,
        safeName,
        localAssetRefMatches: totalLocalMatches,
        externalGhCount: ghCount,
        externalCatboxCount: cbCount,
        totalExternalCount,
        totalTasks: downloadTasks.length,
        diskFilesCount: diskFiles.size,
        missingOnDiskCount: missingFiles.length,
        missingFiles: missingFiles.slice(0, 20),
        diskSizeFormatted: dirStats.sizeFormatted,
        diskSizeBytes: dirStats.sizeBytes,
        isFullyLocalized,
        hasRevertBackup,
        hasBakFile,
        originalUrlsCount,
        downloadTasks
    };
}

export function scanAllCards() {
    if (!fs.existsSync(CHARACTERS_DIR)) return [];
    const files = fs.readdirSync(CHARACTERS_DIR).filter(f => f.endsWith('.png') && !f.endsWith('.bak'));
    return files.map(f => scanCard(f));
}
