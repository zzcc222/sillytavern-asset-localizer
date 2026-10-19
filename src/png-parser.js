/**
 * Low-level PNG text chunk parser and writer
 */
export function readPngTextChunks(buffer) {
    const chunks = {};
    if (buffer.length < 8) return chunks;
    let offset = 8;
    while (offset < buffer.length) {
        if (offset + 8 > buffer.length) break;
        const length = buffer.readUInt32BE(offset);
        const type = buffer.toString('ascii', offset + 4, offset + 8);
        if (type === 'tEXt') {
            const data = buffer.slice(offset + 8, offset + 8 + length);
            const nullIdx = data.indexOf(0);
            if (nullIdx !== -1) {
                const keyword = data.slice(0, nullIdx).toString('ascii');
                const text = data.slice(nullIdx + 1).toString('utf-8');
                chunks[keyword] = text;
            }
        }
        offset += 12 + length;
        if (type === 'IEND') break;
    }
    return chunks;
}

function crc32(buf) {
    let crc = 0 ^ (-1);
    for (let i = 0; i < buf.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
}

const crcTable = (() => {
    let c;
    const table = [];
    for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) {
            c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
        }
        table[n] = c;
    }
    return table;
})();

export function writePngTextChunk(originalBuffer, keyword, text) {
    const keywordBuf = Buffer.from(keyword, 'ascii');
    const nullByte = Buffer.from([0]);
    const textBuf = Buffer.from(text, 'utf-8');
    const chunkData = Buffer.concat([keywordBuf, nullByte, textBuf]);
    const lengthBuf = Buffer.alloc(4);
    lengthBuf.writeUInt32BE(chunkData.length, 0);
    const typeBuf = Buffer.from('tEXt', 'ascii');
    const crcVal = crc32(Buffer.concat([typeBuf, chunkData]));
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crcVal, 0);
    const newChunk = Buffer.concat([lengthBuf, typeBuf, chunkData, crcBuf]);

    const parts = [originalBuffer.slice(0, 8)];
    let offset = 8;
    let replaced = false;

    while (offset < originalBuffer.length) {
        if (offset + 8 > originalBuffer.length) break;
        const length = originalBuffer.readUInt32BE(offset);
        const type = originalBuffer.toString('ascii', offset + 4, offset + 8);
        const totalChunkLen = 12 + length;
        const currentChunk = originalBuffer.slice(offset, offset + totalChunkLen);

        if (type === 'tEXt') {
            const data = originalBuffer.slice(offset + 8, offset + 8 + length);
            const nullIdx = data.indexOf(0);
            if (nullIdx !== -1) {
                const k = data.slice(0, nullIdx).toString('ascii');
                if (k === keyword) {
                    parts.push(newChunk);
                    replaced = true;
                    offset += totalChunkLen;
                    continue;
                }
            }
        }

        if (type === 'IEND' && !replaced) {
            parts.push(newChunk);
            replaced = true;
        }

        parts.push(currentChunk);
        offset += totalChunkLen;
        if (type === 'IEND') break;
    }

    if (offset < originalBuffer.length) {
        parts.push(originalBuffer.slice(offset));
    }

    return Buffer.concat(parts);
}