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
