#!/usr/bin/env node
/**
 * API Stress & Feeder Endpoint Tester
 * Tests: adsb.lol (rate), airplanes.live (field name), adsb.fi snapshot, re-api
 */
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const LAT = 25.04, LON = 121.53;
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', red: '\x1b[31m', yellow: '\x1b[33m',
  cyan: '\x1b[36m', magenta: '\x1b[35m',
};
const hdr = s => `\n${C.bold}${C.cyan}${'═'.repeat(52)}\n  ${s}\n${'═'.repeat(52)}${C.reset}`;
const ok  = s => `  ${C.green}✓${C.reset} ${s}`;
const bad = s => `  ${C.red}✗${C.reset} ${s}`;
const inf = s => `  ${C.yellow}→${C.reset} ${s}`;

async function GET(url, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'AEROSTRAT-Test/1.0' } });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch {}
    return { ok: r.ok, status: r.status, ms: Date.now() - t0, json, raw: text.slice(0, 150) };
  } catch(e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: e.message };
  } finally { clearTimeout(t); }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════
// 測試 A — adsb.lol 全球端點速率壓力
// ═══════════════════════════════════════════════════════
async function testA_AdsbLolRate() {
  console.log(hdr('測試 A — adsb.lol 全球端點速率'));
  const url = 'https://api.adsb.lol/v2/lat/0/lon/0/dist/99999';
  const intervals = [3000, 2000, 1000]; // ms between calls

  for (const interval of intervals) {
    console.log(inf(`間隔 ${interval}ms × 5 次`));
    let ok429 = false;
    for (let i = 0; i < 5; i++) {
      const r = await GET(url);
      const count = r.json?.ac?.length ?? '?';
      const status = r.status === 429 ? `${C.red}429${C.reset}` : `${C.green}${r.status}${C.reset}`;
      console.log(`    call${i+1}: HTTP ${status} | ${count} ac | ${r.ms}ms`);
      if (r.status === 429) { ok429 = true; break; }
      if (i < 4) await sleep(interval);
    }
    if (ok429) { console.log(bad(`429 在 ${interval}ms 間隔觸發 → 速率上限已達`)); break; }
    else console.log(ok(`${interval}ms 間隔全部通過`));
    await sleep(2000);
  }
}

// ═══════════════════════════════════════════════════════
// 測試 B — airplanes.live 回傳欄位名稱確認
// ═══════════════════════════════════════════════════════
async function testB_AirplanesLiveFields() {
  console.log(hdr('測試 B — airplanes.live 欄位名稱 + 端點清單'));

  const endpoints = [
    { name: '/v2/mil  (全球軍機)',  url: 'https://api.airplanes.live/v2/mil' },
    { name: '/v2/ladd (隱私標記)',  url: 'https://api.airplanes.live/v2/ladd' },
    { name: '/v2/pia  (PIA 標記)', url: 'https://api.airplanes.live/v2/pia' },
    { name: '/v2/point(台灣135nm)',url: `https://api.airplanes.live/v2/point/${LAT}/${LON}/135` },
  ];

  for (const ep of endpoints) {
    const r = await GET(ep.url);
    if (!r.ok) {
      console.log(bad(`${ep.name}: HTTP ${r.status} — ${r.error || r.raw}`));
      await sleep(1100);
      continue;
    }
    const topKeys = Object.keys(r.json || {}).join(', ');
    const hasAc = r.json?.ac !== undefined;
    const hasAircraft = r.json?.aircraft !== undefined;
    const count = (r.json?.ac || r.json?.aircraft || []).length;
    const fieldKey = hasAc ? `${C.green}"ac"${C.reset}` : hasAircraft ? `${C.red}"aircraft"${C.reset}` : `${C.yellow}?${C.reset}`;
    console.log(ok(`${ep.name}: ${count} 架 | top keys: ${topKeys} | array key: ${fieldKey} | ${r.ms}ms`));
    if (count > 0) {
      const sample = (r.json?.ac || r.json?.aircraft || [])[0];
      const hasDesc = !!sample?.desc;
      const hasOwnOp = !!sample?.ownOp;
      const hasYear = !!sample?.year;
      console.log(`     sample extra fields: desc=${hasDesc} ownOp=${hasOwnOp} year=${hasYear}`);
    }
    await sleep(1100);
  }
}

// ═══════════════════════════════════════════════════════
// 測試 C — adsb.fi feeder-only /v2/snapshot
// ═══════════════════════════════════════════════════════
async function testC_AdsbFiSnapshot() {
  console.log(hdr('測試 C — adsb.fi feeder 端點 (IP 白名單)'));

  const urls = [
    'https://opendata.adsb.fi/v2/snapshot',
    'https://opendata.adsb.fi/api/v2/snapshot',
  ];

  for (const url of urls) {
    console.log(inf(`GET ${url}`));
    const r = await GET(url, 15000);
    if (r.ok) {
      const count = (r.json?.ac || r.json?.aircraft || []).length;
      console.log(ok(`${C.bold}可存取！${C.reset} ${count} 架 | ${r.ms}ms`));
      console.log(`  top keys: ${Object.keys(r.json || {}).join(', ')}`);
    } else {
      const msg = r.status === 403 ? '403 Forbidden（IP 未列白名單）'
                : r.status === 401 ? '401 未授權'
                : r.status === 404 ? '404 端點不存在'
                : `HTTP ${r.status} — ${r.error || r.raw}`;
      console.log(bad(msg));
    }
    await sleep(1000);
  }
}

// ═══════════════════════════════════════════════════════
// 測試 D — re-api.adsb.lol (feeder IP 白名單)
// ═══════════════════════════════════════════════════════
async function testD_ReApi() {
  console.log(hdr('測試 D — re-api.adsb.lol (feeder IP 白名單)'));

  const urls = [
    `https://re-api.adsb.lol?circle=${LAT},${LON},500`,
    `https://re-api.adsb.lol?circle=${LAT},${LON},250`,
    'https://re-api.adsb.lol',
  ];

  for (const url of urls) {
    console.log(inf(`GET ${url}`));
    const r = await GET(url, 12000);
    if (r.ok) {
      const arr = r.json?.ac || r.json?.aircraft || r.json?.states || [];
      const count = Array.isArray(arr) ? arr.length : '?';
      console.log(ok(`${C.bold}可存取！${C.reset} ${count} 架 | ${r.ms}ms`));
      console.log(`  top keys: ${Object.keys(r.json || {}).join(', ')}`);
    } else {
      const msg = r.status === 403 ? '403 Forbidden（IP 未列白名單）'
                : r.status === 401 ? '401 未授權'
                : r.status === 404 ? '404 端點不存在'
                : `HTTP ${r.status} — ${r.error || r.raw}`;
      console.log(bad(msg));
    }
    await sleep(1000);
  }
}

// ═══════════════════════════════════════════════════════
// 測試 E — OpenSky OAuth2 vs Basic Auth
// ═══════════════════════════════════════════════════════
async function testE_OpenSkyAuth() {
  console.log(hdr('測試 E — OpenSky 認證狀態'));

  const user = process.env.OPENSKY_USER || process.env.OPENSKY_USER1 || '';
  const pass = process.env.OPENSKY_PASS || process.env.OPENSKY_PASS1 || '';
  const basicHeader = user ? 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64') : null;

  // a) Basic Auth（舊式）
  console.log(inf('Basic Auth 測試（應失效）'));
  const r1 = await GET('https://opensky-network.org/api/states/all?lamin=21&lomin=119&lamax=27&lomax=124');
  console.log(`  無認證: HTTP ${r1.status} | ${r1.json?.states?.length ?? '?'} ac`);

  if (basicHeader) {
    const r2 = await fetch('https://opensky-network.org/api/states/all?lamin=21&lomin=119&lamax=27&lomax=124', {
      headers: { Authorization: basicHeader }, signal: AbortSignal.timeout(10000)
    });
    const j2 = await r2.json().catch(() => null);
    const count = j2?.states?.length ?? '?';
    const verdict = r2.status === 401 ? `${C.red}401 Basic Auth 已失效${C.reset}`
                  : r2.ok ? `${C.green}${r2.status} 仍有效 (${count} ac)${C.reset}`
                  : `${C.yellow}HTTP ${r2.status}${C.reset}`;
    console.log(`  Basic Auth (${user}): ${verdict}`);
  }

  // b) /states/own（自己的天線，免費）
  console.log(inf('/states/own 測試（feeder 免費端點）'));
  const r3 = await GET('https://opensky-network.org/api/states/own');
  const count3 = r3.json?.states?.length ?? '?';
  console.log(`  /states/own: HTTP ${r3.status} | ${count3} ac | ${r3.ms}ms`);
  if (basicHeader && !r3.ok) {
    const r4 = await fetch('https://opensky-network.org/api/states/own', {
      headers: { Authorization: basicHeader }, signal: AbortSignal.timeout(10000)
    });
    const j4 = await r4.json().catch(() => null);
    console.log(`  /states/own (auth): HTTP ${r4.status} | ${j4?.states?.length ?? '?'} ac`);
  }
}

// ═══════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════
(async () => {
  console.log(`${C.bold}${C.magenta}
╔═══════════════════════════════════════════════════╗
║  AEROSTRAT — 完整 API 壓力 + Feeder 端點測試     ║
╚═══════════════════════════════════════════════════╝${C.reset}`);

  await testA_AdsbLolRate();
  await testB_AirplanesLiveFields();
  await testC_AdsbFiSnapshot();
  await testD_ReApi();
  await testE_OpenSkyAuth();

  console.log(`\n${C.bold}${C.green}全部測試完成。${C.reset}\n`);
})();
