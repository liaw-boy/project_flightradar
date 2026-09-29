'use strict';
/**
 * AEROSTRAT — Scheduled test runner (systemd timer entry point).
 *
 * Runs one of the project's existing test suites and, on failure only,
 * posts a Discord alert via the same notifyDiscord infra used by the
 * nightly retrain job and the real-time outage alert — no new alerting
 * mechanism, just a new caller of the existing one.
 *
 * Modes:
 *   node run_scheduled_check.js e2e    → client/tests/e2e/prod_smoke.spec.js
 *                                        (Playwright, against the public
 *                                        production URL)
 *   node run_scheduled_check.js load   → backend `npm run test:smoke`
 *                                        (api + stress + user-journey jest
 *                                        suites, against localhost:3000 —
 *                                        this IS the production process,
 *                                        there is no separate load-test
 *                                        target)
 *
 * Exits with the child's exit code, so `systemctl status` / `journalctl`
 * for the timer's service unit also reflects pass/fail on their own,
 * independent of whether the Discord post itself succeeds.
 */
require('../config'); // loads backend/.env via dotenv — same as server.js
const path = require('path');
const { spawn } = require('child_process');
const logger = require('../logger');
const { notifyDiscord } = require('../services/discordNotifier');

const PROJECT_ROOT = path.join(__dirname, '..', '..');
const MODE = process.argv[2];

const MODES = {
    e2e: {
        label: 'E2E smoke test (prod_smoke.spec.js)',
        cwd: path.join(PROJECT_ROOT, 'client'),
        cmd: 'npx',
        args: ['playwright', 'test', '--config=playwright.prod.config.js'],
    },
    load: {
        label: 'Load/stability test (npm run test:smoke)',
        cwd: path.join(PROJECT_ROOT, 'backend'),
        cmd: 'npm',
        args: ['run', 'test:smoke'],
    },
};

// Discord embed description is capped at 4096 chars; keep well under that
// and favor the *tail* of the output, where the actual failing assertion
// (not setup/navigation noise) almost always ends up.
const OUTPUT_TAIL_CHARS = 1500;

function runSuite({ cwd, cmd, args }) {
    return new Promise((resolve) => {
        const child = spawn(cmd, args, { cwd, env: process.env });
        let output = '';
        child.stdout.on('data', (d) => { output += d.toString(); });
        child.stderr.on('data', (d) => { output += d.toString(); });
        child.on('close', (code) => resolve({ code, output }));
        child.on('error', (err) => resolve({ code: -1, output: `${output}\n[spawn error] ${err.message}` }));
    });
}

(async () => {
    const suite = MODES[MODE];
    if (!suite) {
        console.error(`Usage: node run_scheduled_check.js <${Object.keys(MODES).join('|')}>`);
        process.exit(2);
    }

    logger.info('SCHEDULED_CHECK', `Starting: ${suite.label}`);
    const { code, output } = await runSuite(suite);

    if (code === 0) {
        logger.info('SCHEDULED_CHECK', `Passed: ${suite.label}`);
        process.exit(0);
    }

    logger.error('SCHEDULED_CHECK', `FAILED (exit ${code}): ${suite.label}`, { tail: output.slice(-OUTPUT_TAIL_CHARS) });

    const tail = output.trim().slice(-OUTPUT_TAIL_CHARS) || '(no output captured)';
    await notifyDiscord({
        icon: 'outageDown',
        color: 'red',
        title: `🔴 Scheduled test failed: ${suite.label}`,
        description: `Exit code ${code}. Last ${tail.length} chars of output:\n\`\`\`\n${tail}\n\`\`\``,
    }, 'DISCORD_OUTAGE_WEBHOOK_URL');

    process.exit(code);
})();
