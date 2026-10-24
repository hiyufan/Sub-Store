import 'core-js/actual/promise/with-resolvers';
import getWorkerThreads from '@/runtime/worker-threads';
import migrate from '@/utils/migration';
import serve from '@/restful';
import env from '@/utils/env';

const workerThreads = getWorkerThreads();
if (typeof workerThreads.markAsUncloneable !== 'function') {
    workerThreads.markAsUncloneable = () => {};
}

export default function createApplication() {
    if (env.meta?.node) env.meta.node.env = {};
    migrate();
    return serve({ serverless: true });
}
