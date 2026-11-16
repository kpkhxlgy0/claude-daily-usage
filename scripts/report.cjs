'use strict';
const os = require('node:os');
const path = require('node:path');
const { createCollector } = require('../src/collector.cjs');
async function main() {
    const options = {};
    for (let index = 2; index < process.argv.length; index += 2) {
        const key = process.argv[index], value = process.argv[index + 1];
        if (!['--home', '--cache'].includes(key) || !value) throw new Error('Usage: report [--home PATH] [--cache PATH]');
        options[key] = path.resolve(value);
    }
    const claudeHome = options['--home'] || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    const collector = createCollector({ claudeHome, cacheDir: options['--cache'] || path.join(claudeHome, '.daily-usage/cache') });
    try { process.stdout.write(JSON.stringify(await collector.scan()) + '\n'); }
    finally { await collector.dispose(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
