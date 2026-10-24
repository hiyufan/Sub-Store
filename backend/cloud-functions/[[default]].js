import { getStore } from '@edgeone/pages-blob';
import createApplication from '../.edgeone-build/application.cjs';
import { createHandler } from '../edgeone/handler.cjs';

const app = createHandler({
    createApplication,
    storeFactory: () =>
        getStore({
            name: process.env.EDGEONE_SUB_STORE_BLOB_NAME || 'sub-store',
            consistency: 'strong',
        }),
});

export default app;
