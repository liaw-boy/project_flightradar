'use strict';
// METAR 機場天氣 API (每小時更新)
const logger = require('../logger');
const syncLog = require('../db/syncLogger');
const Metar = require('../db/metarStore');

const METAR_TTL = 3600000; // 1 小時

// 所有需要抓 METAR 的機場 ICAO 碼
const METAR_AIRPORTS = [
    'RCTP', 'RCSS', 'RCKH', 'RCMQ', 'RCNN', 'RCFN', 'RCQC',
    'RJTT', 'RJAA', 'RJBB', 'RJFF', 'RJCC', 'ROAH',
    'RKSI', 'RKSS',
    'ZBAA', 'ZSPD', 'ZSSS', 'ZGGG', 'ZGSZ', 'VHHH',
    'WSSS', 'VTBS', 'WMKK', 'RPLL', 'WIII', 'VVNB', 'VVTS', 'VIDP',
    'OMDB', 'OTHH',
    'EGLL', 'LFPG', 'EDDF', 'EHAM', 'LTFM',
    'KJFK', 'KLAX', 'KORD', 'KATL',
    'YSSY', 'NZAA'
];

async function fetchMetarData() {
    syncLog.start('metar');
    try {
        const ids = METAR_AIRPORTS.join(',');
        const url = `https://aviationweather.gov/api/data/metar?ids=${ids}&format=json`;
        logger.info('METAR', `Fetching weather for ${METAR_AIRPORTS.length} airports`);

        const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`METAR API HTTP ${response.status}`);

        const data = await response.json();

        const operations = data.map(info => ({
            updateOne: {
                filter: { icaoId: info.icaoId.toUpperCase() },
                update: {
                    $set: {
                        ...info,
                        location: { type: 'Point', coordinates: [parseFloat(info.lon), parseFloat(info.lat)] },
                        lastUpdated: new Date()
                    }
                },
                upsert: true
            }
        }));

        if (operations.length > 0) {
            await Metar.bulkWrite(operations, { ordered: false });
        }

        logger.info('METAR', `Updated ${data.length} airport weather records`);
        syncLog.success('metar', `${data.length} airports`);
    } catch (error) {
        logger.error('METAR', `Fetch error: ${error.message}`);
        syncLog.fail('metar', error.message);
    }
}

function registerMetarRoutes(app) {
    app.get('/api/metar', async (req, res) => {
        try {
            const icao = req.query.icao;
            if (icao) {
                const found = await Metar.findOne({ icaoId: icao.toUpperCase() });
                return res.json(found || { error: 'Airport not found' });
            }
            const all = await Metar.find({});
            res.json(all);
        } catch (err) {
            res.status(500).json({ error: "Internal server error" });
        }
    });
}

function startMetarSync() {
    fetchMetarData(); // 立即執行一次
    setInterval(fetchMetarData, METAR_TTL); // 每小時定時更新
}

module.exports = { registerMetarRoutes, startMetarSync, fetchMetarData };
