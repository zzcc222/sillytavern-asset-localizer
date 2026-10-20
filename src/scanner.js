import fs from 'node:fs';
import path from 'node:path';
import { CHARACTERS_DIR, ASSETS_DIR, LEGACY_ASSETS_DIR, PLUGIN_ID, sanitizeFolderName } from './constants.js';
import { readPngTextChunks } from './png-parser.js';

export function getCardBaseName(cardFileName) {
    if (!cardFileName || typeof cardFileName !== 'string') return '';
    const normalized = cardFileName.replace(/\\/g, '/');
    const base = path.basename(normalized);
    return base.replace(/\.png$/i, '');
}

export function parseCardData(cardFileName) {
    const cardPath = path.isAbsolute(cardFileName) ? cardFileName : path.join(CHARACTERS_DIR, cardFileName);
    if (!fs.existsSync(cardPath)) return null;

    let buf;
    try {
        buf = fs.readFileSync(cardPath);
    } catch {
        return null;
    }
    const chunks = readPngTextChunks(buf);
    if (!chunks.chara && !chunks.ccv3) return null;

    const keys = [];
    if (chunks.ccv3) keys.push('ccv3');
    if (chunks.chara) keys.push('chara');

    const decodedMap = {};
    for (const k of keys) {
        try {
            decodedMap[k] = Buffer.from(chunks[k], 'base64').toString('utf-8');
        } catch {
            decodedMap[k] = chunks[k];
        }
    }

    const key = chunks.ccv3 ? 'ccv3' : 'chara';
    const decoded = decodedMap[key];

    return { key, keys, decoded, decodedMap, buffer: buf, cardPath };
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

export function unescapeUrl(url) {
    if (!url || typeof url !== 'string') return '';
    return url.replace(/\\\//g, '/').trim();
}

export function extractCleanFilename(url, fallbackStem = 'image') {
    const clean = unescapeUrl(url);
    try {
        const withoutQuery = clean.split(/[?#]/)[0].replace(/\\/g, '/');
        const base = path.basename(withoutQuery);
        let sanitized = sanitizeFolderName(base);
        if (sanitized && sanitized !== 'card') {
            if (!path.extname(sanitized)) {
                sanitized = `${sanitized}.png`;
            }
            return sanitized;
        }
    } catch {}
    return `${fallbackStem}.png`;
}

export function extractCardVariants(text) {
    if (!text || typeof text !== 'string') return null;
    const varMatch = text.match(/(?:const|var|let)?\s*["']?variants["']?\s*[:=]\s*\{([^}]+)\}/i);
    if (varMatch) {
        const values = [];
        for (const m of varMatch[1].matchAll(/:\s*['"]([a-zA-Z0-9_\-]+)['"]/g)) {
            if (!values.includes(m[1])) values.push(m[1]);
        }
        if (values.length > 0) return values;
    }
    return null;
}

export function extractCharBlocks(text) {
    if (!text || typeof text !== 'string') return [];
    const blocks = [];
    const seenStarts = new Set();
    const regex = /(?:\\*["']?(?:sfwBase|nsfwBase|pregBase)\\*["']?)\s*[:=]/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const keyPos = match.index;
        let depth = 0;
        let startPos = -1;
        for (let i = keyPos - 1; i >= 0; i--) {
            const ch = text[i];
            if (ch === '}') depth++;
            else if (ch === '{') {
                if (depth === 0) {
                    startPos = i;
                    break;
                }
                depth--;
            }
        }
        if (startPos === -1 || seenStarts.has(startPos)) continue;
        seenStarts.add(startPos);

        let openCount = 0;
        let endPos = -1;
        for (let i = startPos; i < text.length; i++) {
            const ch = text[i];
            if (ch === '{') openCount++;
            else if (ch === '}') {
                openCount--;
                if (openCount === 0) {
                    endPos = i;
                    break;
                }
            }
        }
        if (endPos !== -1) {
            blocks.push(text.slice(startPos, endPos + 1));
        }
    }
    return blocks;
}

function findPngFilesRecursively(dir, baseDir = dir) {
    let results = [];
    if (!fs.existsSync(dir)) return results;
    try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results = results.concat(findPngFilesRecursively(fullPath, baseDir));
            } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.png') && !entry.name.toLowerCase().endsWith('.bak')) {
                const relPath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
                results.push(relPath);
            }
        }
    } catch {}
    return results;
}

export function scanCard(cardFileName) {
    const cardData = parseCardData(cardFileName);
    if (!cardData) {
        return { error: 'Card not found or has no valid metadata', cardFileName };
    }

    const { decoded, decodedMap, cardPath } = cardData;
    const originalUrlMap = {};
    const chunksToProcess = decodedMap ? Object.values(decodedMap) : [decoded];
    const cleanChunks = [];

    for (const rawChunk of chunksToProcess) {
        if (!rawChunk || typeof rawChunk !== 'string') continue;
        let chunkText = rawChunk;
        try {
            const parsed = JSON.parse(rawChunk);
            const target = parsed.data || parsed;
            const backupUrls = target.extensions?.st_asset_localizer?.original_urls;
            if (backupUrls && typeof backupUrls === 'object') {
                for (const [remote, local] of Object.entries(backupUrls)) {
                    if (typeof remote === 'string' && typeof local === 'string') {
                        originalUrlMap[local.replace(/\/+$/, '')] = remote.replace(/\/+$/, '');
                    }
                }
            }
            if (target.extensions?.st_asset_localizer?.original_urls) {
                const cleanObj = JSON.parse(rawChunk);
                const cleanTarget = cleanObj.data || cleanObj;
                if (cleanTarget.extensions?.st_asset_localizer) {
                    delete cleanTarget.extensions.st_asset_localizer.original_urls;
                }
                chunkText = JSON.stringify(cleanObj);
            }
        } catch {}
        cleanChunks.push(chunkText);
    }
    const textToScan = cleanChunks.join('\n');

    const baseFileName = path.basename(cardFileName);
    const baseName = getCardBaseName(baseFileName);
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
    const DEFAULT_NSFW_VARS = ['blowjob', 'footjob', 'holding_pee', 'sex', 'anal', 'orgasm', 'anal_training', 'training', 'exhibition', 'nude_selfie', 'outdoor_selfie', 'indoor_selfie'];
    const detectedVariants = extractCardVariants(textToScan) || DEFAULT_NSFW_VARS;

    const downloadTasks = [];
    const externalUrls = new Set();
    const externalBaseUrls = new Set();
    const missingFiles = [];

    const newLocalPrefix = `/api/plugins/${PLUGIN_ID}/assets/${safeName}`;
    const legacyLocalPrefix = `/card_assets/${baseName}`;

    function addTask(filename, url, baseUrl = null) {
        if (!url || typeof url !== 'string') return;
        const cleanUrl = unescapeUrl(url);
        if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) return;

        let targetFilename = filename;
        const existing = downloadTasks.find(t => t.url === cleanUrl);
        if (existing) return;

        // Disambiguate duplicate filenames for different URLs
        let collisionIdx = 1;
        while (downloadTasks.some(t => t.filename.toLowerCase() === targetFilename.toLowerCase())) {
            const ext = path.extname(filename) || '.png';
            const nameWithoutExt = filename.slice(0, -ext.length) || 'image';
            collisionIdx++;
            targetFilename = `${nameWithoutExt}_${collisionIdx}${ext}`;
        }

        downloadTasks.push({
            filename: targetFilename,
            url: cleanUrl,
            ...(baseUrl ? { baseUrl: unescapeUrl(baseUrl) } : {})
        });
        externalUrls.add(cleanUrl);
    }

    // 1. Dynamic charactersData blocks - supports nested overrides and arbitrary fields
    const charBlocks = extractCharBlocks(textToScan);
    for (const rawBlock of charBlocks) {
        const block = rawBlock.replace(/\\"/g, '"').replace(/\\'/g, "'");
        const idMatch = block.match(/(?:^|[^a-zA-Z0-9_])(?:id|name|characterId)["']?\s*:\s*["']([^"']+)["']/i);
        const sfwMatch = block.match(/(?:^|[^a-zA-Z0-9_])sfwBase["']?\s*:\s*["']([^"']+)["']/i);
        const nsfwMatch = block.match(/(?:^|[^a-zA-Z0-9_])nsfwBase["']?\s*:\s*["']([^"']+)["']/i);
        const pregMatch = block.match(/(?:^|[^a-zA-Z0-9_])pregBase["']?\s*:\s*["']([^"']+)["']/i);

        const rawCid = (idMatch ? idMatch[1] : baseName).trim();
        const cid = sanitizeFolderName(rawCid);

        const overrideMatch = block.match(/overrides\s*:\s*\{([^}]+)\}/i);
        const charOverrides = {};
        if (overrideMatch) {
            for (const om of overrideMatch[1].matchAll(/['"]?([a-zA-Z0-9_\-]+)['"]?\s*:\s*['"]([^'"]+)['"]/g)) {
                charOverrides[om[1]] = path.basename(om[2].replace(/\\/g, '/').replace(/\\\//g, '/').trim());
            }
        }

        if (sfwMatch) {
            const rawSfw = unescapeUrl(sfwMatch[1]).replace(/\/+$/, '');
            const isLocal = rawSfw.includes(newLocalPrefix) || rawSfw.includes(legacyLocalPrefix);
            const remoteBase = rawSfw.startsWith('http') ? rawSfw : (originalUrlMap[rawSfw] || null);
            if (remoteBase && !isLocal) externalBaseUrls.add(remoteBase);
            if (rawSfw.startsWith('http')) {
                for (const cat of SFW_CATS) {
                    for (const emo of SFW_EMOS) {
                        const fname = `${cid}_${cat}_${emo}.png`;
                        addTask(fname, `${rawSfw}/${fname}`, rawSfw);
                    }
                }
            } else if (isLocal && diskFiles.size === 0 && remoteBase) {
                for (const cat of SFW_CATS) {
                    for (const emo of SFW_EMOS) {
                        const fname = `${cid}_${cat}_${emo}.png`;
                        addTask(fname, `${remoteBase}/${fname}`, remoteBase);
                    }
                }
            }
        }
        if (nsfwMatch) {
            const rawNsfw = unescapeUrl(nsfwMatch[1]).replace(/\/+$/, '');
            const isLocal = rawNsfw.includes(newLocalPrefix) || rawNsfw.includes(legacyLocalPrefix);
            const remoteBase = rawNsfw.startsWith('http') ? rawNsfw : (originalUrlMap[rawNsfw] || null);
            if (remoteBase && !isLocal) externalBaseUrls.add(remoteBase);
            if (rawNsfw.startsWith('http')) {
                for (const v of detectedVariants) {
                    const fname = charOverrides[v] || `${cid}_${v}.png`;
                    addTask(fname, `${rawNsfw}/${fname}`, rawNsfw);
                }
            } else if (isLocal && diskFiles.size === 0 && remoteBase) {
                for (const v of detectedVariants) {
                    const fname = charOverrides[v] || `${cid}_${v}.png`;
                    addTask(fname, `${remoteBase}/${fname}`, remoteBase);
                }
            }
        }
        if (pregMatch) {
            const rawPreg = unescapeUrl(pregMatch[1]).replace(/\/+$/, '');
            const isLocal = rawPreg.includes(newLocalPrefix) || rawPreg.includes(legacyLocalPrefix);
            const remoteBase = rawPreg.startsWith('http') ? rawPreg : (originalUrlMap[rawPreg] || null);
            if (remoteBase && !isLocal) externalBaseUrls.add(remoteBase);
            if (rawPreg.startsWith('http')) {
                for (const cat of SFW_CATS) {
                    const fname = `${cid}_pregnant_${cat}.png`;
                    addTask(fname, `${rawPreg}/${fname}`, rawPreg);
                }
            } else if (isLocal && diskFiles.size === 0 && remoteBase) {
                for (const cat of SFW_CATS) {
                    const fname = `${cid}_pregnant_${cat}.png`;
                    addTask(fname, `${remoteBase}/${fname}`, remoteBase);
                }
            }
        }
    }

    // 2. baseUrlMap blocks - flexible key/quotes and escaped slashes
    const baseMapBlocks = [...textToScan.matchAll(/["']?baseUrlMap["']?\s*[:=]\s*\{([^}]+)\}/gi)];
    for (const bmb of baseMapBlocks) {
        const cleanContent = bmb[1].replace(/\\"/g, '"').replace(/\\'/g, "'");
        const entries = [...cleanContent.matchAll(/["']?([a-zA-Z0-9_\-]+)["']?\s*:\s*["']([^"']+)["']/g)];
        for (const e of entries) {
            const charCode = sanitizeFolderName(e[1]);
            const rawBase = unescapeUrl(e[2]).replace(/\/+$/, '');
            const isLocal = rawBase.includes(newLocalPrefix) || rawBase.includes(legacyLocalPrefix);
            const remoteBase = rawBase.startsWith('http') ? rawBase : (originalUrlMap[rawBase] || null);
            if (remoteBase && !isLocal) externalBaseUrls.add(remoteBase);
            if (rawBase.startsWith('http')) {
                for (const v of detectedVariants) {
                    const fname = `${charCode}_${v}.png`;
                    addTask(fname, `${rawBase}/${fname}`, rawBase);
                }
            } else if (isLocal && diskFiles.size === 0 && remoteBase) {
                for (const v of detectedVariants) {
                    const fname = `${charCode}_${v}.png`;
                    addTask(fname, `${remoteBase}/${fname}`, remoteBase);
                }
            }
        }
    }

    // 3. Catbox direct URLs (unescaped and escaped \/)
    const catboxMatches = [...new Set(textToScan.match(/https?(?::\/\/|:\\\/\\\/)(?:files\.)?catbox\.moe(?:\/|\\\/)[a-zA-Z0-9_\-\.]+\.(?:webp|png|jpg|jpeg|gif)/gi) || [])];
    for (const u of catboxMatches) {
        const cleanUrl = unescapeUrl(u);
        const fname = extractCleanFilename(cleanUrl, 'catbox_img');
        addTask(fname, cleanUrl);
    }

    // 4. GitHub Raw direct image URLs (unescaped and escaped \/, stripping query params)
    const ghRawMatches = [...new Set(textToScan.match(/https?(?::\/\/|:\\\/\\\/)raw\.githubusercontent\.com(?:\/|\\\/)[^\s"'`<>]+?\.(?:png|jpg|jpeg|webp|gif)(?:[?#][^\s"'`<>\\,]*)?/gi) || [])];
    for (const u of ghRawMatches) {
        const cleanUrl = unescapeUrl(u);
        const fname = extractCleanFilename(cleanUrl, 'gh_img');
        addTask(fname, cleanUrl);
    }

    // 5. Generic external image URLs
    const genericMatches = [...new Set(textToScan.match(/https?(?::\/\/|:\\\/\\\/)[^\s"'`<>]+?\.(?:png|jpg|jpeg|webp|gif)(?:[?#][^\s"'`<>\\,]*)?/gi) || [])];
    for (const u of genericMatches) {
        const cleanUrl = unescapeUrl(u);
        const lower = cleanUrl.toLowerCase();
        if (!lower.includes('catbox.moe') && !lower.includes('raw.githubusercontent.com') &&
            !lower.includes('github.com/') && !lower.includes('w3.org') &&
            !lower.includes('shields.io') && !lower.includes('schema.org')) {
            const fname = extractCleanFilename(cleanUrl, 'ext_img');
            addTask(fname, cleanUrl);
        }
    }

    // Scan direct references to local assets using safe string slicing (zero RegExp dynamic compilation risk)
    function scanDirectLocalRefs(prefix) {
        if (!prefix || !textToScan.includes(prefix)) return;
        let start = 0;
        while ((start = textToScan.indexOf(prefix, start)) !== -1) {
            const after = textToScan.slice(start + prefix.length);
            if (after.startsWith('/') || after.startsWith('\\/')) {
                const slashLen = after.startsWith('\\/') ? 2 : 1;
                const rest = after.slice(slashLen);
                const match = rest.match(/^[a-zA-Z0-9_\-\.]+\.(?:png|jpg|jpeg|webp|gif|mp3|ogg|wav)/i);
                if (match) {
                    const fname = match[0];
                    if (!diskFiles.has(fname) && !missingFiles.includes(fname)) {
                        missingFiles.push(fname);
                        const localRef = `${prefix}/${fname}`;
                        const originalRemote = originalUrlMap[localRef];
                        if (originalRemote) {
                            addTask(fname, originalRemote);
                        }
                    }
                }
            }
            start += prefix.length;
        }
    }
    scanDirectLocalRefs(newLocalPrefix);
    scanDirectLocalRefs(legacyLocalPrefix);

    // Immune to regex special characters in safeName and baseName (e.g. Alice (v2), [V3] Hero)
    const newLocalMatches = Math.max(0, textToScan.split(newLocalPrefix).length - 1);
    const legacyLocalMatches = Math.max(0, textToScan.split(legacyLocalPrefix).length - 1);
    const totalLocalMatches = newLocalMatches + legacyLocalMatches;

    const ghCount = Math.max(0, (textToScan.match(/https?(?::\/\/|:\\\/\\\/)raw\.githubusercontent\.com(?:\/|\\\/)[^\s"'`<>]+?\.(?:png|jpg|jpeg|webp|gif|svg|avif)/gi) || []).length);
    const cbCount = Math.max(0, (textToScan.match(/https?(?::\/\/|:\\\/\\\/)(?:files\.)?catbox\.moe(?:\/|\\\/)[^\s"'`<>]+?\.(?:png|jpg|jpeg|webp|gif)/gi) || []).length);
    const genericImgCount = Math.max(0, (textToScan.match(/https?(?::\/\/|:\\\/\\\/)[^\s"'`<>]+?\.(?:png|jpg|jpeg|webp|gif|svg|avif|mp3|ogg|wav)(?:[?#][^\s"'`<>\\,]*)?/gi) || []).filter(u => {
        const l = u.toLowerCase();
        return !l.includes('catbox.moe') && !l.includes('raw.githubusercontent.com') && !l.includes('w3.org') && !l.includes('shields.io') && !l.includes('schema.org');
    }).length);

    let unlocalizedBaseMatches = 0;
    for (const bUrl of externalBaseUrls) {
        if (textToScan.includes(bUrl)) {
            unlocalizedBaseMatches++;
        }
    }

    const totalExternalCount = Math.max(downloadTasks.length, ghCount + cbCount + genericImgCount + unlocalizedBaseMatches);

    if (downloadTasks.length > 0) {
        for (const t of downloadTasks) {
            if (!diskFiles.has(t.filename) && !missingFiles.includes(t.filename)) {
                missingFiles.push(t.filename);
            }
        }
    }

    const bakPath = `${cardPath}.bak`;
    const hasBakFile = fs.existsSync(bakPath);

    let hasRevertBackup = hasBakFile;
    let originalUrlsCount = 0;
    try {
        const parsedJson = JSON.parse(decoded);
        const target = parsedJson.data || parsedJson;
        const backupUrls = target.extensions?.st_asset_localizer?.original_urls;
        if (backupUrls && typeof backupUrls === 'object' && Object.keys(backupUrls).length > 0) {
            hasRevertBackup = true;
            originalUrlsCount = Object.keys(backupUrls).length;
        }
    } catch {}

    const dirStats = getDirStats(fs.existsSync(assetDir) ? assetDir : legacyDir);
    const hasLocalAssets = totalLocalMatches > 0 || dirStats.count > 0;
    const isFullyLocalized = totalExternalCount === 0 && downloadTasks.length === 0 && missingFiles.length === 0 && hasLocalAssets;

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
        missingFiles: missingFiles.slice(0, 50),
        diskSizeFormatted: dirStats.sizeFormatted,
        diskSizeBytes: dirStats.sizeBytes,
        isFullyLocalized,
        hasRevertBackup,
        hasBakFile,
        originalUrlsCount,
        downloadTasks,
        externalBaseUrls: Array.from(externalBaseUrls)
    };
}

export function scanAllCards() {
    if (!fs.existsSync(CHARACTERS_DIR)) return [];
    const files = findPngFilesRecursively(CHARACTERS_DIR, CHARACTERS_DIR);
    return files.map(f => scanCard(f)).filter(c => !c.error);
}
