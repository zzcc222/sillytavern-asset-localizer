import path from 'node:path';

export const PLUGIN_ID = 'st-asset-localizer';
export const PLUGIN_NAME = '图池本地化管家';

// Cross-platform root directory
export const APP_ROOT = process.cwd();

// Universal persistent data directory (works across Linux, Windows, macOS, Docker)
export const DATA_DIR = path.join(APP_ROOT, 'data');
export const CHARACTERS_DIR = path.join(DATA_DIR, 'default-user', 'characters');
export const ASSETS_DIR = path.join(DATA_DIR, 'shared_card_assets');
export const LEGACY_ASSETS_DIR = path.join(APP_ROOT, 'public', 'card_assets');
export const CACHE_DIR = path.join(DATA_DIR, '_cache', 'characters');
export const CONFIG_FILE = path.join(DATA_DIR, 'default-user', 'asset_localizer_config.json');

export const DEFAULT_CONFIG = {
    ghAccelerator: 'https://gh-proxy.com/',
    httpProxy: '',
    concurrency: 10,
    autoPromptOnImport: true
};

/**
 * Cross-platform directory sanitization (strips illegal Windows characters: < > : " / \\ | ? *)
 */
export function sanitizeFolderName(name) {
    if (!name) return 'unnamed';
    return name
        .replace(/[<>:"/\\\\|?*\\x00-\\x1F]/g, '_')
        .replace(/\\.+$/, '')
        .trim() || 'card';
}