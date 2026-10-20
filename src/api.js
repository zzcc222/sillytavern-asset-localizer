import fs from 'node:fs';
import express from 'express';
import path from 'node:path';
import { ASSETS_DIR, LEGACY_ASSETS_DIR } from './constants.js';
import { scanCard, scanAllCards } from './scanner.js';
import { localizeCard, revertCard, getCardDetail, getGlobalStats, cleanOrphans, loadConfig, saveConfig } from './localizer.js';

export function registerApi(router) {
    router.use(express.json({ limit: '50mb' }));

    // Ensure storage directory exists before mounting static middleware
    if (!fs.existsSync(ASSETS_DIR)) {
        try { fs.mkdirSync(ASSETS_DIR, { recursive: true }); } catch {}
    }

    // Mount Express static asset serving for zero-config cross-platform use
    router.use('/assets', express.static(ASSETS_DIR, {
        maxAge: '7d',
        immutable: true,
        index: false
    }));
    router.use('/assets', express.static(LEGACY_ASSETS_DIR, {
        maxAge: '7d',
        immutable: true,
        index: false
    }));

    // Cross-platform case-insensitive fallback middleware for Linux / Docker environments
    router.use('/assets', (req, res, next) => {
        try {
            const parts = (req.path || '').split('/').filter(Boolean);
            if (parts.length < 2) return next();

            const safeName = decodeURIComponent(parts[0]);
            const fileName = decodeURIComponent(parts.slice(1).join('/'));

            const baseDirs = [ASSETS_DIR, LEGACY_ASSETS_DIR];
            for (const baseDir of baseDirs) {
                if (!fs.existsSync(baseDir)) continue;

                const folders = fs.readdirSync(baseDir);
                const matchedFolder = folders.find(f => f.toLowerCase() === safeName.toLowerCase());
                if (!matchedFolder) continue;

                const folderPath = path.join(baseDir, matchedFolder);
                if (!fs.statSync(folderPath).isDirectory()) continue;

                const files = fs.readdirSync(folderPath);
                const matchedFile = files.find(f => f.toLowerCase() === fileName.toLowerCase());
                if (!matchedFile) continue;
                const targetFilePath = path.join(folderPath, matchedFile);
                if (fs.existsSync(targetFilePath) && fs.statSync(targetFilePath).isFile()) {
                    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
                    return res.sendFile(targetFilePath);
                }
            }
        } catch {}
        next();
    });

    router.get('/status', (req, res) => {
        res.json({ ok: true, name: 'ST-Asset-Localizer', version: '2.1.0' });
    });

    router.get('/stats', (req, res) => {
        try {
            res.json({ ok: true, stats: getGlobalStats() });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.get('/cards', (req, res) => {
        try {
            const list = scanAllCards();
            res.json({ ok: true, cards: list });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // Single card scan endpoint (supports POST and GET)
    router.post('/scan', (req, res) => {
        try {
            const { cardFileName } = req.body;
            if (!cardFileName) return res.status(400).json({ ok: false, error: 'cardFileName required' });
            const result = scanCard(String(cardFileName));
            if (result.error) return res.status(404).json({ ok: false, error: result.error });
            res.json({ ok: true, result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.get('/scan', (req, res) => {
        try {
            const { cardFileName } = req.query;
            if (!cardFileName) return res.status(400).json({ ok: false, error: 'cardFileName required' });
            const result = scanCard(String(cardFileName));
            if (result.error) return res.status(404).json({ ok: false, error: result.error });
            res.json({ ok: true, result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    // Detailed card assets inventory
    router.get('/card-detail', (req, res) => {
        try {
            const { cardFileName } = req.query;
            if (!cardFileName) return res.status(400).json({ ok: false, error: 'cardFileName required' });
            const detail = getCardDetail(String(cardFileName));
            res.json({ ok: true, detail });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.post('/localize', async (req, res) => {
        try {
            const { cardFileName } = req.body;
            if (!cardFileName) return res.status(400).json({ ok: false, error: 'cardFileName required' });
            const result = await localizeCard(String(cardFileName));
            res.json({ ok: true, result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.post('/revert', (req, res) => {
        try {
            const { cardFileName } = req.body;
            if (!cardFileName) return res.status(400).json({ ok: false, error: 'cardFileName required' });
            const result = revertCard(String(cardFileName));
            res.json({ ok: true, result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.post('/clean-orphans', (req, res) => {
        try {
            const result = cleanOrphans();
            res.json({ ok: true, result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.get('/config', (req, res) => {
        res.json({ ok: true, config: loadConfig() });
    });

    router.post('/config', (req, res) => {
        try {
            saveConfig(req.body);
            res.json({ ok: true, config: loadConfig() });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });
}
