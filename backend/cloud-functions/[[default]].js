import { getStore } from '@edgeone/pages-blob';
import createApplication from '../.edgeone-build/application.cjs';
import frontendHtml from '../.edgeone-build/frontend-index.cjs';
import { createHandler } from '../edgeone/handler.cjs';

const app = createHandler({
    createApplication,
    frontendHtml,
    storeFactory: () =>
        getStore({
            name: process.env.EDGEONE_SUB_STORE_BLOB_NAME || 'sub-store',
            consistency: 'strong',
        }),
});

export default app;
