import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { downloadFile, batchDownload } from '../src/downloader.js';

function createValidPngBuffer() {
    const header = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    const padding = Buffer.alloc(100, 0);
    return Buffer.concat([header, padding]);
}

test('downloader: downloadFile successfully saves valid image', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dl-test-'));
    const targetFile = path.join(tmpDir, 'downloaded.png');
    const validPng = createValidPngBuffer();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => Uint8Array.from(validPng).buffer
    });

    try {
        const result = await downloadFile('https://example.com/image.png', targetFile);
        assert.equal(result, true);
        assert.ok(fs.existsSync(targetFile));
        assert.equal(fs.readFileSync(targetFile).length, validPng.length);
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('downloader: downloadFile prepends accelerator for github raw urls', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dl-gh-'));
    const targetFile = path.join(tmpDir, 'gh.png');
    const validPng = createValidPngBuffer();

    const fetchedUrls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
        fetchedUrls.push(url);
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            arrayBuffer: async () => Uint8Array.from(validPng).buffer
        };
    };

    try {
        await downloadFile('https://raw.githubusercontent.com/user/repo/main/img.png', targetFile, 'https://fast-gh.org/');
        assert.ok(fetchedUrls[0].startsWith('https://fast-gh.org/https://raw.githubusercontent.com/'));
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('downloader: downloadFile rejects corrupt or HTML responses with 200 status', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dl-corrupt-'));
    const targetFile = path.join(tmpDir, 'html_error.png');
    const fakeHtmlResponse = Buffer.from('<!DOCTYPE html><html><body>404 Not Found HTML page</body></html>');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        arrayBuffer: async () => Uint8Array.from(fakeHtmlResponse).buffer
    });

    try {
        await assert.rejects(
            async () => {
                await downloadFile('https://example.com/not_image.png', targetFile, '');
            },
            /Downloaded file is not a valid image/
        );
        assert.ok(!fs.existsSync(targetFile));
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('downloader: downloadFile rejects HTTP error codes', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dl-404-'));
    const targetFile = path.join(tmpDir, 'error.png');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
        ok: false,
        status: 404,
        statusText: 'Not Found'
    });

    try {
        await assert.rejects(
            async () => {
                await downloadFile('https://example.com/missing.png', targetFile, '');
            },
            /HTTP 404 Not Found/
        );
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('downloader: batchDownload skips cached files and respects concurrency', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-dl-batch-'));
    const validPng = createValidPngBuffer();

    // Pre-create file1 as cached file (>100 bytes)
    fs.writeFileSync(path.join(tmpDir, 'file1.png'), validPng);

    let fetchCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
        fetchCount++;
        return {
            ok: true,
            status: 200,
            statusText: 'OK',
            arrayBuffer: async () => Uint8Array.from(validPng).buffer
        };
    };

    const tasks = [
        { filename: 'file1.png', url: 'https://example.com/file1.png' },
        { filename: 'file2.png', url: 'https://example.com/file2.png' },
        { filename: 'file2.png', url: 'https://example.com/file2.png' } // duplicate URL
    ];

    try {
        const progressReports = [];
        const result = await batchDownload(tasks, tmpDir, { concurrency: 4, ghAccelerator: '' }, (p) => {
            progressReports.push(p);
        });

        assert.equal(result.total, 2, 'Deduplicated to 2 tasks');
        assert.equal(result.completed, 2, '2 tasks completed');
        assert.equal(result.failed, 0);
        assert.equal(fetchCount, 1, 'Only non-cached file was fetched');
        assert.ok(progressReports.some(p => p.status === 'cached' && p.filename === 'file1.png'));
        assert.ok(progressReports.some(p => p.status === 'downloaded' && p.filename === 'file2.png'));
    } finally {
        globalThis.fetch = originalFetch;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
