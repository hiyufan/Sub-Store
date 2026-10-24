const { test } = require('node:test');
const assert = require('node:assert/strict');
const { BlobJournal, diff, apply } = require('./blob-journal.cjs');

class MemoryStore {
    constructor() {
        this.values = new Map();
    }
    async list(options) {
        assert.equal(options.consistency, 'strong');
        return {
            blobs: [...this.values.keys()]
                .reverse()
                .map((key) => ({ key, etag: key })),
        };
    }
    async get(key, options) {
        assert.equal(options.consistency, 'strong');
        return structuredClone(this.values.get(key) ?? null);
    }
    async setJSON(key, value) {
        assert.equal(
            this.values.has(key),
            false,
            'commits never overwrite an existing record',
        );
        this.values.set(key, structuredClone(value));
    }
}

test('independent workers preserve simultaneous subscription additions and settings edits', async () => {
    const store = new MemoryStore();
    const first = new BlobJournal(store);
    const second = new BlobJournal(store);
    const a = await first.load();
    const b = await second.load();
    a.state.cache = {
        subs: [{ name: 'A', url: 'https://a.example' }],
        settings: { theme: 'dark' },
    };
    b.state.cache = {
        subs: [{ name: 'B', url: 'https://b.example' }],
        settings: { language: 'zh' },
    };
    await Promise.all([first.commit(a), second.commit(b)]);
    const { state } = await new BlobJournal(store).load();
    assert.deepEqual(state.cache.subs.map((item) => item.name).sort(), [
        'A',
        'B',
    ]);
    assert.deepEqual(state.cache.settings, { language: 'zh', theme: 'dark' });
});

test('nested edits, deletion, sorting, backup replacement and token identity survive replay', async () => {
    const journal = new BlobJournal(new MemoryStore());
    let transaction = await journal.load();
    transaction.state.cache = {
        subs: [
            { name: 'A', url: 'old', process: ['a', 'b'] },
            { name: 'B' },
            { name: 'C' },
        ],
        tokens: [
            { name: 'A', token: 'one' },
            { name: 'A', token: 'two' },
        ],
    };
    await journal.commit(transaction);
    transaction = await journal.load();
    transaction.state.cache.subs = [
        { name: 'C' },
        { name: 'A', url: 'new', process: ['b'] },
    ];
    transaction.state.cache.tokens.splice(0, 1);
    await journal.commit(transaction);
    assert.deepEqual(
        (await journal.load()).state.cache,
        transaction.state.cache,
    );
    transaction = await journal.load();
    transaction.state.cache = { settings: {}, subs: [] };
    await journal.commit(transaction);
    assert.deepEqual((await journal.load()).state.cache, {
        settings: {},
        subs: [],
    });
});

test('concurrent edits to separate fields of one subscription merge deterministically', async () => {
    const store = new MemoryStore();
    const journal = new BlobJournal(store);
    let initial = await journal.load();
    initial.state.cache.subs = [{ name: 'A', url: 'old', displayName: 'old' }];
    await journal.commit(initial);
    const a = await journal.load();
    const b = await journal.load();
    a.state.cache.subs[0].url = 'new';
    b.state.cache.subs[0].displayName = 'new';
    await Promise.all([journal.commit(a), journal.commit(b)]);
    assert.deepEqual((await journal.load()).state.cache.subs, [
        { name: 'A', url: 'new', displayName: 'new' },
    ]);
});

test('transient logs and downloaded resource caches do not create durable commits', async () => {
    const store = new MemoryStore();
    const journal = new BlobJournal(store);
    const transaction = await journal.load();
    transaction.state.root['sub-store-logs'] = 'private logs';
    transaction.state.root['sub-store-cached-resource'] = 'large content';
    await journal.commit(transaction);
    assert.equal(store.values.size, 0);
});

test('corrupt or missing records fail closed, rather than silently resetting data', async () => {
    const store = new MemoryStore();
    store.values.set('transactions/broken.json', { version: 5 });
    await assert.rejects(new BlobJournal(store).load(), /Invalid or missing/);
});

test('prototype-like object keys remain own data properties', async () => {
    const journal = new BlobJournal(new MemoryStore());
    const transaction = await journal.load();
    transaction.state.cache.settings = JSON.parse(
        '{"__proto__":{"polluted":true},"constructor":"data"}',
    );
    await journal.commit(transaction);
    assert.deepEqual(
        (await journal.load()).state.cache.settings,
        transaction.state.cache.settings,
    );
    assert.equal({}.polluted, undefined);
});

test("concurrent first-read defaults never erase another request's additions", async () => {
    for (const reversed of [false, true]) {
        const journal = new BlobJournal(new MemoryStore());
        const empty = await journal.load();
        const added = await journal.load();
        empty.state.cache = { settings: {}, subs: [] };
        added.state.cache = {
            settings: { theme: 'dark' },
            subs: [{ name: 'A' }],
        };
        const pair = reversed ? [empty, added] : [added, empty];
        for (const transaction of pair) await journal.commit(transaction);
        assert.deepEqual((await journal.load()).state.cache, added.state.cache);
    }
});

test('replay round-trips supported JSON shapes including type changes and empty containers', () => {
    const values = [
        null,
        true,
        7,
        'text',
        {},
        [],
        { nested: { a: 1 } },
        ['b', 'a'],
        [{ name: 'A', value: 1 }, { name: 'B' }],
    ];
    for (const before of values)
        for (const after of values) {
            const base = { cache: { value: before }, root: {} };
            const next = { cache: { value: after }, root: {} };
            assert.deepEqual(
                apply(structuredClone(base), diff(base, next)),
                next,
            );
        }
});
