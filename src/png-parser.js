import zlib from 'node:zlib';

/**
 * Low-level PNG text chunk parser and writer (supports tEXt, zTXt, and iTXt)
 */
export function readPngTextChunks(buffer) {
    const chunks = {};
    if (!buffer || buffer.length < 8) return chunks;
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
        } else if (type === 'zTXt') {
            const data = buffer.slice(offset + 8, offset + 8 + length);
            const nullIdx = data.indexOf(0);
            if (nullIdx !== -1 && data.length > nullIdx + 2) {
                const keyword = data.slice(0, nullIdx).toString('ascii');
                const compMethod = data[nullIdx + 1];
                if (compMethod === 0) {
                    try {
                        const uncompressed = zlib.inflateSync(data.slice(nullIdx + 2));
                        chunks[keyword] = uncompressed.toString('utf-8');
                    } catch {}
                }
            }
        } else if (type === 'iTXt') {
            const data = buffer.slice(offset + 8, offset + 8 + length);
            const nullIdx1 = data.indexOf(0);
            if (nullIdx1 !== -1 && data.length > nullIdx1 + 3) {
                const keyword = data.slice(0, nullIdx1).toString('ascii');
                const compFlag = data[nullIdx1 + 1];
                const compMethod = data[nullIdx1 + 2];
                let pos = nullIdx1 + 3;
                const nullIdx2 = data.indexOf(0, pos);
                if (nullIdx2 !== -1) {
                    pos = nullIdx2 + 1;
                    const nullIdx3 = data.indexOf(0, pos);
                    if (nullIdx3 !== -1) {
                        pos = nullIdx3 + 1;
                        const textData = data.slice(pos);
                        if (compFlag === 0) {
                            chunks[keyword] = textData.toString('utf-8');
                        } else if (compFlag === 1 && compMethod === 0) {
                            try {
                                const uncompressed = zlib.inflateSync(textData);
                                chunks[keyword] = uncompressed.toString('utf-8');
                            } catch {}
                        }
                    }
                }
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
    if (!originalBuffer || originalBuffer.length < 8) {
        throw new Error('Invalid PNG buffer: buffer too short');
    }
    const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    if (!originalBuffer.slice(0, 8).equals(PNG_SIGNATURE)) {
        throw new Error('Invalid PNG buffer: missing PNG signature');
    }

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

        if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
            const data = originalBuffer.slice(offset + 8, offset + 8 + length);
            const nullIdx = data.indexOf(0);
            if (nullIdx !== -1) {
                const k = data.slice(0, nullIdx).toString('ascii');
                if (k === keyword) {
                    // Only insert newChunk for the first occurrence; discard any duplicate chunks
                    if (!replaced) {
                        parts.push(newChunk);
                        replaced = true;
                    }
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