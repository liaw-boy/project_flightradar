// @ts-check
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
    testDir: './tests/e2e',
    timeout: 60000,
    expect: {
        timeout: 15000,
    },
    fullyParallel: false,
    retries: 1,
    workers: 1,
    reporter: [
        ['html', { outputFolder: '../pw-report', open: 'never' }],
        ['junit', { outputFile: '../pw-report/results.xml' }],
        ['list'],
    ],
    use: {
        baseURL: 'http://localhost:3005',
        screenshot: 'on',
        video: 'on-first-retry',
        trace: 'on-first-retry',
        headless: false,
        viewport: { width: 1400, height: 900 },
    },
    outputDir: '../pw-screenshots/artifacts',
    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
