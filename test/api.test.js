import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { registerApi } from '../src/api.js';
import { ASSETS_DIR, PLUGIN_ID } from '../src/constants.js';

test('api: registerApi sets up all endpoints and static routes', async () => {
    const app = express();
    const router = express.Router();
    registerApi(router);
    app.use(`/api/plugins/${PLUGIN_ID}`, router);

    const server = app.listen(0);
    const port = server.address().port;
    const baseUrl = `http://127.0.0.1:${port}/api/plugins/${PLUGIN_ID}`;

    try {
        // 1. GET /status
        const statusRes = await fetch(`${baseUrl}/status`);
        assert.equal(statusRes.status, 200);
        const statusData = await statusRes.json();
        assert.equal(statusData.ok, true);
        assert.equal(statusData.name, 'ST-Asset-Localizer');
        assert.equal(statusData.version, '2.1.0');

        // 2. GET /stats
        const statsRes = await fetch(`${baseUrl}/stats`);
        assert.equal(statsRes.status, 200);
        const statsData = await statsRes.json();
        assert.equal(statsData.ok, true);
        assert.ok(statsData.stats);
        assert.ok(typeof statsData.stats.totalFiles === 'number');

        // 3. GET /cards
        const cardsRes = await fetch(`${baseUrl}/cards`);
        assert.equal(cardsRes.status, 200);
        const cardsData = await cardsRes.json();
        assert.equal(cardsData.ok, true);
        assert.ok(Array.isArray(cardsData.cards));

        // 4. POST /scan
        const scanMissingRes = await fetch(`${baseUrl}/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
        });
        assert.equal(scanMissingRes.status, 400);

        const scanNonExistentRes = await fetch(`${baseUrl}/scan`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ cardFileName: 'NonExistent_9999.png' })
        });
        assert.equal(scanNonExistentRes.status, 404);

        // 5. GET /scan query
        const getScanMissingRes = await fetch(`${baseUrl}/scan`);
        assert.equal(getScanMissingRes.status, 400);

        // 6. GET /config and POST /config
        const configGetRes = await fetch(`${baseUrl}/config`);
        assert.equal(configGetRes.status, 200);
        const configGetData = await configGetRes.json();
        assert.equal(configGetData.ok, true);
        assert.ok(configGetData.config);

        const configPostRes = await fetch(`${baseUrl}/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ghAccelerator: 'https://gh.custom.com/', concurrency: 6 })
        });
        assert.equal(configPostRes.status, 200);
        const configPostData = await configPostRes.json();
        assert.equal(configPostData.ok, true);
        assert.equal(configPostData.config.ghAccelerator, 'https://gh.custom.com/');

        // 7. POST /clean-orphans
        const cleanRes = await fetch(`${baseUrl}/clean-orphans`, { method: 'POST' });
        assert.equal(cleanRes.status, 200);
        const cleanData = await cleanRes.json();
        assert.equal(cleanData.ok, true);
        assert.ok(Array.isArray(cleanData.result.deleted));

        // 8. Static file serving under /assets
        const testFolder = path.join(ASSETS_DIR, '_api_test_folder');
        if (!fs.existsSync(testFolder)) fs.mkdirSync(testFolder, { recursive: true });
        const testFilePath = path.join(testFolder, 'test_pixel.png');
        const dummyPng = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x00]);
        fs.writeFileSync(testFilePath, dummyPng);

        const staticRes = await fetch(`${baseUrl}/assets/_api_test_folder/test_pixel.png`);
        assert.equal(staticRes.status, 200);
        assert.equal(staticRes.headers.get('content-type'), 'image/png');
        assert.ok(staticRes.headers.get('cache-control')?.includes('immutable'));

        // 9. Case-insensitive fallback serving (Linux/Docker parity)
        const fallbackRes = await fetch(`${baseUrl}/assets/_API_TEST_FOLDER/TEST_PIXEL.PNG`);
        assert.equal(fallbackRes.status, 200);
        assert.ok(fallbackRes.headers.get('cache-control')?.includes('immutable'));

        // Clean up test file
        fs.rmSync(testFolder, { recursive: true, force: true });

    } finally {
        server.close();
    }
});
