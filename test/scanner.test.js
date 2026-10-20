import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { scanCard, parseCardData, getCardBaseName, extractCleanFilename, unescapeUrl, extractCardVariants } from '../src/scanner.js';
import { writePngTextChunk } from '../src/png-parser.js';

function createMockCardPng(cardJsonString) {
    const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    // IHDR
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(1, 0); ihdrData.writeUInt32BE(1, 4);
    ihdrData[8] = 8; ihdrData[9] = 2;
    const ihdrLen = Buffer.alloc(4); ihdrLen.writeUInt32BE(13, 0);
    const ihdr = Buffer.concat([ihdrLen, Buffer.from('IHDR', 'ascii'), ihdrData, Buffer.alloc(4)]);

    // IDAT
    const rawPixels = Buffer.from([0, 255, 0, 0]);
    const compressed = zlib.deflateSync(rawPixels);
    const idatLen = Buffer.alloc(4); idatLen.writeUInt32BE(compressed.length, 0);
    const idat = Buffer.concat([idatLen, Buffer.from('IDAT', 'ascii'), compressed, Buffer.alloc(4)]);

    // IEND
    const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
    const basePng = Buffer.concat([header, ihdr, idat, iend]);

    // Encode JSON payload in base64 as SillyTavern does
    const b64 = Buffer.from(cardJsonString, 'utf-8').toString('base64');
    return writePngTextChunk(basePng, 'chara', b64);
}

test('scanner: getCardBaseName handles diverse extensions and paths', () => {
    assert.equal(getCardBaseName('Alice.png'), 'Alice');
    assert.equal(getCardBaseName('Alice.PNG'), 'Alice');
    assert.equal(getCardBaseName('folder/Alice.png'), 'Alice');
    assert.equal(getCardBaseName('folder\\Bob.png'), 'Bob');
});

test('scanner: extractCleanFilename and unescapeUrl handle clean extraction', () => {
    assert.equal(unescapeUrl('https:\\/\\/files.catbox.moe\\/abc.png'), 'https://files.catbox.moe/abc.png');
    assert.equal(extractCleanFilename('https://files.catbox.moe/abc.png'), 'abc.png');
    assert.equal(extractCleanFilename('https://raw.githubusercontent.com/user/repo/main/hero.png?raw=true#section'), 'hero.png');
    assert.equal(extractCleanFilename('https:\\/\\/raw.githubusercontent.com\\/user\\/repo\\/main\\/avatar.webp'), 'avatar.webp');
});

test('scanner: does NOT throw SyntaxError on card names with unclosed regex characters', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-scanner-'));
    try {
        const problematicNames = [
            'Alice (v2.png',
            '[Hero] V3.png',
            'Card+Plus^$()[]{}.png'
        ];

        for (const name of problematicNames) {
            const cardJson = JSON.stringify({
                name: 'TestCard',
                description: 'A test character'
            });
            const pngBuf = createMockCardPng(cardJson);
            const cardFilePath = path.join(tmpDir, name);
            fs.writeFileSync(cardFilePath, pngBuf);

            assert.doesNotThrow(() => {
                const res = scanCard(cardFilePath);
                assert.ok(res);
                assert.equal(res.baseName, getCardBaseName(name));
                assert.ok(typeof res.localAssetRefMatches === 'number');
            }, `Should not crash on filename: ${name}`);
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanner: detects charactersData with arbitrary property order, double quotes, and missing pregBase', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-char-'));
    try {
        // Notice nsfwBase comes BEFORE id, quotes are double quotes, and pregBase is omitted!
        const cardData = {
            name: 'ComplexCard',
            description: `Some dialogue.
            {
                "nsfwBase": "https://raw.githubusercontent.com/user/repo/main/alice/nsfw",
                "id": "alice",
                "sfwBase": "https://raw.githubusercontent.com/user/repo/main/alice/sfw"
            }
            And more text.`
        };

        const pngBuf = createMockCardPng(JSON.stringify(cardData));
        const cardPath = path.join(tmpDir, 'ComplexCard.png');
        fs.writeFileSync(cardPath, pngBuf);

        const res = scanCard(cardPath);
        assert.ok(res);
        assert.ok(res.downloadTasks.length > 0, 'Should find tasks');
        assert.ok(res.downloadTasks.some(t => t.filename.includes('alice_uniform_calm.png')), 'SFW task generated');
        assert.ok(res.downloadTasks.some(t => t.filename.includes('alice_sex.png')), 'NSFW task generated');
        assert.ok(res.externalBaseUrls.includes('https://raw.githubusercontent.com/user/repo/main/alice/sfw'));
        assert.ok(res.externalBaseUrls.includes('https://raw.githubusercontent.com/user/repo/main/alice/nsfw'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanner: detects JSON-escaped slashes (\\/) in Catbox and baseUrlMap', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-escaped-'));
    try {
        // Simulate JSON that contains escaped solidus: https:\/\/...
        const rawJsonString = `{"name":"EscapedCard","description":"baseUrlMap = { hero: 'https:\\/\\/files.catbox.moe\\/hero_pool' }; catbox: https:\\/\\/files.catbox.moe\\/sample123.webp"}`;

        const pngBuf = createMockCardPng(rawJsonString);
        const cardPath = path.join(tmpDir, 'EscapedCard.png');
        fs.writeFileSync(cardPath, pngBuf);

        const res = scanCard(cardPath);
        assert.ok(res);
        assert.ok(res.downloadTasks.length > 0, 'Should parse tasks from escaped strings');
        assert.ok(res.downloadTasks.some(t => t.filename === 'sample123.webp'), 'Catbox webp found');
        assert.ok(res.downloadTasks.some(t => t.filename.includes('hero_sex.png')), 'baseUrlMap tasks generated');
        assert.ok(res.downloadTasks.every(t => !t.url.includes('\\/')), 'All task URLs should have unescaped slashes');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanner: handles duplicate filenames from different URLs gracefully', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-dup-'));
    try {
        const rawJsonString = JSON.stringify({
            name: 'DupCard',
            description: 'Image 1: https://domain-a.com/avatar.png, Image 2: https://domain-b.com/avatar.png'
        });

        const pngBuf = createMockCardPng(rawJsonString);
        const cardPath = path.join(tmpDir, 'DupCard.png');
        fs.writeFileSync(cardPath, pngBuf);

        const res = scanCard(cardPath);
        assert.equal(res.downloadTasks.length, 2, 'Both tasks should be registered');
        const filenames = res.downloadTasks.map(t => t.filename);
        assert.ok(filenames.includes('avatar.png'));
        assert.ok(filenames.includes('avatar_2.png'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanner: scanCard extracts tasks from both chara and ccv3 chunks in dual-chunk cards', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-dual-chunk-'));
    try {
        const v2Payload = JSON.stringify({ name: 'DualScan', description: 'https://files.catbox.moe/v2_only.png' });
        const v3Payload = JSON.stringify({ spec: 'chara_card_v3', data: { name: 'DualScan', description: 'https://files.catbox.moe/v3_only.png' } });

        const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
        const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);
        let png = Buffer.concat([header, iend]);
        png = writePngTextChunk(png, 'chara', Buffer.from(v2Payload).toString('base64'));
        png = writePngTextChunk(png, 'ccv3', Buffer.from(v3Payload).toString('base64'));

        const cardPath = path.join(tmpDir, 'DualScan.png');
        fs.writeFileSync(cardPath, png);

        const res = scanCard(cardPath);
        assert.ok(res);
        assert.equal(res.downloadTasks.length, 2, 'Must detect tasks from both chunks');
        assert.ok(res.downloadTasks.some(t => t.filename === 'v2_only.png'), 'v2 task detected');
        assert.ok(res.downloadTasks.some(t => t.filename === 'v3_only.png'), 'v3 task detected');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanner: scanCard accurately ignores non-image author links (discord, github repo) without false positives', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-author-links-'));
    try {
        const cardData = {
            name: 'AuthorLinksCard',
            description: 'Join community at https://discord.gg/coolbot or visit https://github.com/coolauthor/repo or https://patreon.com/artist. Image: https://files.catbox.moe/author_avatar.png'
        };

        const pngBuf = createMockCardPng(JSON.stringify(cardData));
        const cardPath = path.join(tmpDir, 'AuthorLinksCard.png');
        fs.writeFileSync(cardPath, pngBuf);

        const res = scanCard(cardPath);
        assert.ok(res);
        assert.equal(res.downloadTasks.length, 1, 'Only the image task should be queued');
        assert.equal(res.downloadTasks[0].filename, 'author_avatar.png');
        assert.equal(res.totalExternalCount, 1, 'Only actual image external links should be counted, not Discord or GitHub web repos');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('scanner: extractCardVariants correctly extracts custom variant values', () => {
    const script = `
        const variants = {
            '乳头调教': 'nipple_training',
            '口交': 'blowjob',
            '性交': 'sex',
            '阴部自拍': 'vulva_selfie'
        };
    `;
    const vars = extractCardVariants(script);
    assert.deepEqual(vars, ['nipple_training', 'blowjob', 'sex', 'vulva_selfie']);
});

test('scanner: scanCard honors custom variants and character overrides without phantom tasks', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-test-custom-vars-'));
    try {
        const cardData = {
            name: 'CustomVarCard',
            description: `
                const variants = {
                    '乳头调教': 'nipple_training',
                    '口交': 'blowjob'
                };
                charactersData = [{
                    id: 'heroine',
                    sfwBase: 'https://raw.githubusercontent.com/user/repo/main/heroine/sfw',
                    nsfwBase: 'https://raw.githubusercontent.com/user/repo/main/heroine/nsfw',
                    overrides: {
                        'blowjob': '/card_assets/CustomVarCard/heroine_special_bj.png'
                    }
                }];
            `
        };

        const pngBuf = createMockCardPng(JSON.stringify(cardData));
        const cardPath = path.join(tmpDir, 'CustomVarCard.png');
        fs.writeFileSync(cardPath, pngBuf);

        const res = scanCard(cardPath);
        assert.ok(res);
        // Custom variants only has 2 variants: nipple_training and blowjob
        // blowjob is overridden to heroine_special_bj.png
        assert.ok(res.downloadTasks.some(t => t.filename === 'heroine_nipple_training.png'), 'nipple_training generated');
        assert.ok(res.downloadTasks.some(t => t.filename === 'heroine_special_bj.png'), 'override filename used');
        // Standard non-existent variants (e.g. sex, anal, indoor_selfie) MUST NOT be generated
        assert.ok(!res.downloadTasks.some(t => t.filename === 'heroine_sex.png'), 'Non-existent variant not generated');
        assert.ok(!res.downloadTasks.some(t => t.filename === 'heroine_indoor_selfie.png'), 'Non-existent variant not generated');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});



