const { randomUUID } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');

const PREFIX = 'transactions/';
const TRANSIENT_ROOT_KEYS = new Set([
    'sub-store',
    'sub-store-logs',
    'sub-store-cached-resource',
    'sub-store-cached-headers-resource',
    'sub-store-cached-script-resource',
]);
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function put(value, key, data) {
    Object.defineProperty(value, key, {
        value: data,
        writable: true,
        enumerable: true,
        configurable: true,
    });
}

function durableState(state) {
    const result = clone({ cache: state.cache, root: state.root });
    if (!object(result.cache) || !object(result.root))
        throw new Error('Invalid Sub-Store state');
    for (const key of TRANSIENT_ROOT_KEYS) delete result.root[key];
    return result;
}

function identity(before, after) {
    // Token names may repeat; prefer the token itself over the display name.
    for (const field of ['token', 'name', 'id']) {
        if (
            [before, after].every(
                (items) =>
                    items.every(
                        (item) =>
                            object(item) && typeof item[field] === 'string',
                    ) &&
                    new Set(items.map((item) => item[field])).size ===
                        items.length,
            )
        )
            return field;
    }
}

function diff(before, after, path = [], changes = []) {
    if (isDeepStrictEqual(before, after)) return changes;
    if (object(after) && (object(before) || before === undefined)) {
        const missing = before === undefined;
        before = before || {};
        for (const key of Object.keys(before)) {
            if (!own(after, key))
                changes.push({ op: 'delete', path: [...path, key] });
        }
        // Preserve empty objects too, such as an initially empty settings object.
        if (!Object.keys(after).length && missing) {
            changes.push({ op: 'ensure', path, value: {} });
        } else {
            for (const key of Object.keys(after))
                diff(
                    own(before, key) ? before[key] : undefined,
                    after[key],
                    [...path, key],
                    changes,
                );
        }
        return changes;
    }
    if (
        Array.isArray(after) &&
        (Array.isArray(before) || before === undefined)
    ) {
        if (before === undefined && !after.length) {
            changes.push({ op: 'ensure', path, value: [] });
            return changes;
        }
        before = before || [];
        const field = identity(before, after);
        if (field && (before.length || after.length)) {
            const previous = new Map(before.map((item) => [item[field], item]));
            const next = new Map(after.map((item) => [item[field], item]));
            for (const key of previous.keys()) {
                if (!next.has(key))
                    changes.push({
                        op: 'delete',
                        path: [...path, { field, key }],
                    });
            }
            for (const [key, value] of next)
                diff(
                    previous.get(key),
                    value,
                    [...path, { field, key }],
                    changes,
                );
            // Preserve explicit sorting; unknown concurrent additions remain present.
            changes.push({ op: 'order', path, field, keys: [...next.keys()] });
            return changes;
        }
    }
    changes.push({ op: 'set', path, value: clone(after) });
    return changes;
}

function member(container, segment, create, next) {
    if (typeof segment === 'string') {
        if (!object(container)) throw new Error('Invalid journal object path');
        const existed = own(container, segment);
        if (!existed && create)
            put(container, segment, typeof next === 'object' ? [] : {});
        return [container, segment, existed];
    }
    if (
        !Array.isArray(container) ||
        !['name', 'token', 'id'].includes(segment?.field) ||
        typeof segment.key !== 'string'
    ) {
        throw new Error('Invalid journal array path');
    }
    let index = container.findIndex(
        (item) => item?.[segment.field] === segment.key,
    );
    const existed = index >= 0;
    if (index < 0 && create) {
        index = container.length;
        const item = {};
        put(item, segment.field, segment.key);
        container.push(item);
    }
    return [container, index, existed];
}

function apply(state, changes) {
    for (const change of changes) {
        const { path, op } = change;
        if (
            !Array.isArray(path) ||
            !['cache', 'root'].includes(path[0]) ||
            !['set', 'ensure', 'delete', 'order'].includes(op)
        ) {
            throw new Error('Invalid journal operation');
        }
        let value = state;
        let target;
        for (let i = 0; i < path.length; i++) {
            target = member(value, path[i], op !== 'delete', path[i + 1]);
            if (target[1] === -1 || !own(target[0], target[1])) {
                target = null;
                break;
            }
            if (i < path.length - 1) {
                const needsArray = typeof path[i + 1] === 'object';
                const child = target[0][target[1]];
                if (needsArray ? !Array.isArray(child) : !object(child)) {
                    if (op === 'delete') {
                        target = null;
                        break;
                    }
                    put(target[0], target[1], needsArray ? [] : {});
                }
                value = target[0][target[1]];
            }
        }
        if (!target) continue;
        const [parent, key] = target;
        if (op === 'set') put(parent, key, clone(change.value));
        else if (op === 'ensure') {
            if (!target[2]) put(parent, key, clone(change.value));
        } else if (op === 'delete') {
            if (Array.isArray(parent)) parent.splice(key, 1);
            else delete parent[key];
        } else {
            const items = parent[key];
            if (!Array.isArray(change.keys))
                throw new Error('Invalid journal order');
            if (!Array.isArray(items)) continue;
            const ranks = new Map(change.keys.map((id, index) => [id, index]));
            items.sort(
                (a, b) =>
                    (ranks.get(a[change.field]) ?? Infinity) -
                    (ranks.get(b[change.field]) ?? Infinity),
            );
        }
    }
    return state;
}

class BlobJournal {
    constructor(store) {
        this.store = store;
        this.records = new Map();
    }

    async load() {
        const { blobs } = await this.store.list({
            prefix: PREFIX,
            consistency: 'strong',
        });
        const records = [];
        // Bounded parallel reads; immutable entries can be reused on warm instances.
        for (let i = 0; i < blobs.length; i += 16) {
            const batch = await Promise.all(
                blobs.slice(i, i + 16).map(async ({ key, etag }) => {
                    const cached = this.records.get(key);
                    if (cached && cached.etag === etag) return cached.record;
                    const record = await this.store.get(key, {
                        type: 'json',
                        consistency: 'strong',
                    });
                    if (
                        !record ||
                        record.version !== 1 ||
                        !Number.isSafeInteger(record.clock) ||
                        record.clock < 1 ||
                        !Array.isArray(record.changes) ||
                        key !== `${PREFIX}${record.id}.json`
                    ) {
                        throw new Error(
                            'Invalid or missing Blob transaction; refusing to reset data',
                        );
                    }
                    this.records.set(key, { etag, record });
                    return record;
                }),
            );
            records.push(...batch);
        }
        records.sort(
            (a, b) =>
                a.clock - b.clock || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
        );
        const state = { cache: {}, root: {} };
        for (const record of records) apply(state, record.changes);
        return { state, clock: records.at(-1)?.clock || 0, base: clone(state) };
    }

    async commit(transaction) {
        const state = durableState(transaction.state);
        const changes = diff(transaction.base, state);
        if (!changes.length) return;
        const record = {
            version: 1,
            id: randomUUID(),
            clock: transaction.clock + 1,
            changes,
        };
        // No shared head object, lock or unsupported onlyIfNew condition.
        await this.store.setJSON(`${PREFIX}${record.id}.json`, record, {
            cacheControl: 'no-store',
        });
    }
}

module.exports = { BlobJournal, diff, apply, durableState };
