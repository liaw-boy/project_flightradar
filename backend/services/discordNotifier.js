'use strict';
// Shared Discord webhook notifier — used by the nightly trajectory-retrain
// cron (server.js), the real-time emergency-squawk alert
// (broadcastEngine.js), and the total-outage alert (pollers.js).
// Best-effort: a missing/unset webhook or a failed POST never throws into
// the caller, so this stays optional infra rather than a new failure mode
// for whatever triggered the notification.
const logger = require('../logger');

// Twemoji — Twitter's open-source emoji artwork (CC-BY 4.0), served from the
// jsdelivr CDN mirror of github.com/twitter/twemoji. Used as embed
// thumbnails instead of inline unicode emoji characters in the message text.
const TWEMOJI_BASE = 'https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/72x72';
const ICONS = {
    emergency: `${TWEMOJI_BASE}/1f6a8.png`,      // 🚨 rotating light
    outageDown: `${TWEMOJI_BASE}/26a0.png`,      // ⚠️ warning
    outageUp: `${TWEMOJI_BASE}/2705.png`,        // ✅ check mark
    promoted: `${TWEMOJI_BASE}/1f7e2.png`,       // 🟢 green circle
    rejected: `${TWEMOJI_BASE}/26aa.png`,        // ⚪ white circle
    failed: `${TWEMOJI_BASE}/1f534.png`,         // 🔴 red circle
    military: `${TWEMOJI_BASE}/1f396.png`,       // 🎖️ military medal
    livery: `${TWEMOJI_BASE}/1f3a8.png`,         // 🎨 artist palette
};

const COLORS = {
    green: 0x2ecc71,
    gray: 0x95a5a6,
    red: 0xe74c3c,
    orange: 0xe67e22,
};

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * notifyDiscord({ icon, color, title, description }, webhookEnvVar)
 * icon: key into ICONS (or a direct URL). color: key into COLORS (or a
 * direct decimal int). Sends a single-embed Discord webhook message.
 * Retries a transient failure (timeout/network blip) up to MAX_ATTEMPTS
 * times — a real-time alert (emergency squawk, total outage) that's worth
 * sending at all is worth not silently dropping over one bad request; a
 * genuine 429/5xx from Discord itself still gives up after the retries.
 */
async function notifyDiscord({ icon, color, title, description, url: linkUrl, image: imageUrl }, webhookEnvVar = 'DISCORD_RETRAIN_WEBHOOK_URL') {
    // Falls back to the retrain webhook if a more specific one (e.g. the
    // emergency alert channel) isn't configured — works out of the box with
    // just one webhook set up, but can be split into separate channels later
    // by setting the specific env var without any code change.
    const url = process.env[webhookEnvVar] || process.env.DISCORD_RETRAIN_WEBHOOK_URL;
    if (!url) return;

    const body = JSON.stringify({
        embeds: [{
            title,
            description,
            // Discord only makes the title clickable when `url` is set — this
            // is the deep-link back into the live map (?icao=...), so tapping
            // the alert in Discord jumps straight to that aircraft.
            url: linkUrl,
            color: typeof color === 'number' ? color : (COLORS[color] ?? COLORS.gray),
            thumbnail: { url: ICONS[icon] || icon },
            image: imageUrl ? { url: imageUrl } : undefined,
            timestamp: new Date().toISOString(),
        }],
    });

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                signal: AbortSignal.timeout(10_000),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return;
        } catch (e) {
            const isLastAttempt = attempt === MAX_ATTEMPTS;
            logger.warn('DISCORD', `Notify attempt ${attempt}/${MAX_ATTEMPTS} failed: ${e.message}${isLastAttempt ? ' — giving up' : ', retrying'}`);
            if (!isLastAttempt) await sleep(RETRY_DELAY_MS);
        }
    }
}

module.exports = { notifyDiscord, ICONS, COLORS };
