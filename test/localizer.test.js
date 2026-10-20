import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { replaceUrlVariants, localizeCard, revertCard, cleanOrphans, getCardDetail, loadConfig, saveConfig } from '../src/localizer.js';
import { writePngTextChunk, readPngTextChunks } from '../src/png-parser.js';
import { scanCard } from '../src/scanner.js';
import { PLUGIN_ID, ASSETS_DIR, CHARACTERS_DIR } from '../src/constants.js';

function createMockCardPng(cardJsonString) {
    const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(1, 0); ihdrData.writeUInt32BE(1, 4);
    ihdrData[8] = 8; ihdrData[9] = 2;
    const ihdrLen = Buffer.alloc(4); ihdrLen.writeUInt32BE(13, 0);
    const ihdr = Buffer.concat([ihdrLen, Buffer.from('IHDR', 'ascii'), ihdrData, Buffer.alloc(4)]);

    const rawPixels = Buffer.from([0, 255, 0, 0]);
    const compressed = zlib.deflateSync(rawPixels);
    const idatLen = Buffer.alloc(4); idatLen.writeUInt32BE(compressed.length, 0);
    const idat = Buffer.concat([idatLen, Buffer.from('IDAT', 'ascii'), compressed, Buffer.alloc(4)]);

    const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
    const basePng = Buffer.concat([header, ihdr, idat, iend]);

    const b64 = Buffer.from(cardJsonString, 'utf-8').toString('base64');
    return writePngTextChunk(basePng, 'chara', b64);
}

test('localizer: replaceUrlVariants replaces both direct and JSON-escaped URLs', () => {
    const originalText = 'URL1: https://files.catbox.moe/a.png; URL2: https:\\/\\/files.catbox.moe\\/b.png';
    const targetUrl = 'https://files.catbox.moe/';
    const localPrefix = '/api/plugins/st-asset-localizer/assets/Alice/';

    const replaced = replaceUrlVariants(originalText, targetUrl, localPrefix);
    assert.equal(
        replaced,
        'URL1: /api/plugins/st-asset-localizer/assets/Alice/a.png; URL2: /api/plugins/st-asset-localizer/assets/Alice/b.png'
    );
});

test('localizer: replaceUrlVariants normalizes trailing slashes safely', () => {
    const text = 'base: "https://raw.githubusercontent.com/user/repo/main/sfw"';
    const replaced = replaceUrlVariants(text, 'https://raw.githubusercontent.com/user/repo/main/sfw/', '/api/assets/safe');
    assert.equal(replaced, 'base: "/api/assets/safe"');
});

test('localizer: localizeCard replaces remote links and generates closed-loop local assets', async () => {
    // Setup a temporary workspace
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-localizer-test-'));
    const mockCardName = 'Alice_Hero [V2].png';
    const cardPath = path.join(tmpDir, mockCardName);

    const initialCardJson = {
        name: 'Alice_Hero [V2]',
        description: 'baseUrlMap = { hero: "https://files.catbox.moe/pool" }; raw: https://raw.githubusercontent.com/user/repo/main/portrait.png',
        mes_example: `{ "sfwBase": "https://raw.githubusercontent.com/user/repo/main/alice/sfw", "id": "alice" }`
    };

    const initialPng = createMockCardPng(JSON.stringify(initialCardJson));
    fs.writeFileSync(cardPath, initialPng);

    // Scan initial card
    const preScan = scanCard(cardPath);
    assert.ok(preScan.totalTasks > 0, 'Should have download tasks');
    assert.equal(preScan.isFullyLocalized, false, 'Initially not fully localized');

    // Mock global fetch to return minimal valid PNGs for all tasks
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            arrayBuffer: async () => Uint8Array.from(initialPng).buffer
        };
    };

    try {
        const result = await localizeCard(cardPath);
        assert.ok(result.success);
        assert.equal(result.safeName, 'Alice_Hero [V2]');

        // Verify backup was created
        assert.ok(fs.existsSync(`${cardPath}.bak`), '.bak file must be created');

        // Verify modified PNG file
        const modifiedBuf = fs.readFileSync(cardPath);
        const chunks = readPngTextChunks(modifiedBuf);
        const decoded = Buffer.from(chunks.chara, 'base64').toString('utf-8');
        const parsed = JSON.parse(decoded);

        // Verify metadata tag was added
        assert.ok(parsed.data?.extensions?.st_asset_localizer?.localized_at);
        assert.ok(parsed.data?.extensions?.st_asset_localizer?.original_urls);

        // Verify active fields no longer contain external URLs
        assert.ok(!parsed.description.includes('https://raw.githubusercontent.com'), 'No GitHub Raw URLs remain in description');
        assert.ok(!parsed.mes_example.includes('https://raw.githubusercontent.com'), 'No GitHub Raw URLs remain in mes_example');
        assert.ok(!parsed.description.includes('https://files.catbox.moe'), 'No Catbox URLs remain in description');
        assert.ok(!parsed.mes_example.includes('https://files.catbox.moe'), 'No Catbox URLs remain in mes_example');
        assert.ok(parsed.description.includes(`/api/plugins/${PLUGIN_ID}/assets/Alice_Hero [V2]`), 'Local Express route used in description');
        assert.ok(parsed.mes_example.includes(`/api/plugins/${PLUGIN_ID}/assets/Alice_Hero [V2]`), 'Local Express route used in mes_example');

        // Re-scan card
        const postScan = scanCard(cardPath);
        assert.equal(postScan.totalExternalCount, 0, 'Total external count is 0');
        assert.equal(postScan.isFullyLocalized, true, 'Card is fully localized');
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        try {
            const assetDir = path.join(ASSETS_DIR, 'Alice_Hero [V2]');
            if (fs.existsSync(assetDir)) fs.rmSync(assetDir, { recursive: true, force: true });
        } catch {}
    }
});

test('localizer: config save and load roundtrip and partial merge', () => {
    const testConfig = {
        ghAccelerator: 'https://custom-proxy.org/',
        httpProxy: 'http://127.0.0.1:8080',
        concurrency: 12,
        autoPromptOnImport: false
    };

    saveConfig(testConfig);
    const loaded = loadConfig();
    assert.equal(loaded.ghAccelerator, 'https://custom-proxy.org/');
    assert.equal(loaded.httpProxy, 'http://127.0.0.1:8080');
    assert.equal(loaded.concurrency, 12);
    assert.equal(loaded.autoPromptOnImport, false);

    // Partial update should NOT wipe existing fields
    saveConfig({ concurrency: 18 });
    const updated = loadConfig();
    assert.equal(updated.concurrency, 18);
    assert.equal(updated.ghAccelerator, 'https://custom-proxy.org/');
    assert.equal(updated.httpProxy, 'http://127.0.0.1:8080');
});

test('localizer: replaceUrlVariants strips escaped trailing slashes without leaving stray characters', () => {
    const input = 'base: "https:\\/\\/example.com\\/alice\\/"';
    const replaced = replaceUrlVariants(input, 'https://example.com/alice', '/api/assets/alice');
    assert.equal(replaced, 'base: "/api/assets/alice"');
});

test('localizer: revertCard restores card from .bak backup file', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-revert-bak-test-'));
    const mockCardName = 'Revertable.png';
    const cardPath = path.join(tmpDir, mockCardName);

    const initialCardJson = {
        name: 'Revertable',
        description: 'avatar: https://files.catbox.moe/revert.png'
    };

    const initialPng = createMockCardPng(JSON.stringify(initialCardJson));
    fs.writeFileSync(cardPath, initialPng);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => Uint8Array.from(initialPng).buffer
    });

    try {
        await localizeCard(cardPath);
        assert.ok(fs.existsSync(`${cardPath}.bak`), '.bak must exist after localize');

        // Verify card is now localized
        const midScan = scanCard(cardPath);
        assert.equal(midScan.totalExternalCount, 0);

        // Perform revert
        const revertResult = revertCard(cardPath);
        assert.ok(revertResult.success);
        assert.equal(revertResult.method, 'bak_file');

        // Re-scan card
        const postRevertScan = scanCard(cardPath);
        assert.equal(postRevertScan.totalExternalCount, 1, 'External URL should be restored');
        assert.equal(postRevertScan.isFullyLocalized, false);
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        try {
            const assetDir = path.join(ASSETS_DIR, 'Revertable');
            if (fs.existsSync(assetDir)) fs.rmSync(assetDir, { recursive: true, force: true });
        } catch {}
    }
});

test('localizer: revertCard restores original URLs from embedded metadata when .bak is removed', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-revert-meta-test-'));
    const mockCardName = 'MetaRevert.png';
    const cardPath = path.join(tmpDir, mockCardName);

    const initialCardJson = {
        name: 'MetaRevert',
        description: 'direct: https://files.catbox.moe/test_meta.png'
    };

    const initialPng = createMockCardPng(JSON.stringify(initialCardJson));
    fs.writeFileSync(cardPath, initialPng);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => Uint8Array.from(initialPng).buffer
    });

    try {
        await localizeCard(cardPath);
        const bakPath = `${cardPath}.bak`;
        if (fs.existsSync(bakPath)) fs.unlinkSync(bakPath); // Force no .bak on disk

        const revertResult = revertCard(cardPath);
        assert.ok(revertResult.success);
        assert.equal(revertResult.method, 'original_urls_reversion');

        const postRevertScan = scanCard(cardPath);
        assert.equal(postRevertScan.totalExternalCount, 1, 'External URL should be restored via original_urls');
        assert.equal(postRevertScan.isFullyLocalized, false);
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        try {
            const assetDir = path.join(ASSETS_DIR, 'MetaRevert');
            if (fs.existsSync(assetDir)) fs.rmSync(assetDir, { recursive: true, force: true });
        } catch {}
    }
});

test('localizer: localizeCard updates both chara and ccv3 chunks on V3 cards', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-v3-dual-'));
    const cardPath = path.join(tmpDir, 'DualChunk.png');

    const v2Payload = JSON.stringify({ name: 'DualV2', description: 'https://files.catbox.moe/v2.png' });
    const v3Payload = JSON.stringify({ spec: 'chara_card_v3', data: { name: 'DualV3', description: 'https://files.catbox.moe/v3.png' } });

    const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
    let png = Buffer.concat([header, iend]);
    png = writePngTextChunk(png, 'chara', Buffer.from(v2Payload).toString('base64'));
    png = writePngTextChunk(png, 'ccv3', Buffer.from(v3Payload).toString('base64'));
    fs.writeFileSync(cardPath, png);

    const originalFetch = globalThis.fetch;
    const dummyImage = Buffer.alloc(100);
    dummyImage[0] = 0x89; dummyImage[1] = 0x50; dummyImage[2] = 0x4E; dummyImage[3] = 0x47;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from(dummyImage).buffer
    });

    try {
        await localizeCard(cardPath);
        const updatedBuf = fs.readFileSync(cardPath);
        const chunks = readPngTextChunks(updatedBuf);

        const decodedChara = Buffer.from(chunks.chara, 'base64').toString('utf-8');
        const decodedCcv3 = Buffer.from(chunks.ccv3, 'base64').toString('utf-8');

        const parsedChara = JSON.parse(decodedChara);
        const parsedCcv3 = JSON.parse(decodedCcv3);

        assert.ok(!parsedChara.description.includes('https://files.catbox.moe/'), 'v2 chara chunk description must not contain remote URLs');
        assert.ok(!parsedCcv3.data.description.includes('https://files.catbox.moe/'), 'v3 ccv3 chunk description must not contain remote URLs');
        assert.ok(parsedChara.description.includes('/api/plugins/st-asset-localizer/assets/DualChunk'), 'v2 chara chunk points to local assets');
        assert.ok(parsedCcv3.data.description.includes('/api/plugins/st-asset-localizer/assets/DualChunk'), 'v3 ccv3 chunk points to local assets');

        // Verify scan detects full localization across both chunks
        const postScan = scanCard(cardPath);
        assert.equal(postScan.isFullyLocalized, true, 'Dual-chunk card is fully localized');
        assert.equal(postScan.totalExternalCount, 0, 'No external URLs remain');

        // Verify original_urls captured tasks from both V2 and V3 chunks
        const backupUrls = parsedCcv3.data?.extensions?.st_asset_localizer?.original_urls || {};
        assert.ok(backupUrls['https://files.catbox.moe/v2.png'], 'v2 URL captured in original_urls');
        assert.ok(backupUrls['https://files.catbox.moe/v3.png'], 'v3 URL captured in original_urls');

        // Test reverting dual-chunk card without .bak backup
        fs.unlinkSync(`${cardPath}.bak`);
        const revertResult = revertCard(cardPath);
        assert.ok(revertResult.success);
        assert.equal(revertResult.method, 'original_urls_reversion');

        const revertedBuf = fs.readFileSync(cardPath);
        const revertedChunks = readPngTextChunks(revertedBuf);
        const revertedChara = JSON.parse(Buffer.from(revertedChunks.chara, 'base64').toString('utf-8'));
        const revertedCcv3 = JSON.parse(Buffer.from(revertedChunks.ccv3, 'base64').toString('utf-8'));

        assert.equal(revertedChara.description, 'https://files.catbox.moe/v2.png');
        assert.equal(revertedCcv3.data.description, 'https://files.catbox.moe/v3.png');
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        try {
            const assetDir = path.join(ASSETS_DIR, 'DualChunk');
            if (fs.existsSync(assetDir)) fs.rmSync(assetDir, { recursive: true, force: true });
        } catch {}
    }
});

test('localizer: getCardDetail returns correct inventory and file list', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-detail-test-'));
    const cardPath = path.join(tmpDir, 'DetailCard.png');
    const mockCard = createMockCardPng(JSON.stringify({ name: 'DetailCard', description: 'Testing detail' }));
    fs.writeFileSync(cardPath, mockCard);

    const assetDir = path.join(ASSETS_DIR, 'DetailCard');
    fs.mkdirSync(assetDir, { recursive: true });
    fs.writeFileSync(path.join(assetDir, 'pic1.png'), Buffer.alloc(1024));

    try {
        const detail = getCardDetail(cardPath);
        assert.equal(detail.baseName, 'DetailCard');
        assert.equal(detail.safeName, 'DetailCard');
        assert.equal(detail.diskCount, 1);
        assert.equal(detail.files.length, 1);
        assert.equal(detail.files[0].filename, 'pic1.png');
        assert.equal(detail.files[0].sizeBytes, 1024);
        assert.ok(detail.files[0].localUrl.includes('/api/plugins/st-asset-localizer/assets/DetailCard/pic1.png'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        try { fs.rmSync(assetDir, { recursive: true, force: true }); } catch {}
    }
});

test('localizer: cleanOrphans guards when no cards exist and deletes unreferenced folders', () => {
    // When characters dir has no cards, cleanOrphans should do nothing (safety guard)
    const emptyResult = cleanOrphans();
    assert.equal(emptyResult.count, 0);

    // Create a mock active card in CHARACTERS_DIR
    const charsDir = CHARACTERS_DIR;
    fs.mkdirSync(charsDir, { recursive: true });
    const activeCardName = 'ActiveSurvivor.png';
    const activeCardPath = path.join(charsDir, activeCardName);
    const mockCard = createMockCardPng(JSON.stringify({ name: 'ActiveSurvivor', description: 'desc' }));
    fs.writeFileSync(activeCardPath, mockCard);

    // Create both an active asset folder and an orphan asset folder in ASSETS_DIR
    const activeAssetDir = path.join(ASSETS_DIR, 'ActiveSurvivor');
    const orphanAssetDir = path.join(ASSETS_DIR, 'OrphanedToDelete');
    fs.mkdirSync(activeAssetDir, { recursive: true });
    fs.mkdirSync(orphanAssetDir, { recursive: true });

    try {
        const cleanResult = cleanOrphans();
        assert.ok(cleanResult.deleted.includes('OrphanedToDelete'), 'Orphaned folder must be deleted');
        assert.ok(!cleanResult.deleted.includes('ActiveSurvivor'), 'Active card folder must NOT be deleted');
        assert.ok(!fs.existsSync(orphanAssetDir), 'Orphan folder no longer exists on disk');
        assert.ok(fs.existsSync(activeAssetDir), 'Active folder still exists on disk');
    } finally {
        try { fs.rmSync(activeCardPath, { force: true }); } catch {}
        try { fs.rmSync(activeAssetDir, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(orphanAssetDir, { recursive: true, force: true }); } catch {}
    }
});

test('localizer: replaceUrlVariants preserves subpath slashes while stripping trailing slashes before delimiters', () => {
    const directText = 'Direct: https://example.com/alice/img.png';
    const escapedText = 'Escaped: https:\\/\\/example.com\\/alice\\/img.png';
    const from = 'https://example.com/alice';
    const to = '/api/assets/alice';

    const rDirect = replaceUrlVariants(directText, from, to);
    assert.equal(rDirect, 'Direct: /api/assets/alice/img.png', 'Direct subpath must retain slash');

    const rEscaped = replaceUrlVariants(escapedText, from, to);
    assert.equal(rEscaped, 'Escaped: /api/assets/alice/img.png', 'Escaped subpath must retain slash');

    const rTrailingSlashInQuote = replaceUrlVariants('base: "https://example.com/alice/"', from, to);
    assert.equal(rTrailingSlashInQuote, 'base: "/api/assets/alice"', 'Trailing slash before quote must be cleanly stripped');
});

test('localizer: localizeCard prioritizes specific task URLs before base URL prefixes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-priority-test-'));
    const cardPath = path.join(tmpDir, 'PriorityCard.png');

    // Here a specific task has a custom renamed filename 'special_pose_2.png'
    const initialCardJson = {
        name: 'PriorityCard',
        description: 'Check: https://raw.githubusercontent.com/user/repo/main/alice/special_pose.png',
        mes_example: '{ "sfwBase": "https://raw.githubusercontent.com/user/repo/main/alice" }'
    };

    const initialPng = createMockCardPng(JSON.stringify(initialCardJson));
    fs.writeFileSync(cardPath, initialPng);

    const originalFetch = globalThis.fetch;
    const dummyImage = Buffer.alloc(100);
    dummyImage[0] = 0x89; dummyImage[1] = 0x50; dummyImage[2] = 0x4E; dummyImage[3] = 0x47;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => Uint8Array.from(dummyImage).buffer
    });

    try {
        await localizeCard(cardPath);
        const modifiedBuf = fs.readFileSync(cardPath);
        const chunks = readPngTextChunks(modifiedBuf);
        const parsed = JSON.parse(Buffer.from(chunks.chara, 'base64').toString('utf-8'));

        assert.ok(parsed.description.includes('/api/plugins/st-asset-localizer/assets/PriorityCard/special_pose.png'));
        assert.ok(parsed.mes_example.includes('/api/plugins/st-asset-localizer/assets/PriorityCard'));
        assert.ok(!parsed.description.includes('https://raw.githubusercontent.com'));
        assert.ok(!parsed.mes_example.includes('https://raw.githubusercontent.com'));
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
        try {
            const assetDir = path.join(ASSETS_DIR, 'PriorityCard');
            if (fs.existsSync(assetDir)) fs.rmSync(assetDir, { recursive: true, force: true });
        } catch {}
    }
});

