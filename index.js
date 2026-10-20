import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUGIN_ID, PLUGIN_NAME, APP_ROOT } from './src/constants.js';
import { registerApi } from './src/api.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const info = {
    id: PLUGIN_ID,
    name: PLUGIN_NAME,
    description: 'SillyTavern Character Card Image Pool Localizer and Asset Manager'
};

function autoInstallClientExtension() {
    try {
        const clientSrc = path.join(__dirname, 'client');
        if (!fs.existsSync(clientSrc)) return;

        const targetExtDirs = [
            path.join(APP_ROOT, 'data', 'default-user', 'extensions', PLUGIN_ID),
            path.join(APP_ROOT, 'public', 'scripts', 'extensions', 'third-party', PLUGIN_ID)
        ];

        for (const targetDir of targetExtDirs) {
            const parentDir = path.dirname(targetDir);
            if (fs.existsSync(parentDir)) {
                if (!fs.existsSync(targetDir)) {
                    fs.mkdirSync(targetDir, { recursive: true });
                }
                const files = fs.readdirSync(clientSrc);
                for (const f of files) {
                    const srcF = path.join(clientSrc, f);
                    const dstF = path.join(targetDir, f);
                    fs.copyFileSync(srcF, dstF);
                }
                console.log(`[${PLUGIN_NAME}] 自动就绪前端扩展: ${targetDir}`);
            }
        }
    } catch (e) {
        console.warn(`[${PLUGIN_NAME}] 自动就绪前端扩展提示:`, e.message);
    }
}

export async function init(router) {
    console.log(`[${PLUGIN_NAME}] Initializing router on /api/plugins/${PLUGIN_ID}`);
    autoInstallClientExtension();
    registerApi(router);
}

export async function exit() {
    console.log(`[${PLUGIN_NAME}] Exiting plugin`);
}