'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const framework = process.env.CLAUDE_PLUSPLUS_SOURCE || path.resolve(root, '../claude-plusplus');
async function main() {
    const command = process.argv[2];
    if (command === 'dev') {
        const file = path.join(framework, 'packages/installer/dist/commands/dev-tweak.js');
        const { devTweak } = await import(pathToFileURL(file).href);
        await devTweak(root, { watch: false });
        return;
    }
    if (command !== 'validate-tweak') throw new Error('Expected validate-tweak or dev');
    const result = spawnSync(process.execPath, [path.join(framework, 'bin/claudeplusplus.js'), command, root],
        { cwd: root, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
