// @ts-check
/**
 * Playwright config for production smoke tests against https://flyradar.spkuan.cc
 * Runs headless; does NOT use localhost baseURL.
 */
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    testMatch: '**/prod_smoke.spec.js',
    timeout: 60000,
    expect: {
        timeout: 20000,
    },
    fullyParallel: false,
    retries: 1,
    workers: 1,
    reporter: [
        ['list'],
        ['html', { outputFolder: '/home/lbw/project_aerostrat/client/pw-screenshots/prod-run/report', open: 'never' }],
    ],
    use: {
        baseURL: 'https://flyradar.spkuan.cc',
        screenshot: 'on',
        video: 'off',
        trace: 'on-first-retry',
        headless: true,
        viewport: { width: 1400, height: 900 },
    },
    outputDir: '/home/lbw/project_aerostrat/client/pw-screenshots/prod-run/artifacts',
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
