import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

const SCREENSHOT_DIR = '/tmp/aerostrat_test';
const consoleErrors = [];
const mainAppErrors = [];

async function run() {
  const browser = await chromium.launch({ headless: true });

  // ─── TASK 1: Monitor page before login ───────────────────────────
  console.log('\n=== TASK 1: Open /monitor ===');
  const ctx1 = await browser.newContext();
  const page1 = await ctx1.newPage();

  page1.on('console', msg => {
    const text = `[${msg.type()}] ${msg.text()}`;
    if (msg.type() === 'error') {
      consoleErrors.push(text);
      console.log('CONSOLE ERROR:', text);
    }
  });
  page1.on('pageerror', err => {
    const text = `[pageerror] ${err.message}`;
    consoleErrors.push(text);
    console.log('PAGE ERROR:', text);
  });

  await page1.goto('http://localhost:3000/monitor', { waitUntil: 'networkidle' });
  await page1.screenshot({ path: `${SCREENSHOT_DIR}/01_monitor_page.png`, fullPage: true });
  console.log('Screenshot saved: 01_monitor_page.png');
  console.log('Page title:', await page1.title());
  console.log('Page URL:', page1.url());

  // ─── TASK 2: Login ───────────────────────────────────────────────
  console.log('\n=== TASK 2: Login ===');

  // Check if there's a login form
  const passwordInput = await page1.$('input[type="password"]');
  const textInput = await page1.$('input[type="text"]');
  const anyInput = await page1.$('input');

  console.log('Password input found:', !!passwordInput);
  console.log('Text input found:', !!textInput);
  console.log('Any input found:', !!anyInput);

  if (anyInput) {
    // Get all inputs info
    const inputs = await page1.$$('input');
    for (const inp of inputs) {
      const type = await inp.getAttribute('type');
      const name = await inp.getAttribute('name');
      const placeholder = await inp.getAttribute('placeholder');
      console.log(`  Input: type=${type} name=${name} placeholder=${placeholder}`);
    }
  }

  let loginSuccess = false;

  if (passwordInput) {
    await passwordInput.fill('liawboy0325');
    const submitBtn = await page1.$('button[type="submit"], input[type="submit"], button');
    if (submitBtn) {
      await submitBtn.click();
      await page1.waitForLoadState('networkidle');
      loginSuccess = true;
    }
  } else if (textInput) {
    await textInput.fill('liawboy0325');
    const submitBtn = await page1.$('button[type="submit"], input[type="submit"], button');
    if (submitBtn) {
      await submitBtn.click();
      await page1.waitForLoadState('networkidle');
      loginSuccess = true;
    }
  } else {
    // Try direct POST
    console.log('No form found, trying fetch POST to /monitor/login...');
    const resp = await page1.evaluate(async () => {
      try {
        const r = await fetch('/monitor/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: 'password=liawboy0325',
          redirect: 'follow',
          credentials: 'include'
        });
        return { status: r.status, url: r.url, ok: r.ok };
      } catch(e) {
        return { error: e.message };
      }
    });
    console.log('POST result:', JSON.stringify(resp));

    // Navigate back to monitor after post
    await page1.goto('http://localhost:3000/monitor', { waitUntil: 'networkidle' });
    loginSuccess = true;
  }

  await page1.screenshot({ path: `${SCREENSHOT_DIR}/02_after_login.png`, fullPage: true });
  console.log('Screenshot saved: 02_after_login.png');
  console.log('After login URL:', page1.url());
  console.log('After login title:', await page1.title());

  // ─── TASK 3: Navigate to Users section ───────────────────────────
  console.log('\n=== TASK 3: Navigate to Users section ===');

  // Look for Users link/tab
  const usersLink = await page1.$('a[href*="user"], a:has-text("User"), button:has-text("User"), [data-section="users"]');
  if (usersLink) {
    console.log('Found Users link, clicking...');
    await usersLink.click();
    await page1.waitForLoadState('networkidle');
  } else {
    // Try navigating directly
    const currentUrl = page1.url();
    console.log('No Users link found on current page. Current URL:', currentUrl);

    // Try /monitor/users or similar
    await page1.goto('http://localhost:3000/monitor/users', { waitUntil: 'networkidle' });
    const u = page1.url();
    console.log('After goto /monitor/users:', u);

    if (u.includes('login') || u.includes('monitor') === false) {
      // Maybe users is a tab/section within monitor
      await page1.goto('http://localhost:3000/monitor', { waitUntil: 'networkidle' });

      // Look for any navigation items
      const navItems = await page1.$$('nav a, .nav a, .sidebar a, .menu a, [role="tab"]');
      console.log(`Found ${navItems.length} nav items`);
      for (const item of navItems) {
        const text = await item.textContent();
        const href = await item.getAttribute('href');
        console.log(`  Nav item: "${text?.trim()}" href="${href}"`);
      }

      // Try clicking Users tab
      const userTab = await page1.$('text=Users');
      if (userTab) {
        await userTab.click();
        await page1.waitForTimeout(1000);
      }
    }
  }

  await page1.screenshot({ path: `${SCREENSHOT_DIR}/03_users_section.png`, fullPage: true });
  console.log('Screenshot saved: 03_users_section.png');

  // ─── TASK 4: Verify users table ──────────────────────────────────
  console.log('\n=== TASK 4: Verify users table ===');

  // Get full page text to understand structure
  const pageText = await page1.evaluate(() => document.body.innerText);
  console.log('Page text (first 2000 chars):\n', pageText.substring(0, 2000));

  // Check for specific users
  const hasLiawboy = pageText.includes('liawboy');
  const hasLiaocho = pageText.includes('liaocho');
  const hasSuperadmin = pageText.includes('Superadmin') || pageText.includes('⭐');
  const hasRemoveAdmin = pageText.includes('Remove Admin');
  const hasMakeAdmin = pageText.includes('Make Admin');

  console.log('liawboy found:', hasLiawboy);
  console.log('liaocho found:', hasLiaocho);
  console.log('Superadmin/⭐ found:', hasSuperadmin);
  console.log('"Remove Admin" button found:', hasRemoveAdmin);
  console.log('"Make Admin" button found:', hasMakeAdmin);

  // Try to find the users table specifically
  const tables = await page1.$$('table');
  console.log(`Found ${tables.length} tables`);

  // Check for Remove Admin button for liaocho
  let removeAdminButtonVisible = false;
  const allButtons = await page1.$$('button');
  console.log(`Total buttons on page: ${allButtons.length}`);
  for (const btn of allButtons) {
    const text = await btn.textContent();
    const isVisible = await btn.isVisible();
    if (text?.includes('Admin') || text?.includes('admin')) {
      console.log(`  Button: "${text?.trim()}" visible=${isVisible}`);
      if (text?.includes('Remove') && isVisible) {
        removeAdminButtonVisible = true;
      }
    }
  }

  // Check liawboy row has no buttons
  const liawboyRow = await page1.$('tr:has-text("liawboy")');
  if (liawboyRow) {
    const rowButtons = await liawboyRow.$$('button');
    console.log(`Buttons in liawboy row: ${rowButtons.length}`);
  }

  // Check liaocho row
  const liaochoRow = await page1.$('tr:has-text("liaocho")');
  if (liaochoRow) {
    const rowButtons = await liaochoRow.$$('button');
    console.log(`Buttons in liaocho row: ${rowButtons.length}`);
    for (const btn of rowButtons) {
      const text = await btn.textContent();
      console.log(`  liaocho row button: "${text?.trim()}"`);
    }
  }

  // ─── TASK 5: Main app - console errors ───────────────────────────
  console.log('\n=== TASK 5: Main app http://localhost:3000/ ===');
  const ctx2 = await browser.newContext();
  const page2 = await ctx2.newPage();

  page2.on('console', msg => {
    const text = msg.text();
    const entry = `[${msg.type()}] ${text}`;
    mainAppErrors.push(entry);
    if (msg.type() === 'error' || msg.type() === 'warning') {
      console.log('MAIN CONSOLE:', entry);
    }
  });
  page2.on('pageerror', err => {
    const text = `[pageerror] ${err.message}`;
    mainAppErrors.push(text);
    console.log('MAIN PAGE ERROR:', text);
  });

  // Track websocket and network
  const wsMessages = [];
  page2.on('websocket', ws => {
    console.log('WebSocket opened:', ws.url());
    wsMessages.push({ event: 'open', url: ws.url() });
    ws.on('framereceived', frame => {
      wsMessages.push({ event: 'received', data: frame.payload?.toString()?.substring(0, 100) });
    });
    ws.on('framesent', frame => {
      wsMessages.push({ event: 'sent', data: frame.payload?.toString()?.substring(0, 100) });
    });
    ws.on('close', () => {
      console.log('WebSocket closed');
      wsMessages.push({ event: 'close' });
    });
  });

  await page2.goto('http://localhost:3000/', { waitUntil: 'load' });
  await page2.screenshot({ path: `${SCREENSHOT_DIR}/04_main_app.png`, fullPage: true });
  console.log('Screenshot saved: 04_main_app.png');

  // ─── TASK 6: Wait 10 seconds, check WS ───────────────────────────
  console.log('\n=== TASK 6: Waiting 10 seconds for WebSocket... ===');
  await page2.waitForTimeout(10000);

  await page2.screenshot({ path: `${SCREENSHOT_DIR}/05_main_app_10s.png`, fullPage: true });
  console.log('Screenshot saved: 05_main_app_10s.png');

  // Check for WS_CONNECTED in console logs
  const wsConnected = mainAppErrors.some(e => e.includes('WS_CONNECTED') || e.includes('WebSocket') || e.includes('ws'));
  console.log('WS_CONNECTED in console:', wsConnected);
  console.log('WebSocket events:', JSON.stringify(wsMessages, null, 2));

  // ─── FINAL REPORT ─────────────────────────────────────────────────
  console.log('\n\n========== FINAL REPORT ==========\n');

  console.log('--- Monitor Console Errors ---');
  if (consoleErrors.length === 0) {
    console.log('  (none)');
  } else {
    consoleErrors.forEach(e => console.log(' ', e));
  }

  console.log('\n--- Main App Console Errors (ALL) ---');
  const errors = mainAppErrors.filter(e => e.startsWith('[error]') || e.startsWith('[pageerror]'));
  if (errors.length === 0) {
    console.log('  (no errors)');
  } else {
    errors.forEach(e => console.log(' ', e));
  }

  console.log('\n--- Buffer Error Status ---');
  const bufferError = mainAppErrors.find(e => e.includes('Buffer') || e.includes("properties of undefined"));
  if (bufferError) {
    console.log('  PRESENT:', bufferError);
  } else {
    console.log('  NOT FOUND - Buffer error appears to be GONE');
  }

  console.log('\n--- _leaflet_pos errors ---');
  const leafletErrors = mainAppErrors.filter(e => e.includes('_leaflet_pos'));
  if (leafletErrors.length === 0) {
    console.log('  (none found)');
  } else {
    leafletErrors.forEach(e => console.log(' ', e));
  }

  console.log('\n--- Remove Admin Button for liaocho ---');
  console.log('  Visible:', removeAdminButtonVisible);

  console.log('\n--- WebSocket Connection ---');
  if (wsMessages.length > 0) {
    console.log('  WebSocket events detected:');
    wsMessages.forEach(m => console.log('   ', JSON.stringify(m)));
  } else {
    console.log('  No WebSocket events detected in 10 seconds');
  }

  // Save all console messages to file
  writeFileSync(`${SCREENSHOT_DIR}/console_log.txt`,
    '=== MONITOR PAGE ERRORS ===\n' + consoleErrors.join('\n') +
    '\n\n=== MAIN APP ALL CONSOLE ===\n' + mainAppErrors.join('\n')
  );
  console.log('\nFull console log saved to /tmp/aerostrat_test/console_log.txt');

  await browser.close();
}

run().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
