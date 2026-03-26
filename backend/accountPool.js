'use strict';
/**
 * AccountPool — OpenSky 多帳號智慧管理模組
 *
 * 取代原本散落在 server.js 的：
 *   rotateAccount / getAuthHeaders / syncAccountQuota / loadQuotaCache / saveQuotaCache
 *
 * 核心策略：每次選「額度最高 + 未被鎖定」的帳號，而非 round-robin。
 *
 * 對外只暴露四個方法：
 *   pool.getHeaders()            → { headers, account } — 選最佳帳號並回傳 Bearer headers
 *   pool.recordResponse(a, s, h) → 記錄這次請求結果（更新額度 / 鎖定）
 *   pool.getStats()              → 帳號狀態快照（給 /api/stats 和 /monitor）
 *   pool.warmup(isFresh)         → 啟動並行預熱（取 token + 確認額度）
 *   pool.loadCache(filePath)     → 從磁碟還原當日配額快取
 *   pool.getCurrentUser()        → 當前最佳帳號名稱（給 /api/health）
 *   pool.getRecommendedInterval(min) → 依剩餘額度建議輪詢間隔
 */

const fs     = require('fs');
const path   = require('path');
const logger = require('./logger');

const OPENSKY_TOKEN_URL =
    'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';

// ── 安全檢查：帳號名不含換行（防 log injection） ─────────────────
function sanitizeUser(u) {
    return String(u ?? '').replace(/[\r\n]/g, '_');
}

class AccountPool {
    /**
     * @param {Array<{user:string,pass:string}>} accounts
     * @param {{ safeFloor?: number }} opts
     */
    constructor(accounts, opts = {}) {
        this.SAFE_FLOOR = opts.safeFloor ?? 50;
        this.cacheFile  = null;

        // 帳號狀態表（憑證只在此物件內，不對外暴露）
        this._accounts = accounts.map(a => ({
            user: sanitizeUser(a.user),
            _pass: a.pass,          // 只用於取 token，從不寫入 log

            // Token
            token:          null,
            tokenExpiresAt: 0,

            // 配額（來自 X-Rate-Limit-* header）
            remainingCredits: null, // null = 未知（視為健康）
            lockedUntil:      null, // timestamp ms，429 解鎖時間
            rateLimitCount:   0,    // 累計 429 次數

            // 健康
            consecutiveFails: 0,    // 連續認證失敗次數
            lastUsedAt:       null, // 最後使用 timestamp ms（LRU tiebreaker）
            dailyUsed:        0,    // 今日請求計數
        }));

        this._scheduleDailyReset();
    }

    // ── 帳號選擇 ────────────────────────────────────────────────────
    /**
     * 選出目前最佳可用帳號：
     *   1. 過濾：未被鎖定、未連續失敗 3 次、額度未低於安全地板
     *   2. 排序：null 額度優先（未知=健康）→ 額度最高 → 最久未用（LRU）
     *   3. 全部不可用時：選最快解鎖的那個，並發出 ALERT
     */
    _selectBest() {
        const now = Date.now();

        const available = this._accounts.filter(a =>
            a.consecutiveFails < 3 &&
            (a.lockedUntil === null || a.lockedUntil <= now) &&
            (a.remainingCredits === null || a.remainingCredits > this.SAFE_FLOOR)
        );

        if (available.length === 0) {
            // 全部耗盡 / 鎖定：選最快解鎖的
            const sorted = [...this._accounts].sort((a, b) => {
                const ta = a.lockedUntil ?? Infinity;
                const tb = b.lockedUntil ?? Infinity;
                return ta - tb;
            });
            const fallback = sorted[0];
            logger.warn('POOL',
                `[ALERT] All ${this._accounts.length} accounts depleted or locked — ` +
                `using ${fallback.user} (earliest unlock: ` +
                `${fallback.lockedUntil ? new Date(fallback.lockedUntil).toISOString() : 'unknown'})`
            );
            return fallback;
        }

        // Sort: null credits first → most credits → LRU
        available.sort((a, b) => {
            if (a.remainingCredits === null && b.remainingCredits !== null) return -1;
            if (b.remainingCredits === null && a.remainingCredits !== null) return  1;
            if (a.remainingCredits !== b.remainingCredits)
                return (b.remainingCredits ?? 0) - (a.remainingCredits ?? 0);
            return (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0);
        });

        return available[0];
    }

    // ── Token 取得 ──────────────────────────────────────────────────
    async _fetchToken(account) {
        try {
            const params = new URLSearchParams();
            params.append('grant_type',    'client_credentials');
            params.append('client_id',     account.user);
            params.append('client_secret', account._pass);   // 密碼不寫入 log

            const res = await fetch(OPENSKY_TOKEN_URL, {
                method:  'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body:    params,
                signal:  AbortSignal.timeout(10000),
            });

            if (!res.ok) {
                account.consecutiveFails++;
                // 不印出 response body 避免洩漏敏感錯誤訊息
                logger.error('POOL',
                    `Token fetch failed for ${account.user} (HTTP ${res.status}) — ` +
                    `consecutive fails: ${account.consecutiveFails}`
                );
                return null; // null 表示失敗
            }

            const data = await res.json();
            // access_token 存在記憶體，不寫入 log
            account.token          = data.access_token;
            account.tokenExpiresAt = Date.now() + (data.expires_in - 60) * 1000;
            account.consecutiveFails = 0;

            logger.info('AUTH', `✅ Token received for ${account.user}. Expires in ${data.expires_in}s.`);
            return account.token;
        } catch (err) {
            account.consecutiveFails++;
            logger.error('POOL', `Token fetch error for ${account.user}: ${err.message}`);
            return null;
        }
    }

    // ── 主要公開方法 ─────────────────────────────────────────────────

    /**
     * 回傳最佳帳號的 HTTP Basic Auth headers（供歷史軌跡等需要密碼的端點使用）
     * 密碼只以 base64 傳送至 HTTPS 端點，不寫入 log。
     */
    getBasicAuthHeaders() {
        if (this._accounts.length === 0) return { headers: {}, account: null };
        const account = this._selectBest();
        account.lastUsedAt = Date.now();
        const encoded = Buffer.from(`${account.user}:${account._pass}`).toString('base64');
        return { headers: { 'Authorization': `Basic ${encoded}` }, account };
    }

    /**
     * 選最佳帳號，確保 token 有效，回傳 { headers, account }
     * account 是內部物件，呼叫方應直接傳給 recordResponse()。
     * 注意：絕對不要把 account._pass / account.token 印出或回傳到外部。
     */
    async getHeaders() {
        if (this._accounts.length === 0) return { headers: {}, account: null };

        const account = this._selectBest();
        account.lastUsedAt = Date.now();

        // Token 仍有效
        if (account.token && Date.now() < account.tokenExpiresAt) {
            return { headers: { 'Authorization': `Bearer ${account.token}` }, account };
        }

        // 需要重新取 token
        const token = await this._fetchToken(account);
        if (!token) return { headers: {}, account };
        return { headers: { 'Authorization': `Bearer ${token}` }, account };
    }

    /**
     * 記錄 API 請求結果，更新額度與鎖定狀態
     * @param {object} account   — getHeaders() 回傳的 account 物件
     * @param {number} status    — HTTP status code
     * @param {Headers} resHeaders — fetch Response.headers
     */
    recordResponse(account, status, resHeaders) {
        if (!account) return;

        const remaining  = resHeaders?.get?.('x-rate-limit-remaining');
        const retryAfter = resHeaders?.get?.('x-rate-limit-retry-after-seconds');

        if (remaining !== null && remaining !== undefined && remaining !== '') {
            const n = parseInt(remaining, 10);
            if (!isNaN(n)) {
                account.remainingCredits = n;
                account.lockedUntil      = null; // 清除先前的鎖定
            }
        }

        if (status === 429) {
            account.rateLimitCount++;
            const delay = retryAfter ? parseInt(retryAfter, 10) * 1000 : 60000;
            account.lockedUntil = Date.now() + delay;
            logger.warn('POOL',
                `Account ${account.user} rate-limited (429) — ` +
                `locked until ${new Date(account.lockedUntil).toISOString()}`
            );
        }

        account.dailyUsed++;
        this._saveCache();
    }

    /**
     * 並行 warmup：預取所有帳號 token 並確認配額
     * @param {boolean} isFresh — 今日快取已存在時，跳過有紀錄的帳號
     */
    async warmup(isFresh = false) {
        logger.info('POOL', `Warming up ${this._accounts.length} accounts (sequential, 1.2s gap)...`);

        // Sequential with delay: 避免同 IP 並發觸發 OpenSky 速率限制
        for (const account of this._accounts) {
            if (isFresh && account.remainingCredits !== null) {
                logger.info('POOL', `${account.user}: cached quota = ${account.remainingCredits}`);
                continue;
            }
            try {
                const token = await this._fetchToken(account);
                if (!token) continue;

                const res = await fetch(
                    'https://opensky-network.org/api/states/all?lamin=23.5&lomin=120.5&lamax=23.6&lomax=120.6',
                    {
                        headers: { 'Authorization': `Bearer ${token}` },
                        signal:  AbortSignal.timeout(10000),
                    }
                );
                this.recordResponse(account, res.status, res.headers);
                logger.info('POOL',
                    `Warmup OK: ${account.user} credits=${account.remainingCredits ?? '?'}`
                );
            } catch (e) {
                logger.warn('POOL', `Warmup failed for ${account.user}: ${e.message}`);
            }
            // 每帳號間隔 1.2 秒，避免同 IP 並發請求觸發 429
            await new Promise(r => setTimeout(r, 1200));
        }

        logger.info('POOL', `Warmup complete. ` +
            this._accounts.map(a => `${a.user}:${a.remainingCredits ?? '?'}`).join(' | ')
        );
    }

    /**
     * 回傳帳號狀態快照（格式與舊 apiStats.accounts 相容）
     * 注意：不含密碼或 token。
     */
    getStats() {
        return this._accounts.map(a => ({
            user:             a.user,
            remainingCredits: a.remainingCredits,
            unlockTime:       a.lockedUntil ? new Date(a.lockedUntil).toISOString() : null,
            rateLimits:       a.rateLimitCount,
            consecutiveFails: a.consecutiveFails,
            dailyUsed:        a.dailyUsed,
        }));
    }

    /** 目前最佳帳號的 user 名稱（給 /api/health） */
    getCurrentUser() {
        if (this._accounts.length === 0) return 'none';
        return this._selectBest()?.user ?? 'none';
    }

    /** 依剩餘額度建議下次輪詢間隔（ms） */
    getRecommendedInterval(minInterval = 10000) {
        if (this._accounts.length === 0) return minInterval;
        const best = this._selectBest();
        if (!best || best.remainingCredits === null) return minInterval;
        if (best.remainingCredits <= this.SAFE_FLOOR) return 300000; // 5 分鐘節流

        const endOfDay = new Date();
        endOfDay.setUTCHours(24, 0, 0, 0);
        const msLeft = endOfDay.getTime() - Date.now();
        const requestsLeft = best.remainingCredits - this.SAFE_FLOOR;
        if (requestsLeft <= 0) return 300000;
        const computed = Math.floor(msLeft / requestsLeft);
        return Math.min(Math.max(computed, minInterval), 60000);
    }

    // ── 快取 ────────────────────────────────────────────────────────

    /**
     * 從磁碟載入今日配額快取
     * @returns {boolean} true = 今日快取有效
     */
    loadCache(filePath) {
        this.cacheFile = filePath;
        try {
            if (!fs.existsSync(filePath)) return false;

            const raw  = fs.readFileSync(filePath, 'utf8');
            const saved = JSON.parse(raw);
            const savedAccounts = Array.isArray(saved) ? saved : (saved.accounts ?? []);
            const savedDate     = Array.isArray(saved) ? null   : (saved.date ?? null);
            const today         = new Date().toISOString().split('T')[0];

            if (savedDate !== today) {
                logger.info('POOL', `Cache date ${savedDate} ≠ today ${today} — ignoring`);
                return false;
            }

            savedAccounts.forEach(s => {
                const a = this._accounts.find(x => x.user === s.user);
                if (!a) return;
                a.remainingCredits = s.remainingCredits ?? null;
                a.rateLimitCount   = s.rateLimits       ?? 0;
                a.lockedUntil      = s.unlockTime ? new Date(s.unlockTime).getTime() : null;
            });

            logger.info('POOL', `Quota cache loaded for ${this._accounts.length} accounts`);
            return true;
        } catch (e) {
            logger.error('POOL', `Failed to load quota cache: ${e.message}`);
            return false;
        }
    }

    _saveCache() {
        if (!this.cacheFile) return;
        const payload = { date: new Date().toISOString().split('T')[0], accounts: this.getStats() };
        fs.promises.writeFile(this.cacheFile, JSON.stringify(payload, null, 2))
            .catch(e => logger.error('POOL', `Failed to save quota cache: ${e.message}`));
    }

    // ── UTC 00:00 自動重置 ─────────────────────────────────────────
    _scheduleDailyReset() {
        const nextReset = new Date();
        nextReset.setUTCDate(nextReset.getUTCDate() + 1);
        nextReset.setUTCHours(0, 0, 30, 0); // 00:00:30 UTC（30s 緩衝）
        const msUntil = nextReset.getTime() - Date.now();

        setTimeout(() => {
            this._doReset();
            setInterval(() => this._doReset(), 24 * 60 * 60 * 1000);
        }, msUntil);

        logger.info('POOL',
            `Daily quota reset scheduled in ${Math.round(msUntil / 60000)} min ` +
            `(at ${nextReset.toISOString()})`
        );
    }

    _doReset() {
        logger.info('POOL', 'UTC 00:00 — daily quota reset, clearing all limits');
        this._accounts.forEach(a => {
            a.remainingCredits = null;
            a.lockedUntil      = null;
            a.consecutiveFails = 0;
            a.dailyUsed        = 0;
            // token 繼續沿用（在有效期內仍有效）
        });
        this._saveCache();
    }
}

module.exports = AccountPool;
