'use strict';

// ── Auth Store ────────────────────────────────────────────────────────────────
// Simple event-emitter based store (no external deps).
// Manages JWT token + current user, persisted to localStorage.

const KEY_TOKEN = 'aerostrat_token';
const KEY_USER  = 'aerostrat_user';

// Decode JWT exp claim without a library (base64 decode the payload segment)
function tokenExpiresAt(token) {
    try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        return payload.exp ? payload.exp * 1000 : null;
    } catch { return null; }
}

let _token = localStorage.getItem(KEY_TOKEN) || null;
let _user  = (() => { try { return JSON.parse(localStorage.getItem(KEY_USER)); } catch { return null; } })();

// Clear expired token on startup so stale localStorage doesn't linger
if (_token) {
    const exp = tokenExpiresAt(_token);
    if (exp && Date.now() > exp) {
        localStorage.removeItem(KEY_TOKEN);
        localStorage.removeItem(KEY_USER);
        _token = null;
        _user  = null;
    }
}

const _listeners = new Set();

function notify() {
    _listeners.forEach(fn => fn({ token: _token, user: _user }));
}

export const authStore = {
    getToken()  { return _token; },
    getUser()   { return _user; },
    isLoggedIn(){ return !!_token; },

    subscribe(fn) {
        _listeners.add(fn);
        return () => _listeners.delete(fn);
    },

    _set(token, user) {
        _token = token;
        _user  = user;
        if (token) {
            localStorage.setItem(KEY_TOKEN, token);
            localStorage.setItem(KEY_USER, JSON.stringify(user));
        } else {
            localStorage.removeItem(KEY_TOKEN);
            localStorage.removeItem(KEY_USER);
        }
        notify();
    },

    logout() { this._set(null, null); },
};

// ── Sliding-window token refresh ──────────────────────────────────────────────
// If token has < 3 days remaining, silently swap for a fresh 7-day token.
const REFRESH_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;
let _refreshing = false;

async function maybeRefreshToken() {
    if (!_token || _refreshing) return;
    const exp = tokenExpiresAt(_token);
    if (!exp) return;
    const remaining = exp - Date.now();
    if (remaining <= 0 || remaining > REFRESH_THRESHOLD_MS) return;

    _refreshing = true;
    try {
        const res = await fetch('/api/auth/refresh', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${_token}` },
        });
        if (res.ok) {
            const data = await res.json();
            authStore._set(data.token, data.user);
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
    if (_token) headers['Authorization'] = `Bearer ${_token}`;
    const res = await fetch(path, { ...options, headers });
    // Auto-logout on 401 so stale/revoked tokens don't leave users in a broken state
    if (res.status === 401) {
        authStore.logout();
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
    authStore._set(data.token, data.user);
    return data.user;
}

export async function apiRegister(username, password, email) {
    const data = await apiFetch('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify({ username, password, email }),
    });
    authStore._set(data.token, data.user);
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
    return fetch(`/api/lookup/callsign/${encodeURIComponent(cs)}`).then(r => r.json()).catch(() => ({ found: false }));
}

export async function apiLookupAirport(code) {
    return fetch(`/api/lookup/airport/${encodeURIComponent(code)}`).then(r => r.json()).catch(() => ({ found: false }));
}
