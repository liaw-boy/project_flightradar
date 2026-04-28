'use strict';

// ── Auth Store ────────────────────────────────────────────────────────────────
// JWT is stored server-side as an httpOnly cookie — JS never touches the token.
// We persist the user profile and token expiry in localStorage so the UI can
// show the logged-in state without a round-trip, and schedule a silent refresh.

const KEY_USER   = 'aerostrat_user';
const KEY_EXPIRY = 'aerostrat_token_expiry';

let _user   = (() => { try { return JSON.parse(localStorage.getItem(KEY_USER)); } catch { return null; } })();
let _expiry = Number(localStorage.getItem(KEY_EXPIRY)) || null;

// If the stored expiry has passed, clear the stale user profile
if (_expiry && Date.now() > _expiry) {
    localStorage.removeItem(KEY_USER);
    localStorage.removeItem(KEY_EXPIRY);
    _user   = null;
    _expiry = null;
}

const _listeners = new Set();

function notify() {
    _listeners.forEach(fn => fn({ user: _user }));
}

export const authStore = {
    getToken()  { return null; }, // token is httpOnly — not accessible from JS
    getUser()   { return _user; },
    isLoggedIn(){ return !!_user; },

    subscribe(fn) {
        _listeners.add(fn);
        return () => _listeners.delete(fn);
    },

    _set(user, tokenExpiry) {
        _user   = user;
        _expiry = tokenExpiry || null;
        if (user) {
            localStorage.setItem(KEY_USER, JSON.stringify(user));
            if (tokenExpiry) localStorage.setItem(KEY_EXPIRY, String(tokenExpiry));
        } else {
            localStorage.removeItem(KEY_USER);
            localStorage.removeItem(KEY_EXPIRY);
        }
        notify();
    },

    logout() {
        // Clear local state immediately for a snappy UI, then tell the server
        // to expire the httpOnly cookie
        this._set(null, null);
        fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }).catch(() => {});
    },
};

// ── Sliding-window token refresh ──────────────────────────────────────────────
// If token has < 3 days remaining (known from tokenExpiry in localStorage),
// silently hit /api/auth/refresh — the browser sends the httpOnly cookie automatically.
const REFRESH_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
let _refreshing = false;

async function maybeRefreshToken() {
    if (!_user || _refreshing) return;
    if (!_expiry) return;
    const remaining = _expiry - Date.now();
    if (remaining <= 0 || remaining > REFRESH_THRESHOLD_MS) return;

    _refreshing = true;
    try {
        const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
        if (res.ok) {
            const data = await res.json();
            authStore._set(data.user, data.tokenExpiry);
        } else if (res.status === 401) {
            // Cookie expired on the server — log out
            authStore._set(null, null);
        }
    } catch { /* silent — not critical */ } finally {
        _refreshing = false;
    }
}

// Check once on load, then every 6 hours
maybeRefreshToken();
setInterval(maybeRefreshToken, 6 * 60 * 60 * 1000);

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    // credentials: 'include' ensures the httpOnly cookie is sent cross-origin if needed,
    // and is harmless for same-origin requests
    const res = await fetch(path, { ...options, headers, credentials: 'include' });
    if (res.status === 401) {
        authStore._set(null, null);
        throw new Error('登入已過期，請重新登入');
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
}

export async function apiLogin(username, password) {
    const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ uid: username, password }),
    });
    authStore._set(data.user, data.tokenExpiry);
    return data.user;
}

export async function apiRegister(username, password, email) {
    const data = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password, email }),
    });
    authStore._set(data.user, data.tokenExpiry);
    return data.user;
}

// ── User flights API ──────────────────────────────────────────────────────────

export async function apiListFlights(page = 1, limit = 50) {
    return apiFetch(`/api/flights/my?page=${page}&limit=${limit}`);
}

export async function apiCreateFlight(payload) {
    return apiFetch('/api/flights/my', { method: 'POST', body: JSON.stringify(payload) });
}

export async function apiUpdateFlight(id, payload) {
    return apiFetch(`/api/flights/my/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
}

export async function apiDeleteFlight(id) {
    return apiFetch(`/api/flights/my/${id}`, { method: 'DELETE' });
}

export async function apiFlightStats() {
    return apiFetch('/api/flights/my/stats');
}

export async function apiFlightMapData() {
    return apiFetch('/api/flights/my/map');
}

export async function apiLookupCallsign(cs) {
    try {
        const r = await fetch(`/api/lookup/callsign/${encodeURIComponent(cs)}`, { credentials: 'include' });
        if (!r.ok) return { found: false, networkError: r.status !== 404 };
        return r.json();
    } catch (err) {
        console.error('[lookup] callsign network error:', err);
        return { found: false, networkError: true };
    }
}

export async function apiLookupAirport(code) {
    try {
        const r = await fetch(`/api/lookup/airport/${encodeURIComponent(code)}`, { credentials: 'include' });
        if (!r.ok) return { found: false, networkError: r.status !== 404 };
        return r.json();
    } catch (err) {
        console.error('[lookup] airport network error:', err);
        return { found: false, networkError: true };
    }
}
