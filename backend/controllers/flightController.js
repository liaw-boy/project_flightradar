const Aircraft = require('../models/Aircraft');
const Route = require('../models/Route');
const AirportDictionary = require('../models/AirportDictionary');
const RouteDictionary = require('../models/RouteDictionary');
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

// [v13.0] Remove paid AeroDataBox API — use open data only
async function fetchRouteInfo(callsign) {
    return null; // Force fallback to local/open-source logic
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

// Local Route & Airport Dictionary Lookup
async function fetchLocalOSINTRoute(callsign) {
    try {
        const routeDict = await RouteDictionary.findOne({ callsign }).lean();
        if (!routeDict) return null;

        let origin = { iata: routeDict.originIata, name: null, city: null };
        let destination = { iata: routeDict.destinationIata, name: null, city: null };

        // Expand via AirportDictionary
        if (origin.iata) {
            const ap = await AirportDictionary.findOne({ iata: origin.iata }).lean();
            if (ap) { origin.name = ap.name; origin.city = ap.city; }
        }
        if (destination.iata) {
            const ap = await AirportDictionary.findOne({ iata: destination.iata }).lean();
            if (ap) { destination.name = ap.name; destination.city = ap.city; }
        }

        return {
            origin_iata: origin.iata || 'N/A',
            origin_name: origin.name,
            origin_city: origin.city,
            destination_iata: destination.iata || 'N/A',
            destination_name: destination.name,
            destination_city: destination.city,
            destination_weather: null
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

    // 1. 【DB Read-Through】— skip entirely when MongoDB is not connected
    const mongoose = require('mongoose');
    const dbConnected = mongoose.connection.readyState === 1;
    const dbAircraft = dbConnected ? await Aircraft.findOne({ $or: [{ hex }, { icao24: hex }] }).lean() : null;
    const dbRoute    = dbConnected ? await Route.findOne({ callsign }).lean() : null;

    try {
        // [v12.0] High-Performance Layer 0: Local Master Database (tar1090-db)
        let resolvedMetadata = null;
        if (dbAircraft && dbAircraft.type_code) {
            logger.debug('FUSION', `L0 DB match: ${hex} → ${dbAircraft.type_code}`);
            resolvedMetadata = {
                type: dbAircraft.type_code,
                registration: dbAircraft.registration || 'Unknown',
                manufacturer: dbAircraft.manufacturer || 'Unknown',
                airline: dbAircraft.operator || dbAircraft.airline || 'Unknown',
                icon_type: dbAircraft.icon_type || 'STANDARD_JET'
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
            let routeInfo = await fetchLocalOSINTRoute(callsign);
            if (routeInfo) return routeInfo;
            
            // [v13.0] Tar1090-style Callsign Prefix Logic
            const prefix = callsign.substring(0, 3);
            if (CALLSIGN_PREFIX_AIRLINES[prefix]) {
                const isTWAIR = ['CAL','EVA','MDA','UIA','TTW','SJX'].includes(prefix);
                return {
                    origin_iata: isTWAIR ? 'TPE' : 'LHR', 
                    destination_iata: isTWAIR ? 'NRT' : 'JFK', 
                    origin_name: isTWAIR ? 'Taiwan Taoyuan Int\'l' : 'London Heathrow',
                    destination_name: isTWAIR ? 'Tokyo Narita Int\'l' : 'New York JFK',
                    isPlaceholder: true
                };
            }

            if (dbRoute) {
                return {
                    origin_iata: dbRoute.origin_iata || dbRoute.departureAirport || 'N/A',
                    origin_name: dbRoute.origin_name || null,
                    origin_city: dbRoute.origin_city || null,
                    destination_iata: dbRoute.destination_iata || dbRoute.arrivalAirport || 'N/A',
                    destination_name: dbRoute.destination_name || null,
                    destination_city: dbRoute.destination_city || null,
                    destination_weather: dbRoute.destination_weather || null,
                    flightNumber: dbRoute.flightNumber || callsign
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
                    description: data.description || data.desc || (dbAircraft ? dbAircraft.description : null),
                    is_military_or_private: false
                };
            }
        } 

        // Process Route Data
        let routeInfo = { origin_iata: 'N/A', destination_iata: 'N/A', destination_weather: null, flightNumber: callsign };
        if (results[2].status === 'fulfilled' && results[2].value) {
            routeInfo = { ...routeInfo, ...results[2].value };
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
            description: aircraftInfo.description || (dbAircraft ? dbAircraft.description : null),
            photo_url: photoUrl || (dbAircraft ? dbAircraft.photo_url : null),
            photographer: photographer || (dbAircraft ? dbAircraft.photographer : null),
            is_military_or_private: aircraftInfo.is_military_or_private,
            updatedAt: new Date()
        };

        const mergedRoute = {
            callsign,
            flightNumber: routeInfo.flightNumber || callsign,
            origin_iata: routeInfo.origin_iata,
            origin_name: routeInfo.origin_name,
            origin_city: routeInfo.origin_city,
            destination_iata: routeInfo.destination_iata,
            destination_name: routeInfo.destination_name,
            destination_city: routeInfo.destination_city,
            destination_weather: routeInfo.destination_weather,
            updatedAt: new Date()
        };

        logger.debug('FUSION', `Upserting to MongoDB: ${hex}/${callsign}`);
        
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
