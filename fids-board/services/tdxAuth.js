const AUTH_URL = "https://tdx.transportdata.tw/auth/realms/TDXConnect/protocol/openid-connect/token";

let cachedToken = null;
let cachedExpiry = 0; // epoch ms

// Rejected credentials (400/401) never fix themselves, and TDX suspends
// clients that hammer it. The poller used to retry the login every ~13s
// after 2026-09-03 — ~114k failed logins over three weeks, no alert, no data.
// Back off exponentially (10 min .. 6 h) and fail fast during the pause.
const AUTH_BACKOFF_MIN_MS = 10 * 60 * 1000;
const AUTH_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000;
let authFailures = 0;
let authBlockedUntil = 0;

async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < cachedExpiry - 5 * 60 * 1000) {
    return cachedToken;
  }
  if (now < authBlockedUntil) {
    const mins = Math.ceil((authBlockedUntil - now) / 60000);
    throw new Error(`TDX 認證暫停重試中（連續失敗 ${authFailures} 次，還剩 ${mins} 分鐘）`);
  }

  const clientId = process.env.TDX_CLIENT_ID;
  const clientSecret = process.env.TDX_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("TDX_CLIENT_ID / TDX_CLIENT_SECRET 未設定");
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });

  const res = await fetch(AUTH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const text = await res.text();
    if (res.status === 400 || res.status === 401) {
      authFailures++;
      const backoff = Math.min(AUTH_BACKOFF_MIN_MS * 2 ** (authFailures - 1), AUTH_BACKOFF_MAX_MS);
      authBlockedUntil = Date.now() + backoff;
      console.error(`[tdxAuth] 憑證被拒（第 ${authFailures} 次），${Math.round(backoff / 60000)} 分鐘內不再重試`);
    }
    throw new Error(`TDX 認證失敗 (${res.status}): ${text}`);
  }

  const json = await res.json();
  authFailures = 0;
  authBlockedUntil = 0;
  cachedToken = json.access_token;
  cachedExpiry = now + json.expires_in * 1000;
  return cachedToken;
}

module.exports = { getAccessToken };
