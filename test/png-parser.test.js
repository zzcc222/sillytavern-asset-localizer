import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { readPngTextChunks, writePngTextChunk } from '../src/png-parser.js';

// Minimal 1x1 red PNG buffer
function createMinimalPng() {
    const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

    // IHDR
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(1, 0); // width 1
    ihdrData.writeUInt32BE(1, 4); // height 1
    ihdrData[8] = 8; // bit depth
    ihdrData[9] = 2; // color type RGB
    ihdrData[10] = 0; // compression
    ihdrData[11] = 0; // filter
    ihdrData[12] = 0; // interlace
    const ihdrLen = Buffer.alloc(4); ihdrLen.writeUInt32BE(13, 0);
    const ihdrType = Buffer.from('IHDR', 'ascii');
    const ihdrCrc = Buffer.alloc(4); // minimal mock CRC or computed
    ihdrCrc.writeUInt32BE(0x5773B4DE, 0);
    const ihdr = Buffer.concat([ihdrLen, ihdrType, ihdrData, ihdrCrc]);

    // IDAT
    const rawPixels = Buffer.from([0, 255, 0, 0]); // filter byte + RGB
    const compressed = zlib.deflateSync(rawPixels);
    const idatLen = Buffer.alloc(4); idatLen.writeUInt32BE(compressed.length, 0);
    const idatType = Buffer.from('IDAT', 'ascii');
    const idatCrc = Buffer.alloc(4); idatCrc.writeUInt32BE(0x12345678, 0);
    const idat = Buffer.concat([idatLen, idatType, compressed, idatCrc]);

    // IEND
    const iend = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);

    return Buffer.concat([header, ihdr, idat, iend]);
}

test('png-parser: write and read tEXt chunk', () => {
    const png = createMinimalPng();
    const payload = JSON.stringify({ name: 'Alice', version: '2.0' });
    const modified = writePngTextChunk(png, 'chara', payload);

    assert.ok(modified.length > png.length);
    const chunks = readPngTextChunks(modified);
    assert.equal(chunks.chara, payload);
});

test('png-parser: writePngTextChunk replaces existing chunk without duplicating', () => {
    const png = createMinimalPng();
    const payload1 = JSON.stringify({ name: 'OldAlice' });
    const step1 = writePngTextChunk(png, 'chara', payload1);

    const payload2 = JSON.stringify({ name: 'NewAlice' });
    const step2 = writePngTextChunk(step1, 'chara', payload2);

    const chunks = readPngTextChunks(step2);
    assert.equal(chunks.chara, payload2);

    // Verify 'chara' only appears once
    let count = 0;
    let offset = 8;
    while (offset < step2.length) {
        if (offset + 8 > step2.length) break;
        const length = step2.readUInt32BE(offset);
        const type = step2.toString('ascii', offset + 4, offset + 8);
        if (type === 'tEXt') {
            const data = step2.slice(offset + 8, offset + 8 + length);
            const nullIdx = data.indexOf(0);
            if (nullIdx !== -1 && data.slice(0, nullIdx).toString('ascii') === 'chara') {
                count++;
            }
        }
        offset += 12 + length;
        if (type === 'IEND') break;
    }
    assert.equal(count, 1);
});

test('png-parser: read zTXt compressed chunk', () => {
    const png = createMinimalPng();
    const keyword = 'chara';
    const text = JSON.stringify({ type: 'zTXt_card', data: 'hello' });
    const keyBuf = Buffer.from(keyword, 'ascii');
    const nullByte = Buffer.from([0]);
    const compMethod = Buffer.from([0]); // deflate
    const compressed = zlib.deflateSync(Buffer.from(text, 'utf-8'));
    const chunkData = Buffer.concat([keyBuf, nullByte, compMethod, compressed]);

    const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32BE(chunkData.length, 0);
    const typeBuf = Buffer.from('zTXt', 'ascii');
    const crcBuf = Buffer.alloc(4);
    const ztxtChunk = Buffer.concat([lenBuf, typeBuf, chunkData, crcBuf]);

    // Insert before IEND
    const iendIdx = png.lastIndexOf(Buffer.from('IEND'));
    const rawZtxtPng = Buffer.concat([png.slice(0, iendIdx - 4), ztxtChunk, png.slice(iendIdx - 4)]);

    const chunks = readPngTextChunks(rawZtxtPng);
    assert.equal(chunks.chara, text);

    // Verify writePngTextChunk replaces the zTXt chunk cleanly
    const replaced = writePngTextChunk(rawZtxtPng, 'chara', 'replaced_text');
    const replacedChunks = readPngTextChunks(replaced);
    assert.equal(replacedChunks.chara, 'replaced_text');
});
