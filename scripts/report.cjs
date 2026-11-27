'use strict';
const os = require('node:os');
const path = require('node:path');
const { createCollector } = require('../src/collector.cjs');
const { loadWeeklyContext } = require('../src/weekly-history.cjs');

const Usage = 'Usage: report [--home PATH] [--cache PATH] [--desktop-data PATH] [--data-dir PATH]\n'
    + 'Weekly results use saved runner reset anchors from the matching Desktop profile and log directory.';

async function main()
{
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === '--help')
    {
        process.stdout.write(Usage + '\n');
        return;
    }
    const options = {};
    for (let index = 0; index < args.length; index += 2)
    {
        const key = args[index], value = args[index + 1];
        if (!['--home', '--cache', '--desktop-data', '--data-dir'].includes(key) || !value || value.startsWith('--'))
            throw new Error(Usage);
        options[key] = path.resolve(value);
    }
    const configuredHome = path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'));
    const claudeHome = options['--home'] || configuredHome;
    const claudeData = options['--desktop-data'];
    const appData = process.env.APPDATA;
    const currentDesktop = appData && path.join(appData, 'Claude');
    const tweakRoot = process.env.CLAUDE_PLUSPLUS_USER_ROOT || appData && path.join(appData, 'claude-plusplus');
    const defaultDataDir = claudeData && currentDesktop && !path.relative(currentDesktop, claudeData)
        && !path.relative(configuredHome, claudeHome) && tweakRoot
        ? path.resolve(tweakRoot, 'tweak-data', 'com.kpk.daily-usage') : null;
    const cacheDir = options['--cache'] || path.join(claudeHome, '.daily-usage/cache');
    const collector = createCollector({ claudeHome, claudeData, cacheDir });
    try
    {
        const generatedAt = Date.now();
        const context = await loadWeeklyContext({ claudeHome, claudeData,
            dataDir: options['--data-dir'] || defaultDataDir, generatedAt });
        const { report } = await collector.scanWithContext({ ...context, generatedAt });
        process.stdout.write(JSON.stringify(report) + '\n');
    }
    finally { await collector.dispose(); }
}

main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
