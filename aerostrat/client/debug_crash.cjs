const puppeteer = require('puppeteer');

(async () => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    page.on('console', msg => console.log('CONSOLE:', msg.text()));
    page.on('pageerror', error => console.log('PAGE ERROR:', error.message));
    page.on('requestfailed', request => {
        console.log('REQUEST FAILED:', request.url(), request.failure().errorText);
    });

    console.log('Navigating to localhost:5173...');
    await page.goto('http://localhost:5173', { waitUntil: 'networkidle0', timeout: 10000 }).catch(e => console.log('Navigation timeout/error:', e.message));

    // Wait a bit just in case
    await new Promise(r => setTimeout(r, 2000));

    await browser.close();
    console.log('Done.');
})();
