const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { unzipSync } = require('fflate');
const release = require('./frontend-release.json');

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function prepareFiles(archive, expectedHash = release.sha256) {
    if (hash(archive) !== expectedHash)
        throw new Error('Frontend archive SHA-256 mismatch');
    const files = new Map();
    for (const [name, bytes] of Object.entries(unzipSync(archive))) {
        if (!name.startsWith('dist/') || name.endsWith('/')) continue;
        const relative = name.slice(5);
        if (
            relative
                .split('/')
                .some((part) => !part || part === '.' || part === '..') ||
            /[\\:\0]/.test(relative)
        ) {
            throw new Error('Invalid frontend archive path');
        }
        // EdgeOne handles compression. Upstream sidecars would contain unpatched JS.
        if (/\.(gz|br)$/.test(relative)) continue;
        files.set(relative, Buffer.from(bytes));
    }
    if (!files.has('index.html') || !files.has('sw.js'))
        throw new Error('Incomplete frontend release');
    let replacements = 0;
    for (const [name, bytes] of files) {
        if (!name.endsWith('.js') || name === 'sw.js') continue;
        const content = bytes
            .toString('utf8')
            .replace(/(['"])https:\/\/sub\.store\1/g, () => {
                replacements++;
                return 'window.location.origin';
            });
        files.set(name, Buffer.from(content));
    }
    if (!replacements)
        throw new Error('Frontend default API boundary not found');
    // Changing the JS invalidates its upstream precache revision. Recompute every
    // local entry so an installed PWA also receives this deployment's exact bytes.
    const worker = files
        .get('sw.js')
        .toString('utf8')
        .replace(
            /\{url:"([^"]+)",revision:(?:"[^"]+"|null)\}/g,
            (entry, url) => {
                const content = files.get(url);
                if (!content)
                    throw new Error(`Missing frontend precache asset: ${url}`);
                return `{url:${JSON.stringify(url)},revision:${JSON.stringify(
                    hash(content),
                )}}`;
            },
        );
    files.set('sw.js', Buffer.from(worker));
    const notice = `Sub-Store Front-End ${release.version}\nLicense: GPL-3.0\nCorresponding source: ${release.source}\nLocal modification: default backend is the current origin; PWA revisions are regenerated.\nModification source: backend/edgeone/frontend.cjs in this repository.\n`;
    files.set('FRONTEND-NOTICE.txt', Buffer.from(notice));
    return files;
}

async function buildFrontend() {
    const backend = path.resolve(__dirname, '..');
    const cache = path.join(
        backend,
        '.edgeone-build',
        `frontend-${release.version}.zip`,
    );
    let archive;
    try {
        archive = await fs.readFile(cache);
    } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        const response = await fetch(release.url, {
            signal: AbortSignal.timeout(60000),
        });
        if (!response.ok)
            throw new Error(
                `Frontend download failed: HTTP ${response.status}`,
            );
        archive = Buffer.from(await response.arrayBuffer());
    }
    const files = prepareFiles(archive);
    const directory = path.join(backend, 'edgeone-public');
    await fs.mkdir(path.dirname(cache), { recursive: true });
    await fs.writeFile(cache, archive);
    for (const [name, bytes] of files) {
        const filename = path.join(directory, name);
        await fs.mkdir(path.dirname(filename), { recursive: true });
        await fs.writeFile(filename, bytes);
    }
    await fs.copyFile(
        path.join(__dirname, 'frontend-LICENSE.txt'),
        path.join(directory, 'FRONTEND-LICENSE.txt'),
    );
    const html = files.get('index.html').toString('utf8');
    await fs.writeFile(
        path.join(backend, '.edgeone-build/frontend-index.cjs'),
        `module.exports = ${JSON.stringify(html)};\n`,
    );
    console.log(
        `Official frontend ${release.version} prepared and SHA-256 verified`,
    );
}

module.exports = { buildFrontend, prepareFiles };
