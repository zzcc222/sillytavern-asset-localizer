import express from 'express';
import { ASSETS_DIR, LEGACY_ASSETS_DIR } from './constants.js';
import { scanCard, scanAllCards } from './scanner.js';
import { localizeCard, revertCard, getCardDetail, getGlobalStats, cleanOrphans, loadConfig, saveConfig } from './localizer.js';

export function registerApi(router) {
    router.use(express.json({ limit: '50mb' }));

    // Mount Express static asset serving for zero-config cross-platform use
    router.use('/assets', express.static(ASSETS_DIR, {
        maxAge: '7d',
        immutable: true
    }));
    router.use('/assets', express.static(LEGACY_ASSETS_DIR, {
        maxAge: '7d',
        immutable: true
    }));

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

    // Detailed card configuration & mappings
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
            const result = await localizeCard(cardFileName);
            res.json({ ok: true, result });
        } catch (err) {
            res.status(500).json({ ok: false, error: err.message });
        }
    });

    router.post('/revert', async (req, res) => {
        try {
            const { cardFileName, customOriginalBase } = req.body;
            if (!cardFileName) return res.status(400).json({ ok: false, error: 'cardFileName required' });
            const result = await revertCard(cardFileName, customOriginalBase);
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