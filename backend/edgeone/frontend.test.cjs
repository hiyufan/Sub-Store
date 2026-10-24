const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { zipSync, strToU8 } = require('fflate');
const { prepareFiles } = require('./frontend.cjs');
const release = require('./frontend-release.json');

test('official frontend is verified, self hosted, and precache revisions match modified assets', () => {
    const archive = fs.readFileSync(
        path.join(
            __dirname,
            `../.edgeone-build/frontend-${release.version}.zip`,
        ),
    );
    const files = prepareFiles(archive);
    assert.match(files.get('index.html').toString(), /<div id="app"><\/div>/);
    assert.equal(
        [...files.keys()].some((key) => /\.(gz|br)$/.test(key)),
        false,
    );
    const scripts = [...files]
        .filter(([key]) => key.endsWith('.js'))
        .map(([, value]) => value.toString())
        .join('\n');
    assert.doesNotMatch(scripts, /(['"])https:\/\/sub\.store\1/);
    assert.match(scripts, /window\.location\.origin/);
    const indexHash = createHash('sha256')
        .update(files.get('index.js'))
        .digest('hex');
    assert.ok(
        files
            .get('sw.js')
            .toString()
            .includes(`url:"index.js",revision:"${indexHash}"`),
    );
    assert.match(files.get('FRONTEND-NOTICE.txt').toString(), /GPL-3\.0/);
});

test('tampered frontend archive is rejected before extraction', () => {
    assert.throws(
        () => prepareFiles(Buffer.from('tampered')),
        /SHA-256 mismatch/,
    );
});

test('frontend ZIP traversal is rejected even if its checksum is accepted', () => {
    const archive = zipSync({ 'dist/../outside.js': strToU8('unsafe') });
    const digest = createHash('sha256').update(archive).digest('hex');
    assert.throws(
        () => prepareFiles(archive, digest),
        /Invalid frontend archive path/,
    );
});
