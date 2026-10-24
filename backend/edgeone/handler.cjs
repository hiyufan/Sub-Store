const express = require('express');
const { BlobJournal } = require('./blob-journal.cjs');

const MAX_RESPONSE_BYTES = 6 * 1024 * 1024;

function sendError(res, status, code, message) {
    for (const header of res.getHeaderNames()) res.removeHeader(header);
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify({ status: 'failed', error: { code, message } }));
}

function dispatch(application, req, res, commit) {
    return new Promise((resolve, reject) => {
        const original = {
            write: res.write,
            end: res.end,
            writeHead: res.writeHead,
            flushHeaders: res.flushHeaders,
        };
        const chunks = [];
        let bytes = 0;
        let ended = false;
        function restore() {
            Object.assign(res, original);
        }
        function append(chunk, encoding) {
            if (chunk == null) return;
            const buffer = Buffer.isBuffer(chunk)
                ? chunk
                : Buffer.from(chunk, encoding);
            bytes += buffer.length;
            if (bytes > MAX_RESPONSE_BYTES)
                throw new Error('Cloud function response exceeds 6 MiB');
            chunks.push(buffer);
        }
        function fail(error) {
            restore();
            reject(error);
        }
        res.writeHead = function (status, reason, headers) {
            res.statusCode = status;
            if (typeof reason === 'string') res.statusMessage = reason;
            for (const [key, value] of Object.entries(
                headers || (typeof reason === 'object' ? reason : {}) || {},
            )) {
                res.setHeader(key, value);
            }
            return res;
        };
        res.flushHeaders = () => {};
        res.write = function (chunk, encoding, callback) {
            if (typeof encoding === 'function') {
                callback = encoding;
                encoding = undefined;
            }
            append(chunk, encoding);
            if (callback) queueMicrotask(callback);
            return true;
        };
        res.end = function (chunk, encoding, callback) {
            if (ended) return res;
            ended = true;
            if (typeof chunk === 'function') {
                callback = chunk;
                chunk = undefined;
            }
            if (typeof encoding === 'function') {
                callback = encoding;
                encoding = undefined;
            }
            try {
                append(chunk, encoding);
            } catch (error) {
                fail(error);
                return res;
            }
            Promise.resolve()
                .then(async () => {
                    // Failed handlers must not commit partially mutated state.
                    if (res.statusCode < 400) await commit();
                    restore();
                    res.setHeader('Cache-Control', 'no-store');
                    res.removeHeader('ETag');
                    const body = Buffer.concat(chunks);
                    original.end.call(res, body, undefined, callback);
                    resolve();
                })
                .catch(fail);
            return res;
        };
        try {
            application(req, res, (error) => {
                if (ended) return;
                if (error) {
                    ended = true;
                    fail(error);
                } else {
                    res.statusCode = 404;
                    res.end();
                }
            });
        } catch (error) {
            if (!ended) {
                ended = true;
                fail(error);
            }
        }
    });
}

function createHandler({ createApplication, storeFactory, env = process.env }) {
    const app = express();
    app.disable('x-powered-by');
    let journal;
    app.use(async (req, res) => {
        // A secret path works with the existing frontend and subscription clients.
        // It is deliberately outside SUB_STORE_*: /api/utils/env exposes those.
        const prefix = env.EDGEONE_SUB_STORE_PATH;
        if (!/^\/[A-Za-z0-9_-]{16,128}$/.test(prefix || '')) {
            sendError(
                res,
                503,
                'EDGEONE_CONFIG_REQUIRED',
                '请设置 EDGEONE_SUB_STORE_PATH：斜杠加至少16位随机字符',
            );
            return;
        }
        const pathname = req.url.split('?')[0];
        if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) {
            res.status(404).end();
            return;
        }
        req.url = req.url.slice(prefix.length) || '/';
        if (req.url.startsWith('?')) req.url = `/${req.url}`;
        try {
            journal ||= new BlobJournal(storeFactory());
            const transaction = await journal.load();
            const application = createApplication(transaction.state);
            await dispatch(application, req, res, () =>
                journal.commit(transaction),
            );
        } catch (error) {
            // SDK errors can include credentialed URLs. Expose only a fixed error.
            console.error(
                '[EdgeOne] request failed:',
                error?.code || error?.name || 'Error',
            );
            if (!res.headersSent)
                sendError(
                    res,
                    503,
                    'EDGEONE_REQUEST_FAILED',
                    '后端处理或 Blob 持久化失败，请稍后重试',
                );
            else res.destroy();
        }
    });
    return app;
}

module.exports = { createHandler };
