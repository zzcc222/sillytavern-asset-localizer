import fs from 'node:fs';
import path from 'node:path';

export async function downloadFile(url, targetPath, accelerator = 'https://gh-proxy.com/') {
    const urlsToTry = [url];
    if (url.includes('raw.githubusercontent.com') && accelerator) {
        const cleanAcc = accelerator.endsWith('/') ? accelerator : `${accelerator}/`;
        urlsToTry.unshift(`${cleanAcc}${url}`);
    }

    let lastError = null;
    for (const tryUrl of urlsToTry) {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 20000);
            const res = await fetch(tryUrl, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            clearTimeout(timeout);

            if (!res.ok) {
                throw new Error(`HTTP ${res.status}`);
            }

            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 50) {
                throw new Error(`Invalid file size: ${buf.length} bytes`);
            }

            // Quick magic bytes validation (PNG, JPEG, GIF, WEBP)
            const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
            const isJpg = buf[0] === 0xFF && buf[1] === 0xD8;
            const isGif = buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46;
            const isWebp = buf.slice(8, 12).toString('ascii') === 'WEBP';

            if (!isPng && !isJpg && !isGif && !isWebp && !tryUrl.endsWith('.mp3')) {
                throw new Error('Downloaded file is not a valid image');
            }

            fs.writeFileSync(targetPath, buf);
            return true;
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError;
}

export async function batchDownload(tasks, targetDir, config, onProgress = () => {}) {
    const concurrency = config?.concurrency || 8;
    const accelerator = config?.ghAccelerator || 'https://gh-proxy.com/';
    let completed = 0;
    let failed = 0;
    const total = tasks.length;

    let index = 0;
    async function worker() {
        while (index < tasks.length) {
            const task = tasks[index++];
            const filePath = path.join(targetDir, task.filename);

            if (fs.existsSync(filePath)) {
                try {
                    const st = fs.statSync(filePath);
                    if (st.size > 100) {
                        completed++;
                        onProgress({ completed, failed, total, filename: task.filename, status: 'cached' });
                        continue;
                    }
                } catch {}
            }

            try {
                await downloadFile(task.url, filePath, accelerator);
                completed++;
                onProgress({ completed, failed, total, filename: task.filename, status: 'downloaded' });
            } catch (err) {
                failed++;
                onProgress({ completed, failed, total, filename: task.filename, status: 'failed', error: err.message });
            }
        }
    }

    const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
    await Promise.all(workers);

    return { completed, failed, total };
}