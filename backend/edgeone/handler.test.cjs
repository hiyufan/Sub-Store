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

test('Clash Meta downloads generate complete profiles for existing and newly added subscriptions', async (t) => {
    const { request, base, store } = await server(t);
    const content =
        'vless://11111111-1111-4111-8111-111111111111@reality.example:443?security=reality&sni=example.com&fp=chrome&pbk=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&sid=0123456789abcdef&type=tcp&flow=xtls-rprx-vision#' +
        encodeURIComponent('节点选择');
    assert.equal(
        (
            await request('/api/subs', 'POST', {
                name: 'reality',
                source: 'local',
                content,
            })
        ).status,
        201,
    );
    const download = async (path, headers) => {
        const response = await fetch(`${base}${prefix}${path}`, { headers });
        assert.equal(response.status, 200);
        return YAML.parse(await response.text());
    };
    for (const target of [
        'ClashMeta',
        'meta',
        'clashmeta',
        'clash.meta',
        'Clash.Meta',
        'mihomo',
        'Mihomo',
    ]) {
        const config = await download(`/download/reality?target=${target}`);
        assert.equal(config.proxies.length, 1);
        assert.equal(config.proxies[0].type, 'vless');
        assert.equal(
            config.proxies[0]['reality-opts']['short-id'],
            '0123456789abcdef',
        );
        assert.equal(config['mixed-port'], 7890);
        assert.equal(config['allow-lan'], false);
        const group = config['proxy-groups'][0];
        assert.notEqual(group.name, config.proxies[0].name);
        const groups = config['proxy-groups'];
        assert.equal(groups.length, 13);
        const automatic = groups.find((g) => g.type === 'url-test');
        const failover = groups.find((g) => g.type === 'fallback');
        assert.deepEqual(
            automatic.proxies,
            config.proxies.map((p) => p.name),
        );
        assert.deepEqual(failover.proxies, automatic.proxies);
        assert.equal(automatic.interval, 300);
        assert.equal(automatic.tolerance, 50);
        assert.equal(automatic['max-failed-times'], 2);
        assert.equal(failover['max-failed-times'], 2);
        assert.deepEqual(group.proxies, [
            automatic.name,
            failover.name,
            ...automatic.proxies,
        ]);
        assert.equal(config.rules.at(-1), 'MATCH,漏网之鱼');
        assert.deepEqual(groups.find((g) => g.name === '国内流量').proxies, [
            'DIRECT',
            group.name,
        ]);
        assert.deepEqual(groups.find((g) => g.name === '国外流量').proxies, [
            group.name,
            'DIRECT',
        ]);
        assert.deepEqual(groups.find((g) => g.name === '广告拦截').proxies, [
            'REJECT',
            'DIRECT',
        ]);
        assert.ok(
            config.rules.indexOf('RULE-SET,ads,广告拦截') <
                config.rules.indexOf('RULE-SET,cn-domain,国内流量'),
        );
        const providers = config['rule-providers'];
        assert.deepEqual(Object.keys(providers), [
            'ads',
            'cn-domain',
            'non-cn-domain',
            'cn-ip',
            'ai',
            'telegram',
            'youtube',
            'netflix',
            'microsoft',
            'apple',
            'telegram-ip',
        ]);
        for (const provider of Object.values(providers)) {
            assert.equal(provider.type, 'http');
            assert.equal(provider.format, 'mrs');
            assert.equal(provider.interval, 86400);
            assert.equal(provider.proxy, group.name);
            assert.equal(
                provider.behavior,
                [providers['cn-ip'], providers['telegram-ip']].includes(
                    provider,
                )
                    ? 'ipcidr'
                    : 'domain',
            );
        }
        for (const [key, label] of [
            ['ai', 'AI 服务'],
            ['telegram', 'Telegram'],
            ['youtube', 'YouTube'],
            ['netflix', 'Netflix'],
            ['microsoft', '微软服务'],
            ['apple', '苹果服务'],
        ]) {
            const service = groups.find((g) => g.name === label);
            assert.ok(service.proxies.includes(automatic.name));
            assert.ok(service.proxies.includes(failover.name));
            assert.ok(service.proxies.includes(config.proxies[0].name));
            assert.equal(
                service.proxies[0],
                ['microsoft', 'apple'].includes(key) ? 'DIRECT' : group.name,
            );
            assert.ok(
                config.rules.indexOf(`RULE-SET,${key},${label}`) <
                    config.rules.indexOf('RULE-SET,cn-domain,国内流量'),
            );
        }
        assert.equal(config.dns.enable, true);
        assert.equal(config.profile['store-selected'], true);
        assert.equal(config.dns.listen, '127.0.0.1:1053');
        assert.equal(config.dns['enhanced-mode'], 'redir-host');
        assert.ok(
            config.dns.nameserver.every((url) =>
                url.endsWith(`#${group.name}`),
            ),
        );
        assert.ok(
            config.dns['proxy-server-nameserver'].every((url) =>
                url.endsWith('#DIRECT'),
            ),
        );
        assert.ok(
            config.dns['nameserver-policy']['rule-set:cn-domain'].every((url) =>
                url.endsWith('#DIRECT'),
            ),
        );
        assert.equal(config.dns['nameserver-policy']['+.lan'], 'system');
        assert.ok(
            config.dns['nameserver-policy']['www.gstatic.com'].every((url) =>
                url.endsWith('#DIRECT'),
            ),
        );
        assert.equal(
            config.dns['nameserver-policy']['rule-set:ads'],
            undefined,
        );
    }
    const restarted = await server(t, store);
    assert.equal(
        (
            await restarted.request('/api/subs', 'POST', {
                name: 'added-later',
                source: 'local',
                content:
                    'ss://YWVzLTEyOC1nY206cGFzcw==@example.com:8388#new-node',
            })
        ).status,
        201,
    );
    const added = await download('/download/added-later', {
        'User-Agent': 'clash-verge/v2.4.0',
    });
    assert.equal(added.proxies.length, 1);
    assert.deepEqual(
        added['proxy-groups'].find((g) => g.type === 'url-test').proxies,
        ['new-node'],
    );
    assert.equal(
        (
            await request('/api/collections', 'POST', {
                name: 'combined',
                subscriptions: ['reality', 'added-later'],
            })
        ).status,
        201,
    );
    const collection = await download(
        '/download/collection/combined/ClashMeta',
    );
    assert.equal(collection.proxies.length, 2);
    assert.equal(
        collection['proxy-groups'].find((g) => g.type === 'url-test').proxies
            .length,
        2,
    );
    const share = await download('/share/sub/reality/ClashMeta');
    assert.equal(share['proxy-groups'].length, 13);
    const sharedCollection = await download('/share/col/combined/ClashMeta');
    assert.equal(sharedCollection.proxies.length, 2);
    assert.equal(sharedCollection['proxy-groups'].length, 13);
    assert.deepEqual((await request('/api/files')).body.data, []);
});

test('routing groups and provider references avoid every colliding node name', async (t) => {
    const { request, base } = await server(t);
    const names = [
        '节点选择',
        '国内流量',
        '国外流量',
        '广告拦截',
        '漏网之鱼',
        '广告拦截 (2)',
        '自动测速',
        '故障切换',
        'AI 服务',
        'Telegram',
        'YouTube',
        'Netflix',
        '微软服务',
        '苹果服务',
    ];
    assert.equal(
        (
            await request('/api/subs', 'POST', {
                name: 'collisions',
                source: 'local',
                content: names
                    .map(
                        (name) =>
                            `ss://YWVzLTEyOC1nY206cGFzcw==@example.com:8388#${encodeURIComponent(
                                name,
                            )}`,
                    )
                    .join('\n'),
            })
        ).status,
        201,
    );
    const response = await fetch(
        `${base}${prefix}/download/collisions?target=ClashMeta`,
    );
    assert.equal(response.status, 200);
    const config = YAML.parse(await response.text());
    const groups = config['proxy-groups'];
    assert.equal(groups.length, 13);
    const references = new Set([
        ...names,
        ...groups.map((g) => g.name),
        'DIRECT',
        'REJECT',
    ]);
    for (const group of groups) {
        assert.equal(names.includes(group.name), false);
        assert.ok(group.proxies.every((name) => references.has(name)));
    }
    for (const provider of Object.values(config['rule-providers']))
        assert.equal(provider.proxy, groups[0].name);
    for (const rule of config.rules.filter((r) => /^(RULE-SET|MATCH),/.test(r)))
        assert.ok(
            groups.some(
                (group) =>
                    group.name ===
                    rule.split(',')[rule.startsWith('MATCH,') ? 1 : 2],
            ),
        );
    assert.ok(
        config.dns.nameserver.every((url) =>
            url.endsWith(`#${groups[0].name}`),
        ),
    );
});

test('provider exports, raw/internal formats, other targets, and file composition retain node output', async (t) => {
    const { request, base } = await server(t);
    assert.equal(
        (
            await request('/api/subs', 'POST', {
                name: 'nodes',
                source: 'local',
                content: 'ss://YWVzLTEyOC1nY206cGFzcw==@example.com:8388#test',
            })
        ).status,
        201,
    );
    for (const query of ['target=ClashMeta&profile=nodes', 'target=Clash']) {
        const response = await fetch(
            `${base}${prefix}/download/nodes?${query}`,
        );
        assert.equal(response.status, 200);
        const config = YAML.parse(await response.text());
        assert.deepEqual(Object.keys(config), ['proxies']);
        assert.equal(config.proxies.length, 1);
    }
    for (const type of ['raw', 'internal']) {
        const result = await request(
            `/download/nodes?target=ClashMeta&produceType=${type}`,
        );
        assert.equal(result.status, 200);
        assert.equal(Array.isArray(result.body), true);
    }
    const basic = await fetch(
        `${base}${prefix}/download/nodes?target=ClashMeta&profile=basic`,
    );
    const basicConfig = YAML.parse(await basic.text());
    assert.equal(basic.status, 200);
    assert.equal(basicConfig['proxy-groups'].length, 1);
    assert.equal(basicConfig['rule-providers'], undefined);
    assert.equal(basicConfig.dns, undefined);
    assert.equal(
        (
            await request('/api/files', 'POST', {
                name: 'provider',
                type: 'mihomoConfig',
                sourceType: 'subscription',
                sourceName: 'nodes',
            })
        ).status,
        201,
    );
    const file = await fetch(`${base}${prefix}/api/file/provider`);
    assert.equal(file.status, 200);
    assert.deepEqual(Object.keys(YAML.parse(await file.text())), ['proxies']);
});

test('complete profiles reject empty fallback output and duplicate node names with an actionable error', async (t) => {
    const { request } = await server(t);
    const content = 'ss://YWVzLTEyOC1nY206cGFzcw==@example.com:8388#same';
    assert.equal(
        (
            await request('/api/subs', 'POST', {
                name: 'duplicates',
                source: 'local',
                content: `${content}\n${content}`,
            })
        ).status,
        201,
    );
    const duplicate = await request('/download/duplicates?target=ClashMeta');
    assert.equal(duplicate.status, 500);
    assert.match(duplicate.body.error.details, /重命名重复节点/);
    assert.equal(
        (
            await request('/api/subs', 'POST', {
                name: 'unsupported',
                source: 'local',
                content: 'not-a-subscription',
                ignoreFailedRemoteSub: 'fallbackQuiet',
            })
        ).status,
        201,
    );
    const empty = await request('/download/unsupported?target=ClashMeta');
    assert.equal(empty.status, 500);
    assert.match(empty.body.error.details, /没有可用节点/);
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
