const Aircraft = require('../db/aircraftStore');
const Route = require('../db/routeStore');
const MictronicsDb = require('../db/mictronicsDb');
const VrsDb = require('../db/vrsDb');
const { AirportDictionary, RouteDictionary } = require('../db/staticMaps');
const logger = require('../logger');

// [LOG] Rate-limit noisy external-API fail logs — only print first N per rolling window
function makeRateLimitedLogger(maxPerWindow = 3, windowMs = 60000) {
    let count = 0;
    let windowStart = Date.now();
    return (tag, msg) => {
        const now = Date.now();
        if (now - windowStart > windowMs) {
            if (count > maxPerWindow) {
                logger.warn(tag, `... ${count - maxPerWindow} more suppressed in the last minute`);
            }
            count = 0;
            windowStart = now;
        }
        count++;
        if (count <= maxPerWindow) logger.warn(tag, msg);
    };
}
const logAdsbFiFail = makeRateLimitedLogger(3);
const logHexDbFail  = makeRateLimitedLogger(3);

// ICAO 3-letter prefix → airline name (client-side mirror for server-side fallback)
const CALLSIGN_PREFIX_AIRLINES = {
    // Taiwan
    CAL: 'China Airlines 中華航空', EVA: 'EVA Air 長榮航空', MDA: 'Mandarin Airlines 華信航空',
    UIA: 'Uni Air 立榮航空', TTW: 'Tigerair Taiwan 台灣虎航', SJX: 'StarLux Airlines 星宇航空',
    // Global Major
    AAL: 'American Airlines 美國航空', UAL: 'United Airlines 聯合航空', DAL: 'Delta Air Lines 達美航空',
    SWA: 'Southwest Airlines 西南航空', BAW: 'British Airways 英國航空', DLH: 'Lufthansa 漢莎航空',
    AFR: 'Air France 法國航空', KLM: 'KLM 荷蘭皇家航空', THA: 'Thai Airways 泰國航空',
    SIA: 'Singapore Airlines 新加坡航空', CPA: 'Cathay Pacific 國泰航空', JAL: 'Japan Airlines 日本航空',
    ANA: 'All Nippon Airways 全日空', KAL: 'Korean Air 大韓航空', AAR: 'Asiana Airlines 韓亞航空',
    CCA: 'Air China 中國國際航空', CSN: 'China Southern 中國南方航空', CES: 'China Eastern 中國東方航空',
    UAE: 'Emirates 阿聯酋航空', QTR: 'Qatar Airways 卡達航空', ETD: 'Etihad Airways 阿提哈德航空',
    THY: 'Turkish Airlines 土耳其航空', QFA: 'Qantas 澳洲航空', ANZ: 'Air New Zealand 紐西蘭航空',
};

function getAirlineFromCallsign(callsign) {
    if (!callsign) return null;
    const prefix = callsign.replace(/\d.*$/, '').toUpperCase().substring(0, 3);
    return CALLSIGN_PREFIX_AIRLINES[prefix] || null;
}

// [v14.0] High-Fidelity Callsign-to-Route Resolution (ADSB.fi Feed)
async function fetchRouteInfo(callsign) {
    if (!callsign) return null;
    const normalized = normalizeCallsign(callsign);
    
    try {
        // [Primary Source] ADSB.fi dynamic callsign API (Free & Real-time)
        const res = await fetch(`https://api.adsb.fi/v2/callsign/${normalized}`, {
            headers: { 'User-Agent': 'AEROSTRAT/5.0' },
            signal: AbortSignal.timeout(4000)
        });
        
        if (!res.ok) return null;
        const data = await res.json();
        
        // ADSB.fi returns { ac: [{ origin: "VHHH", destination: "RCTP", ... }] }
        if (data.ac && data.ac.length > 0) {
            const flight = data.ac[0];
            if (flight.origin && flight.destination) {
                logger.debug('FUSION', `ADSB.fi matched Route: ${normalized} -> ${flight.origin} to ${flight.destination}`);
                
                // Lookup full names from static dictionary
                const [originAp, destAp] = await Promise.all([
                    AirportDictionary.findOne({ icao: flight.origin.toUpperCase() }),
                    AirportDictionary.findOne({ icao: flight.destination.toUpperCase() }),
                ]);

                return {
                    origin_iata:      originAp?.iata || flight.origin.substring(1), // Fallback to ICAO trim
                    origin_icao:      flight.origin.toUpperCase(),
                    origin_name:      originAp ? originAp.name : null,
                    origin_city:      originAp ? originAp.city : null,
                    destination_iata: destAp?.iata   || flight.destination.substring(1),
                    destination_icao: flight.destination.toUpperCase(),
                    destination_name: destAp ? destAp.name : null,
                    destination_city: destAp ? destAp.city : null,
                    source: 'adsb_fi_live'
                };
            }
        }
        return null;
    } catch (err) {
        logger.debug('FUSION', `ADSB.fi Route lookup failed for ${normalized}: ${err.message}`);
        return null;
    }
}

// NOAA Aviation Weather Center API (Free & Open)
async function fetchNOAAWeather(iata) {
    try {
        const res = await fetch(`https://aviationweather.gov/api/data/metar?ids=${iata}&format=json`, {
            signal: AbortSignal.timeout(3000)
        });
        if (!res.ok) return null;
        
        const data = await res.json();
        if (Array.isArray(data) && data.length > 0) {
            const station = data[0];
            return {
                temp: station.temp || null, // Celsius
                wspd: station.wspd || null, // Knots
                wdir: station.wdir || null, // Degrees
                rawOws: station.rawOb || station.rawOws || null
            };
        }
        return null;
    } catch (err) {
        logger.debug('FUSION', `NOAA METAR failed for ${iata}: ${err.message}`);
        return null;
    }
}

// Tar1090 Static DB Fallback (Layer 2 Aircraft Metadata)
async function fetchTar1090Fallback(hex) {
    if (!hex || hex.length < 2) return null;
    const prefix = hex.substring(0, 2).toLowerCase();
    try {
        const res = await fetch(`https://api.adsb.lol/v2/static/db/${prefix}.json`, {
            signal: AbortSignal.timeout(4000)
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data && data[hex]) {
            return {
                type: data[hex].t || 'Unknown',
                registration: data[hex].r || 'Unknown',
                manufacturer: 'Unknown',
                airline: 'Unknown' // Often tar1090 doesn't have full name, but resolving type is critical
            };
        }
        return null;
    } catch (err) {
        logger.debug('FUSION', `tar1090 fallback failed for ${hex}: ${err.message}`);
        return null;
    }
}

// Normalize ADS-B callsign for RouteDictionary lookup.
// ADS-B transmits "CAL006  " (trailing spaces, leading zeros).
// RouteDictionary stores "CAL6" (no padding, no spaces).
function normalizeCallsign(cs) {
    if (!cs) return '';
    const trimmed = cs.trim().toUpperCase();
    const match = trimmed.match(/^([A-Z]{2,3})(\d+)(.*)$/);
    if (!match) return trimmed;
    return match[1] + parseInt(match[2], 10) + (match[3] || '');
}

// Local Route & Airport Dictionary Lookup
// RouteDictionary stores ICAO airport codes (e.g. "RCTP", "KLAX").
// AirportDictionary.icao = ICAO, AirportDictionary.iata = IATA display code.
async function fetchLocalOSINTRoute(callsign) {
    try {
        const normalized = normalizeCallsign(callsign);
        const routeDict = await RouteDictionary.findOne({ callsign: normalized });
        if (!routeDict) return null;

        const originCode = routeDict.originIata;      // field name is misleading — may store ICAO or IATA
        const destCode   = routeDict.destinationIata;

        // Try ICAO lookup first, fall back to IATA (schedules_static.json stores IATA codes)
        const lookupAirport = async (code) => {
            if (!code) return null;
            return (await AirportDictionary.findOne({ icao: code })) || (await AirportDictionary.findOne({ iata: code }));
        };
        const [originAp, destAp] = await Promise.all([lookupAirport(originCode), lookupAirport(destCode)]);
        const originIcao = originAp?.icao || originCode;
        const destIcao   = destAp?.icao   || destCode;

        return {
            origin_iata:        originAp?.iata  || originIcao || 'N/A',
            origin_icao:        originIcao || 'N/A',
            origin_name:        originAp?.name  || null,
            origin_city:        originAp?.city  || null,
            destination_iata:   destAp?.iata    || destIcao   || 'N/A',
            destination_icao:   destIcao   || 'N/A',
            destination_name:   destAp?.name    || null,
            destination_city:   destAp?.city    || null,
            destination_weather: null,
            source: 'route_dictionary',
        };
    } catch (err) {
        logger.error('FUSION', `Failed to query local OSINT dictionaries: ${err.message}`);
        return null;
    }
}

exports.getCompleteDetails = async (req, res) => {
    const hex = (req.params.hex || '').toLowerCase();
    const callsign = (req.params.callsign || '').toUpperCase();

    if (!hex || !callsign) {
        return res.status(400).json({ error: 'Missing hex or callsign parameters' });
    }

    try {
        const result = await exports.getCompleteDetailsInternal(hex, callsign);
        return res.json({
            ...result,
            source: 'api_fusion_complete'
        });
    } catch (err) {
        logger.error('FUSION', `Terminal error for ${hex}/${callsign}: ${err.message}`);
        return res.status(500).json({ error: 'Data Fusion endpoint failed', details: err.message });
    }
};

exports.getCompleteDetailsInternal = async (hex, callsign) => {
    hex = hex.toLowerCase();
    callsign = callsign.toUpperCase();

    // 1. 【Cache Read-Through】
    const dbAircraft = await Aircraft.findOne({ $or: [{ hex }, { icao24: hex }] });
    const dbRoute    = await Route.findOne({ callsign });

    try {
        // [v12.0] High-Performance Layer 0: Local Master Database (Mictronics + legacy)
        // Also enrich with Mictronics SQLite registry for model name and operator.
        const micData = MictronicsDb.lookup(hex);
        let resolvedMetadata = null;
        if (dbAircraft && dbAircraft.type_code) {
            logger.debug('FUSION', `L0 DB match: ${hex} → ${dbAircraft.type_code} (src:${dbAircraft.source || 'legacy'})`);
            const rawAirline = dbAircraft.operator || dbAircraft.airline || micData?.operator || '';
            const knownAirline = rawAirline && rawAirline !== 'Unknown' ? rawAirline : null;
            resolvedMetadata = {
                type:         dbAircraft.type_code || micData?.typecode || null,
                registration: dbAircraft.registration || micData?.registration || 'Unknown',
                model:        micData?.model || dbAircraft.model || null,
                description:  micData?.model || dbAircraft.model || dbAircraft.manufacturerName || 'Unknown',
                manufacturer: dbAircraft.manufacturerName || dbAircraft.manufacturer || 'Unknown',
                airline:      knownAirline || 'Unknown',
                operator:     micData?.operator || dbAircraft.operator || null,
                icon_type:    dbAircraft.icon_type || 'STANDARD_JET'
            };
        } else if (micData && (micData.typecode || micData.registration)) {
            // Mictronics has data but live cache doesn't — use Mictronics directly
            logger.debug('FUSION', `L0 Mictronics-only match: ${hex} → ${micData.typecode}`);
            resolvedMetadata = {
                type:         micData.typecode || 'Unknown',
                registration: micData.registration || 'Unknown',
                model:        micData.model || null,
                description:  micData.model || 'Unknown',
                manufacturer: 'Unknown',
                airline:      micData.operator || 'Unknown',
                operator:     micData.operator || null,
                icon_type:    'STANDARD_JET'
            };
        }

        const planespottersPromise = fetch(`https://api.planespotters.net/pub/photos/hex/${hex}`, {
            headers: { 'User-Agent': 'AEROSTRAT/4.4.0 FlightTracker' },
            signal: AbortSignal.timeout(5000)
        })
            .then(res => res.ok ? res.json() : null)
            .catch(() => null);

        const metadataWaterfall = async () => {
            // [v13.6] Enrichment Logic: Accumulate data from multiple layers
            let info = resolvedMetadata || { type: 'Unknown', registration: 'Unknown', manufacturer: 'Unknown', airline: 'Unknown' };

            // Layer 1: ADSB-Fi (Primary Live Data)
            try {
                const adsbData = await fetchAdsbFiMetadata(hex);
                if (adsbData) {
                    logger.debug('FUSION', `L1 ADSB-Fi enriched: ${hex}`);
                    // Merge: adsbData overwrites placeholders, but preserves existing richness
                    info = {
                        ...info,
                        ...adsbData,
                        type: adsbData.type || info.type,
                        registration: adsbData.registration || info.registration,
                        airline: adsbData.airline || info.airline
                    };
                }
            } catch (e) {
                logAdsbFiFail('FUSION', `ADSB-Fi failed for ${hex}: ${e.message}`);
            }

            // Layer 2: HexDB (Fallback)
            const isStillMissing = !info.type || info.type === 'Unknown' || !info.registration || info.registration === 'Unknown';
            if (isStillMissing) {
                try {
                    const res = await fetch(`https://hexdb.io/api/v1/aircraft/${hex}`, { signal: AbortSignal.timeout(4000) });
                    if (res.ok) {
                        const data = await res.json();
                        if (data && (data.ICAOTypeCode || data.Type)) {
                            logger.debug('FUSION', `L2 HexDB enriched: ${hex}`);
                            info.type = data.ICAOTypeCode || data.Type || info.type;
                            info.registration = data.Registration || info.registration;
                        }
                    }
                } catch (e) {
                    logHexDbFail('FUSION', `HexDB failed for ${hex}: ${e.message}`);
                }
            }

            // Layer 3: Tar1090 Static Fallback
            if (!info.type || info.type === 'Unknown') {
                logger.debug('FUSION', `L3 tar1090 fallback for ${hex}`);
                const tarData = await fetchTar1090Fallback(hex);
                if (tarData) {
                    info = { ...info, ...tarData };
                }
            }

            // Layer 4: Tactical Unknown Check
            if ((!info.type || info.type === 'Unknown') && !dbAircraft) {
                return { isTacticalUnknown: true };
            }

            return info;
        };

        const metadataPromise = metadataWaterfall();
        const resolveRouteWaterfall = async () => {
            // DB cache fast-path: serve cached route if it has times, is fresh (< 4h),
            // AND is not a stale "Arrived" route for an aircraft that is currently airborne.
            // An "Arrived" route for an airborne aircraft means the callsign was reused for
            // a new flight — the old route must not be served to avoid misleading the user.
            const ROUTE_TTL_MS = 4 * 60 * 60 * 1000;
            // Never serve cache for "Arrived" routes — the callsign may have been reused
            // for a new flight. Force a live re-fetch so the correct route is shown.
            const isArrivedInCache = dbRoute?.flightStatus === 'Arrived';
            if (dbRoute && dbRoute.departure_time && dbRoute.updatedAt && !isArrivedInCache &&
                (Date.now() - new Date(dbRoute.updatedAt).getTime() < ROUTE_TTL_MS)) {
                return {
                    origin_iata:        dbRoute.origin_iata        || 'N/A',
                    origin_name:        dbRoute.origin_name        || null,
                    origin_city:        dbRoute.origin_city        || null,
                    destination_iata:   dbRoute.destination_iata   || 'N/A',
                    destination_name:   dbRoute.destination_name   || null,
                    destination_city:   dbRoute.destination_city   || null,
                    departure_time:     dbRoute.departure_time     || null,
                    departure_terminal: dbRoute.departure_terminal || null,
                    departure_gate:     dbRoute.departure_gate     || null,
                    arrival_time:       dbRoute.arrival_time       || null,
                    arrival_terminal:   dbRoute.arrival_terminal   || null,
                    arrival_gate:       dbRoute.arrival_gate       || null,
                    flightNumber:       dbRoute.flightNumber       || callsign,
                    flightStatus:       dbRoute.flightStatus       || null,
                    airline_name:       dbRoute.airline_name       || null,
                    destination_weather: dbRoute.destination_weather || null,
                    source: 'db_cache'
                };
            }

            // Fetch ADSB.fi (free, real-time ICAO routing) and AeroDataBox (paid, schedule/gate)
            // in parallel to minimise latency
            const adbKey = process.env.AERODATABOX_API_KEY;
            const fetchAeroDataBox = async () => {
                if (!adbKey || adbKey === 'your_key_here') return null;
                try {
                    const res = await fetch(
                        `https://aerodatabox.p.rapidapi.com/flights/callsign/${callsign.trim().toUpperCase()}`,
                        {
                            headers: { 'X-RapidAPI-Key': adbKey, 'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com' },
                            signal: AbortSignal.timeout(4000)
                        }
                    );
                    if (!res.ok) return null;
                    const data = await res.json();
                    if (!Array.isArray(data) || data.length === 0) return null;
                    const f = data[0];
                    const fmtTime = (s) => {
                        if (!s) return null;
                        const d = new Date(s);
                        return isNaN(d) ? s : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false });
                    };
                    const depRevised = f.departure?.revisedTimeLocal || f.departure?.revisedTimeUtc;
                    const depSched   = f.departure?.scheduledTimeLocal || f.departure?.scheduledTimeUtc;
                    const arrRevised = f.arrival?.revisedTimeLocal   || f.arrival?.revisedTimeUtc;
                    const arrSched   = f.arrival?.scheduledTimeLocal  || f.arrival?.scheduledTimeUtc;
                    return {
                        origin_iata:        f.departure?.airport?.iata || null,
                        origin_icao:        f.departure?.airport?.icao || null,
                        origin_name:        f.departure?.airport?.name || null,
                        origin_city:        f.departure?.airport?.municipalityName || null,
                        destination_iata:   f.arrival?.airport?.iata || null,
                        destination_icao:   f.arrival?.airport?.icao || null,
                        destination_name:   f.arrival?.airport?.name || null,
                        destination_city:   f.arrival?.airport?.municipalityName || null,
                        departure_time:     fmtTime(depRevised || depSched),
                        departure_terminal: f.departure?.terminal || null,
                        departure_gate:     f.departure?.gate || null,
                        arrival_time:       fmtTime(arrRevised || arrSched),
                        arrival_terminal:   f.arrival?.terminal || null,
                        arrival_gate:       f.arrival?.gate || null,
                        flightNumber:       f.number || null,
                        flightStatus:       f.status || null,
                        airline_name:       f.airline?.name || null,
                        source: 'aerodatabox'
                    };
                } catch (e) {
                    logger.debug('FUSION', `AeroDataBox failed for ${callsign}: ${e.message}`);
                    return null;
                }
            };

            const [adsbFiRoute, adbRoute] = await Promise.all([
                fetchRouteInfo(callsign),
                fetchAeroDataBox()
            ]);

            // Merge: AeroDataBox has schedule/gate; ADSB.fi has real-time routing
            if (adsbFiRoute || adbRoute) {
                return {
                    // Base from AeroDataBox (full schedule)
                    ...(adbRoute  || {}),
                    // ADSB.fi overrides airport codes (more real-time)
                    ...(adsbFiRoute ? {
                        origin_iata:      adsbFiRoute.origin_iata      || (adbRoute?.origin_iata),
                        origin_icao:      adsbFiRoute.origin_icao      || (adbRoute?.origin_icao),
                        origin_name:      adsbFiRoute.origin_name      || (adbRoute?.origin_name),
                        origin_city:      adsbFiRoute.origin_city      || (adbRoute?.origin_city),
                        destination_iata: adsbFiRoute.destination_iata || (adbRoute?.destination_iata),
                        destination_icao: adsbFiRoute.destination_icao || (adbRoute?.destination_icao),
                        destination_name: adsbFiRoute.destination_name || (adbRoute?.destination_name),
                        destination_city: adsbFiRoute.destination_city || (adbRoute?.destination_city),
                    } : {}),
                    // Schedule data always from AeroDataBox (ADSB.fi doesn't have times)
                    departure_time:     adbRoute?.departure_time     || null,
                    departure_terminal: adbRoute?.departure_terminal || null,
                    departure_gate:     adbRoute?.departure_gate     || null,
                    arrival_time:       adbRoute?.arrival_time       || null,
                    arrival_terminal:   adbRoute?.arrival_terminal   || null,
                    arrival_gate:       adbRoute?.arrival_gate       || null,
                    flightNumber:       adbRoute?.flightNumber || adsbFiRoute?.flightNumber || callsign,
                    flightStatus:       adbRoute?.flightStatus       || null,
                    airline_name:       adbRoute?.airline_name       || null,
                };
            }

            // Priority 3: Local Map (Airport/Route Dictionary)
            let localRoute = await fetchLocalOSINTRoute(callsign);
            if (localRoute) return localRoute;

            // Priority 4: DB stale cache (no times, but at least has codes)
            // Skip if status is "Arrived" — callsign may be reused for a new flight.
            if (dbRoute && dbRoute.flightStatus !== 'Arrived') {
                return {
                    origin_iata:        dbRoute.origin_iata        || dbRoute.departureAirport || 'N/A',
                    origin_name:        dbRoute.origin_name        || null,
                    origin_city:        dbRoute.origin_city        || null,
                    destination_iata:   dbRoute.destination_iata   || dbRoute.arrivalAirport   || 'N/A',
                    destination_name:   dbRoute.destination_name   || null,
                    destination_city:   dbRoute.destination_city   || null,
                    destination_weather: dbRoute.destination_weather || null,
                    flightNumber:       dbRoute.flightNumber       || callsign
                };
            }
            return { origin_iata: 'N/A', destination_iata: 'N/A', destination_weather: null };
        };
        const routePromise = resolveRouteWaterfall();

        // Execute concurrently
        const results = await Promise.allSettled([
            planespottersPromise,
            metadataPromise,
            routePromise
        ]);

        // Process Planespotters Photo
        let photoUrl = null;
        let photographer = null;
        if (results[0].status === 'fulfilled' && results[0].value?.photos?.length > 0) {
            const photo = results[0].value.photos[0];
            photoUrl = photo.thumbnail_large?.src || photo.thumbnail?.src || null;
            photographer = photo.photographer || null;
        }

        // Process Aircraft Metadata
        let aircraftInfo = { type: 'Unknown', manufacturer: 'Unknown', registration: 'Unknown', airline: 'Unknown', icon_type: 'STANDARD_JET', is_military_or_private: false };
        if (results[1].status === 'fulfilled' && results[1].value) {
            const data = results[1].value;
            if (data.isTacticalUnknown) {
                aircraftInfo.is_military_or_private = true;
                if (dbAircraft) {
                    aircraftInfo.type = dbAircraft.type_code || dbAircraft.type || 'Unknown';
                    aircraftInfo.manufacturer = dbAircraft.manufacturer || 'Unknown';
                    aircraftInfo.registration = dbAircraft.registration || 'Unknown';
                    aircraftInfo.airline = dbAircraft.operator || dbAircraft.airline || 'Unknown';
                    aircraftInfo.icon_type = dbAircraft.icon_type || 'STANDARD_JET';
                }
            } else {
                aircraftInfo = {
                    type: data.type || data.t || 'Unknown',
                    manufacturer: data.manufacturer || 'Unknown',
                    registration: data.registration || data.r || (dbAircraft ? dbAircraft.registration : 'Unknown'),
                    airline: data.airline || data.ownOp || (dbAircraft ? (dbAircraft.operator || dbAircraft.airline) : 'Unknown'),
                    icon_type: data.icon_type || (dbAircraft ? dbAircraft.icon_type : 'STANDARD_JET'),
                    description: data.description || data.desc || (dbAircraft ? (dbAircraft.model || dbAircraft.description) : null),
                    is_military_or_private: false
                };
            }
        } 

        // Process Route Data (VRS standing-data as final fallback)
        const vrsRoute = VrsDb.lookup(callsign);
        let routeInfo = {
            origin_iata: vrsRoute?.from || 'N/A',
            destination_iata: vrsRoute?.to || '---',
            destination_weather: null,
            flightNumber: callsign
        };
        if (results[2].status === 'fulfilled' && results[2].value) {
            const resolved = results[2].value;
            const validIata = (v) => v && v !== 'N/A' && v !== '---' ? v : null;
            routeInfo = {
                ...routeInfo,
                ...resolved,
                origin_iata:      validIata(resolved.origin_iata)      || vrsRoute?.from || 'N/A',
                destination_iata: validIata(resolved.destination_iata) || vrsRoute?.to   || '---',
            };
        }

        // [v12.5] ADSB-Fi Overrides for High-Fidelity Labels
        if (results[1].status === 'fulfilled' && results[1].value && results[1].value.flight) {
            routeInfo.flightNumber = results[1].value.flight.trim();
        }

        // [進階] Optional METAR fetch
        if (routeInfo.destination_iata && routeInfo.destination_iata !== 'N/A') {
            try {
                routeInfo.destination_weather = await fetchNOAAWeather(routeInfo.destination_iata);
            } catch(e) { /* ignore */ }
        }

        // [Fix] Airline fallback: derive from callsign if still Unknown
        if (!aircraftInfo.airline || aircraftInfo.airline === 'Unknown') {
            aircraftInfo.airline = getAirlineFromCallsign(callsign) || 'Unknown';
        }

        // 3. 【資料庫 Upsert】
        const mergedAircraft = {
            icao24: hex,
            hex,
            type: aircraftInfo.type,
            typecode: aircraftInfo.type,
            type_code: aircraftInfo.type,
            manufacturer: aircraftInfo.manufacturer,
            registration: aircraftInfo.registration,
            operator: aircraftInfo.airline,
            airline: aircraftInfo.airline,
            icon_type: aircraftInfo.icon_type,
            description:  aircraftInfo.description || micData?.model || (dbAircraft ? (dbAircraft.model || dbAircraft.description) : null),
            model:        aircraftInfo.model        || micData?.model || (dbAircraft ? dbAircraft.model : null),
            operator:     aircraftInfo.operator     || micData?.operator || aircraftInfo.airline || null,
            photo_url: photoUrl || (dbAircraft ? dbAircraft.photo_url : null),
            photographer: photographer || (dbAircraft ? dbAircraft.photographer : null),
            is_military_or_private: aircraftInfo.is_military_or_private,
            updatedAt: new Date()
        };

        const mergedRoute = {
            callsign,
            flightNumber:       routeInfo.flightNumber       || callsign,
            origin_iata:        routeInfo.origin_iata        || null,
            origin_icao:        routeInfo.origin_icao        || null,
            origin_name:        routeInfo.origin_name        || null,
            origin_city:        routeInfo.origin_city        || null,
            destination_iata:   routeInfo.destination_iata   || null,
            destination_icao:   routeInfo.destination_icao   || null,
            destination_name:   routeInfo.destination_name   || null,
            destination_city:   routeInfo.destination_city   || null,
            departure_time:     routeInfo.departure_time     || null,
            departure_terminal: routeInfo.departure_terminal || null,
            departure_gate:     routeInfo.departure_gate     || null,
            arrival_time:       routeInfo.arrival_time       || null,
            arrival_terminal:   routeInfo.arrival_terminal   || null,
            arrival_gate:       routeInfo.arrival_gate       || null,
            flightStatus:       routeInfo.flightStatus       || null,
            airline_name:       routeInfo.airline_name       || null,
            destination_weather: routeInfo.destination_weather || null,
            updatedAt: new Date()
        };

        logger.debug('FUSION', `Upserting to store: ${hex}/${callsign}`);
        
        await Promise.all([
            Aircraft.findOneAndUpdate({ $or: [{ hex }, { icao24: hex }] }, { $set: mergedAircraft }, { upsert: true, returnDocument: 'after' }),
            Route.findOneAndUpdate({ callsign }, { $set: mergedRoute }, { upsert: true, returnDocument: 'after' })
        ]);

        // 4. 【回傳】
        return {
            hex,
            callsign,
            flightNumber: routeInfo.flightNumber || callsign,
            aircraft: mergedAircraft,
            route: mergedRoute
        };

    } catch (err) {
        throw err;
    }
};

// ==========================================
// [v12.0] ADSB-Fi Open Data Fetcher
// ==========================================
async function fetchAdsbFiMetadata(hex) {
    try {
        const url = `https://opendata.adsb.fi/api/v2/hex/${hex}`;
        const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
        if (!response.ok) return null;
        const data = await response.json();
        
        // [v13.6 Resilience] Exhaustive check for field variations (f vs flight, t vs type, r vs registration)
        const a = data.aircraft ? (data.aircraft[0] || null) : data;
        if (a && (a.t || a.type || a.r || a.registration || a.f || a.flight || a.hex)) {
            return {
                type: a.t || a.type || null,
                registration: a.r || a.registration || null,
                manufacturer: a.manufacturer || null,
                airline: a.ownOp || a.operator || null,
                flight: (a.f || a.flight || '').trim() || null,
                description: a.desc || null
            };
        }
    } catch (e) {
        logAdsbFiFail('ADSBFI', `Fetch failed for ${hex}: ${e.message}`);
    }
    return null;
}
