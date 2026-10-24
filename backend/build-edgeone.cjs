const fs = require('node:fs/promises');
const path = require('node:path');
const { build } = require('esbuild');

async function main() {
    const result = await build({
        absWorkingDir: __dirname,
        entryPoints: ['src/edgeone/application.js'],
        bundle: true,
        write: false,
        platform: 'node',
        target: 'node20',
        format: 'cjs',
        // Node 20 cloud runtime differs from the build machine's Node version.
        alias: { undici: 'undici-edgeone' },
        logOverride: { 'direct-eval': 'silent' },
        plugins: [
            {
                name: 'edgeone-request-state',
                setup(builder) {
                    builder.onResolve({ filter: /^@\/core\/app$/ }, () => ({
                        path: path.join(__dirname, 'src/edgeone/core-app.js'),
                    }));
                    builder.onResolve(
                        { filter: /^sub-store:edgeone-context$/ },
                        () => ({ path: 'context', namespace: 'edgeone' }),
                    );
                    builder.onLoad(
                        { filter: /.*/, namespace: 'edgeone' },
                        () => ({
                            contents: 'export const state = __edgeoneState;',
                            loader: 'js',
                        }),
                    );
                    builder.onLoad(
                        { filter: /\.js$/ },
                        async ({ path: filename }) => {
                            if (
                                !filename.startsWith(
                                    path.join(__dirname, 'src') + path.sep,
                                )
                            )
                                return;
                            let contents = await fs.readFile(filename, 'utf8');
                            // These boundaries are intentional for proxy-app builds. Here
                            // they must be visible to the Node dependency bundler.
                            contents = contents.replace(
                                /eval\((['"`])(require\((['"`]).*?\3\))\1\)/g,
                                '$2',
                            );
                            contents = contents.replace(
                                `eval('import("shoutrrr-ts")')`,
                                'import("shoutrrr-ts")',
                            );
                            return {
                                contents,
                                loader: 'js',
                                resolveDir: path.dirname(filename),
                            };
                        },
                    );
                },
            },
        ],
    });
    const directory = path.join(__dirname, '.edgeone-build');
    await fs.mkdir(directory, { recursive: true });
    // Execute the already compiled code with fresh module state for each request.
    // No VM, runtime eval, global singleton cache, or local data file is required.
    const factory = `module.exports = function(__edgeoneState) {\nconst module = { exports: {} };\nconst exports = module.exports;\n${result.outputFiles[0].text}\nreturn module.exports.default();\n};\n`;
    await fs.writeFile(path.join(directory, 'application.cjs'), factory);
    console.log(
        'EdgeOne application built; static output: edgeone-public, functions: cloud-functions',
    );
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
