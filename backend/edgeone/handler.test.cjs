const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const Module = require('node:module');
const YAML = require('yaml');
const { createHandler } = require('./handler.cjs');
const createApplication = require('../.edgeone-build/application.cjs');

const prefix = '/test_secret_0123456789';
class MemoryStore {
    constructor() {
        this.values = new Map();
    }
    async list() {
        return {
            blobs: [...this.values.keys()].map((key) => ({ key, etag: key })),
        };
    }
    async get(key) {
        return structuredClone(this.values.get(key));
    }
    async setJSON(key, value) {
        this.values.set(key, structuredClone(value));
    }
}
async function server(t, store = new MemoryStore(), options = {}) {
    const app = createHandler({
        createApplication,
        storeFactory: () => store,
        env: { EDGEONE_SUB_STORE_PATH: prefix },
        ...options,
    });
    const instance = http.createServer(app);
    await new Promise((resolve) => instance.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => instance.close(resolve)));
    const base = `http://127.0.0.1:${instance.address().port}`;
    async function request(path, method = 'GET', body) {
        const response = await fetch(`${base}${prefix}${path}`, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await response.text();
        return {
            status: response.status,
            headers: response.headers,
            body: text ? JSON.parse(text) : null,
        };
    }
    return { request, base, store };
}

test('real bundled app persists CRUD and reloads from Blob on a new instance without file writes', async (t) => {
    const first = await server(t);
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = () => {
        throw new Error('Cloud application must not write local data');
    };
    t.after(() => {
        fs.writeFileSync = originalWrite;
    });
    assert.equal(
        (
            await first.request('/api/subs', 'POST', {
                name: 'test',
                source: 'local',
                content: 'ss://test',
            })
        ).status,
        201,
    );
    const second = await server(t, first.store);
    let response = await second.request('/api/subs');
    assert.equal(response.status, 200);
    assert.equal(response.body.data[0].name, 'test');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(
        (
            await second.request('/api/sub/test', 'PATCH', {
                displayName: 'Updated',
            })
        ).status,
        200,
    );
    assert.equal(
        (await first.request('/api/subs')).body.data[0].displayName,
        'Updated',
    );
    assert.equal((await first.request('/api/sub/test', 'DELETE')).status, 200);
    assert.deepEqual((await second.request('/api/subs')).body.data, []);
});

test('two cloud instances adding subscriptions concurrently preserve both records', async (t) => {
    const store = new MemoryStore();
    const first = await server(t, store);
    const second = await server(t, store);
    // Synchronize the first two writes so both requests work from an empty store.
    const set = store.setJSON.bind(store);
    let release;
    const ready = new Promise((resolve) => {
        release = resolve;
    });
    let writes = 0;
    store.setJSON = async (...args) => {
        if (++writes === 2) release();
        await ready;
        return set(...args);
    };
    const results = await Promise.all([
        first.request('/api/subs', 'POST', {
            name: 'A',
            source: 'local',
            content: 'ss://a',
        }),
        second.request('/api/subs', 'POST', {
            name: 'B',
            source: 'local',
            content: 'ss://b',
        }),
    ]);
    assert.deepEqual(
        results.map((result) => result.status),
        [201, 201],
    );
    assert.deepEqual(
        (await first.request('/api/subs')).body.data
            .map((item) => item.name)
            .sort(),
        ['A', 'B'],
    );
});

test('a successful response waits for Blob persistence, and a write failure returns 503', async (t) => {
    const store = new MemoryStore();
    let release;
    let entered;
    const started = new Promise((resolve) => {
        entered = resolve;
    });
    const pending = new Promise((resolve) => {
        release = resolve;
    });
    store.setJSON = async () => {
        entered();
        await pending;
        throw new Error('private signed URL');
    };
    const { request } = await server(t, store);
    let responded = false;
    const result = request('/api/subs', 'POST', {
        name: 'A',
        source: 'local',
        content: 'x',
    }).then((value) => {
        responded = true;
        return value;
    });
    await started;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(responded, false);
    release();
    const response = await result;
    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'EDGEONE_REQUEST_FAILED');
    assert.equal(
        JSON.stringify(response.body).includes('private signed URL'),
        false,
    );
});

test('secret path is required and unmatched requests do not touch storage', async (t) => {
    const { base, store } = await server(t);
    assert.equal((await fetch(`${base}/api/subs`)).status, 404);
    assert.equal((await fetch(`${base}${prefix}extra/api/subs`)).status, 404);
    assert.equal(store.values.size, 0);
    const missing = await server(t, undefined, { env: {} });
    assert.equal(
        (await fetch(`${missing.base}${prefix}/api/subs`)).status,
        503,
    );
});

test('console secret accepts an optional leading slash and surrounding whitespace', async (t) => {
    for (const value of [
        prefix.slice(1),
        `  ${prefix}\n`,
        ` ${prefix.slice(1)} `,
    ]) {
        const { request, base } = await server(t, undefined, {
            env: { EDGEONE_SUB_STORE_PATH: value },
        });
        assert.equal((await request('/api/utils/env')).status, 200);
        assert.equal((await fetch(`${base}/api/utils/env`)).status, 404);
        assert.equal(
            (await fetch(`${base}${prefix}extra/api/utils/env`)).status,
            404,
        );
    }
});

test('configuration errors distinguish missing and invalid secrets without storage access or secret disclosure', async (t) => {
    for (const value of [
        undefined,
        '',
        '   ',
        'short',
        `${prefix}/`,
        `/${prefix}`,
        'https://example.com/secret',
        'a'.repeat(129),
    ]) {
        const { request } = await server(t, undefined, {
            env: { EDGEONE_SUB_STORE_PATH: value },
            storeFactory() {
                assert.fail('Invalid configuration must not access Blob');
            },
        });
        const response = await request('/api/utils/env');
        assert.equal(response.status, 503);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        assert.equal(
            response.body.error.code,
            value?.trim()
                ? 'EDGEONE_CONFIG_INVALID'
                : 'EDGEONE_CONFIG_REQUIRED',
        );
        assert.match(response.body.error.message, /重新部署/);
        assert.equal(JSON.stringify(response.body).includes(prefix), false);
    }
});

test('invalid JSON does not commit state; CORS preflight and environment response work', async (t) => {
    const { base, store, request } = await server(t);
    const bad = await fetch(`${base}${prefix}/api/subs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{',
    });
    assert.equal(bad.status, 503);
    assert.equal(store.values.size, 0);
    const preflight = await fetch(`${base}${prefix}/api/subs`, {
        method: 'OPTIONS',
        headers: {
            Origin: 'https://sub-store.vercel.app',
            'Access-Control-Request-Method': 'POST',
        },
    });
    assert.equal(preflight.status, 200);
    assert.equal(
        preflight.headers.get('access-control-allow-origin'),
        'https://sub-store.vercel.app',
    );
    const response = await request('/api/utils/env');
    assert.equal(response.status, 200);
    assert.deepEqual(response.body.data.meta.node.env, {});
});

test('backup import and export survive instance replacement', async (t) => {
    const first = await server(t);
    const backup = {
        settings: { theme: 'dark' },
        subs: [{ name: 'backup', source: 'local', content: 'x' }],
        schemaVersion: '2.0',
        collections: [],
        artifacts: [],
        files: [],
        tokens: [],
        modules: [],
        archives: [],
    };
    assert.equal(
        (
            await first.request('/api/storage', 'POST', {
                content: JSON.stringify(backup),
            })
        ).status,
        200,
    );
    const second = await server(t, first.store);
    assert.deepEqual((await second.request('/api/storage')).body, backup);
});

test('bundled cloud app converts subscriptions without external npm modules at runtime', async (t) => {
    const { request, base } = await server(t);
    const content = 'ss://YWVzLTEyOC1nY206cGFzcw==@example.com:8388#test';
    const origin = http.createServer((req, res) => res.end(content));
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => origin.close(resolve)));
    const load = Module._load;
    Module._load = function (id, ...args) {
        assert.equal(
            Module.isBuiltin(id),
            true,
            `Unexpected runtime npm dependency: ${id}`,
        );
        return load.call(this, id, ...args);
    };
    t.after(() => {
        Module._load = load;
    });
    assert.equal(
        (
            await request('/api/subs', 'POST', {
                name: 'convert',
                source: 'remote',
                url: `http://127.0.0.1:${origin.address().port}/subscription`,
            })
        ).status,
        201,
    );
    const result = await fetch(
        `${base}${prefix}/download/convert?target=ClashMeta`,
    );
    assert.equal(result.status, 200);
    assert.equal(
        YAML.parse(await result.text()).proxies[0].server,
        'example.com',
    );
});

test('cloud mode rejects count-limited tokens and retains time-based tokens', async (t) => {
    const { request } = await server(t);
    await request('/api/subs', 'POST', {
        name: 'A',
        source: 'local',
        content: 'x',
    });
    const payload = { type: 'sub', name: 'A' };
    const unsupported = await request('/api/token', 'POST', {
        payload,
        options: { mode: 'count', count: 1 },
    });
    assert.equal(
        unsupported.body.error.code,
        'UNSUPPORTED_EDGEONE_COUNT_TOKEN',
    );
    assert.equal(
        (
            await request('/api/token', 'POST', {
                payload,
                options: { mode: 'datetime', exp: Date.now() + 60000 },
            })
        ).status,
        200,
    );
});

test('homepage and Vue deep links return the full SPA without exposing a secret or touching Blob', async (t) => {
    const frontendHtml = require('../.edgeone-build/frontend-index.cjs');
    const { base, store } = await server(t, undefined, {
        frontendHtml,
        env: {},
    });
    for (const pathname of [
        '/',
        '/subs',
        '/my',
        '/settings/api',
        '/edit/subs/example',
    ]) {
        const response = await fetch(`${base}${pathname}`, {
            headers: { Accept: 'text/html' },
        });
        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type'), /text\/html/);
        assert.equal(await response.text(), frontendHtml);
    }
    assert.equal(store.values.size, 0);
    assert.equal(frontendHtml.includes(prefix), false);
    const api = await fetch(`${base}/api/utils/env`, {
        headers: { Accept: 'text/html' },
    });
    assert.equal(api.status, 503);
    assert.match(api.headers.get('content-type'), /application\/json/);
});

test('same-origin browser writes work while cross-origin and cross-protocol requests stay blocked', async (t) => {
    const { base } = await server(t);
    const send = (origin) =>
        fetch(`${base}${prefix}/api/subs`, {
            method: 'POST',
            headers: { Origin: origin, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'browser',
                source: 'local',
                content: 'x',
            }),
        });
    assert.equal((await send('https://evil.example')).status, 403);
    assert.equal((await send(base.replace('http:', 'https:'))).status, 403);
    assert.equal((await send(base)).status, 201);
    const forwarded = await fetch(`${base}${prefix}/api/subs`, {
        method: 'POST',
        headers: {
            Origin: 'https://sub.example.com',
            'X-Forwarded-Host': 'sub.example.com',
            'X-Forwarded-Proto': 'https',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            name: 'forwarded',
            source: 'local',
            content: 'x',
        }),
    });
    assert.equal(forwarded.status, 201);
});

test('EdgeOne public host permits same-origin requests behind its internal HTTP hop', async (t) => {
    const { base } = await server(t);
    const headers = {
        Host: 'localhost:9000',
        'Eo-Pages-Host': 'sub.example.com',
        'X-Forwarded-Host': 'internal.example.com',
        Origin: 'https://sub.example.com',
        'Content-Type': 'application/json',
    };
    const send = (path, method = 'GET', body, overrides = {}) =>
        fetch(`${base}${prefix}${path}`, {
            method,
            headers: { ...headers, ...overrides },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
    assert.equal((await send('/api/utils/env')).status, 200);
    assert.equal(
        (
            await send('/api/subs', 'OPTIONS', undefined, {
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type',
            })
        ).status,
        200,
    );
    assert.equal(
        (
            await send('/api/subs', 'POST', {
                name: 'platform-browser',
                source: 'local',
                content: 'x',
            })
        ).status,
        201,
    );
    assert.equal(
        (
            await send(
                '/api/sub/platform-browser',
                'PATCH',
                {
                    displayName: 'Updated from EdgeOne',
                },
                { 'X-Forwarded-Proto': 'HTTPS, http' },
            )
        ).status,
        200,
    );
    assert.equal(
        (await send('/api/sub/platform-browser', 'DELETE')).status,
        200,
    );
    for (const origin of [
        'https://evil.example',
        'http://sub.example.com',
        'https://sub.example.com:8443',
        'null',
    ]) {
        assert.equal(
            (await send('/api/utils/env', 'GET', undefined, { Origin: origin }))
                .status,
            403,
        );
    }
    assert.equal(
        (
            await send('/api/utils/env', 'GET', undefined, {
                'X-Forwarded-Proto': 'http',
            })
        ).status,
        403,
    );
    assert.equal(
        (
            await send('/api/utils/env', 'GET', undefined, {
                Origin: 'http://sub.example.com',
                'X-Forwarded-Proto': 'http',
            })
        ).status,
        200,
    );
});

test('missing assets and invalid secret API paths never return the SPA shell', async (t) => {
    const frontendHtml = require('../.edgeone-build/frontend-index.cjs');
    const { base, store } = await server(t, undefined, { frontendHtml });
    for (const pathname of [
        '/missing.js',
        '/chunks/missing.css',
        '/wrong/api/subs',
        '/download/not-authorized',
    ]) {
        const response = await fetch(`${base}${pathname}`, {
            headers: { Accept: 'text/html' },
        });
        assert.equal(response.status, 404);
        assert.notEqual(await response.text(), frontendHtml);
    }
    assert.equal(store.values.size, 0);
});
