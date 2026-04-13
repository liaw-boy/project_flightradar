'use strict';

// ── Auth Store ────────────────────────────────────────────────────────────────
// Simple event-emitter based store (no external deps).
// Manages JWT token + current user, persisted to localStorage.

const KEY_TOKEN = 'aerostrat_token';
const KEY_USER  = 'aerostrat_user';

let _token    = localStorage.getItem(KEY_TOKEN) || null;
let _user     = (() => { try { return JSON.parse(localStorage.getItem(KEY_USER)); } catch { return null; } })();
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

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(path, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    if (_token) headers['Authorization'] = `Bearer ${_token}`;
    const res = await fetch(path, { ...options, headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
}

export async function apiLogin(username, password) {
    const data = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
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
