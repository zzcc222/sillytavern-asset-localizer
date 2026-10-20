import fs from 'node:fs';
import path from 'node:path';

function isValidAssetBuffer(buf, url = '') {
    if (!buf || buf.length < 50) return false;

    // PNG: 89 50 4E 47
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return true;
    // JPEG: FF D8
    if (buf[0] === 0xFF && buf[1] === 0xD8) return true;
    // GIF: 47 49 46
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return true;
    // WEBP: RIFF....WEBP
    if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return true;
    // AVIF: ....ftyp (avif / avis)
    if (buf.length >= 12 && buf.slice(4, 8).toString('ascii') === 'ftyp') return true;
    // SVG: text starting with <svg or <?xml
    const head = buf.slice(0, 100).toString('utf-8').trim().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return true;
    // Audio / Voice resources
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.endsWith('.mp3') || lowerUrl.endsWith('.ogg') || lowerUrl.endsWith('.wav')) {
        if (buf.slice(0, 3).toString('ascii') === 'ID3' || (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0)) return true;
        if (buf.slice(0, 4).toString('ascii') === 'OggS') return true;
        if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WAVE') return true;
    }

    return false;
}

export async function downloadFile(url, targetPath, accelerator = 'https://gh-proxy.com/') {
    const urlsToTry = [url];
    const acc = typeof accelerator === 'string' ? accelerator.trim() : '';
    if (url.includes('raw.githubusercontent.com') && acc) {
        const cleanAcc = acc.endsWith('/') ? acc : `${acc}/`;
        urlsToTry.unshift(`${cleanAcc}${url}`);
    }

    let lastError = null;
    for (const tryUrl of urlsToTry) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30000);
        try {
            const res = await fetch(tryUrl, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
                }
            });

            if (!res.ok) {
                throw new Error(`HTTP ${res.status} ${res.statusText}`);
            }

            const buf = Buffer.from(await res.arrayBuffer());
            if (buf.length < 50) {
                throw new Error(`Invalid file size: ${buf.length} bytes`);
            }

            if (!isValidAssetBuffer(buf, tryUrl)) {
                throw new Error('Downloaded file is not a valid image');
            }

            const targetDir = path.dirname(targetPath);
            if (!fs.existsSync(targetDir)) {
                fs.mkdirSync(targetDir, { recursive: true });
            }

            fs.writeFileSync(targetPath, buf);
            return true;
        } catch (err) {
            lastError = err;
        } finally {
            clearTimeout(timeout);
        }
    }
    throw lastError || new Error(`Failed to download ${url}`);
}

export async function batchDownload(tasks, targetDir, config, onProgress = () => {}) {
    if (!tasks || tasks.length === 0) {
        return { completed: 0, failed: 0, total: 0 };
    }

    // Deduplicate tasks by unique URL
    const uniqueTasks = [];
    const seenUrls = new Set();
    for (const t of tasks) {
        if (!seenUrls.has(t.url)) {
            seenUrls.add(t.url);
            uniqueTasks.push(t);
        }
    }

    const concurrency = Math.max(1, config?.concurrency || 8);
    const accelerator = typeof config?.ghAccelerator === 'string' ? config.ghAccelerator.trim() : 'https://gh-proxy.com/';
    let completed = 0;
    let failed = 0;
    const total = uniqueTasks.length;

    let index = 0;
    async function worker() {
        while (index < uniqueTasks.length) {
            const task = uniqueTasks[index++];
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

    const workerCount = Math.min(concurrency, uniqueTasks.length);
    const workers = Array.from({ length: workerCount }, () => worker());
    await Promise.all(workers);

    return { completed, failed, total };
}