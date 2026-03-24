const Aircraft = require('../models/Aircraft');
const Route = require('../models/Route');
const AirportDictionary = require('../models/AirportDictionary');
const RouteDictionary = require('../models/RouteDictionary');

// ICAO 3-letter prefix → airline name (client-side mirror for server-side fallback)
const CALLSIGN_PREFIX_AIRLINES = {
    AAL: 'American Airlines', UAL: 'United Airlines', DAL: 'Delta Air Lines',
    SWA: 'Southwest Airlines', SKW: 'SkyWest Airlines', ASA: 'Alaska Airlines',
    JBU: 'JetBlue Airways', FFT: 'Frontier Airlines', NKS: 'Spirit Airlines',
    BAW: 'British Airways', DLH: 'Lufthansa', AFR: 'Air France',
    KLM: 'KLM Royal Dutch Airlines', IBE: 'Iberia', AZA: 'ITA Airways',
    SAS: 'Scandinavian Airlines', FIN: 'Finnair', AUA: 'Austrian Airlines',
    SWR: 'Swiss International', TAP: 'TAP Air Portugal', THA: 'Thai Airways',
    SIA: 'Singapore Airlines', CPA: 'Cathay Pacific', JAL: 'Japan Airlines',
    ANA: 'All Nippon Airways', KAL: 'Korean Air', AAR: 'Asiana Airlines',
    CCA: 'Air China', CSN: 'China Southern', CES: 'China Eastern',
    CAL: 'China Airlines', EVA: 'EVA Air', MAS: 'Malaysia Airlines',
    GIA: 'Garuda Indonesia', PAL: 'Philippine Airlines', VNA: 'Vietnam Airlines',
    UAE: 'Emirates', QTR: 'Qatar Airways', ETD: 'Etihad Airways',
    THY: 'Turkish Airlines', SVR: 'Aeroflot', AFL: 'Aeroflot',
    EZY: 'easyJet', RYR: 'Ryanair', VLG: 'Vueling', BEL: 'Brussels Airlines',
    ETH: 'Ethiopian Airlines', KQA: 'Kenya Airways', SAA: 'South African Airways',
    QFA: 'Qantas', ANZ: 'Air New Zealand', AIC: 'Air India',
    MEA: 'Middle East Airlines', RAM: 'Royal Air Maroc', ELY: 'El Al Israel',
    AVA: 'Avianca', TAM: 'LATAM Airlines', GLO: 'GOL Airlines',
    AZU: 'Azul Brazilian Airlines', LAN: 'LATAM Airlines',
    WJA: 'WestJet', ACA: 'Air Canada', TSC: 'Air Transat',
};

function getAirlineFromCallsign(callsign) {
    if (!callsign) return null;
    const prefix = callsign.replace(/\d.*$/, '').toUpperCase().substring(0, 3);
    return CALLSIGN_PREFIX_AIRLINES[prefix] || null;
}

// Real Flight Route API via AeroDataBox
async function fetchRouteInfo(callsign) {
    if (!process.env.AERODATABOX_API_KEY) {
        console.warn('[FUSION WARN] Missing AERODATABOX_API_KEY, falling back to empty route');
        return null; // Return null so waterfall knows it failed
    }
    try {
        const res = await fetch(`https://aerodatabox.p.rapidapi.com/flights/callsign/${callsign}`, {
            headers: {
                'X-RapidAPI-Key': process.env.AERODATABOX_API_KEY,
                'X-RapidAPI-Host': 'aerodatabox.p.rapidapi.com'
            },
            signal: AbortSignal.timeout(4000)
        });
        if (!res.ok) throw new Error(`AeroDataBox API error: ${res.status}`);
        const data = await res.json();
        
        // Find the first active or scheduled flight in the array
        if (Array.isArray(data) && data.length > 0) {
            const flight = data[0];
            return {
                origin_iata: flight.departure?.airport?.iata || 'N/A',
                origin_name: flight.departure?.airport?.name || null,
                origin_city: flight.departure?.airport?.municipalityName || null,
                destination_iata: flight.arrival?.airport?.iata || 'N/A',
                destination_name: flight.arrival?.airport?.name || null,
                destination_city: flight.arrival?.airport?.municipalityName || null,
                destination_weather: null
            };
        }
        return null;
    } catch (err) {
        console.warn(`[FUSION FALLBACK] AeroDataBox fetch failed for ${callsign}:`, err.message);
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
        console.warn(`[FUSION FALLBACK] NOAA METAR fetch failed for ${iata}:`, err.message);
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
        console.warn(`[FUSION FALLBACK] Tar1090 fallback failed for hex ${hex}:`, err.message);
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
        console.error(`[FUSION ERROR] Failed to query local OSINT dictionaries:`, err.message);
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
        console.error(`[FUSION FATAL] Terminal error handling ${hex}/${callsign}: ${err.message}`);
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
            console.log(`[FUSION] 🏛️ Layer 0: Master DB Match for ${hex} (${dbAircraft.type_code})`);
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
            // Priority 0: Use already resolved DB metadata if available
            if (resolvedMetadata) return resolvedMetadata;

            // Layer 1: ADSB-Fi (New High-Quality Free Source)
            try {
                const adsbData = await fetchAdsbFiMetadata(hex);
                if (adsbData && (adsbData.t || adsbData.type)) {
                    console.log(`[FUSION] ✅ Resolved via ADSB-Fi for ${hex}`);
                    return adsbData;
                }
            } catch (e) {
                console.warn(`[FUSION] ADSB-Fi failed for ${hex}: ${e.message}`);
            }

            // Layer 2: HexDB (Existing Fallback)
            try {
                const res = await fetch(`https://hexdb.io/api/v1/aircraft/${hex}`, { signal: AbortSignal.timeout(4000) });
                if (res.ok) {
                    const data = await res.json();
                    if (data && (data.ICAOTypeCode || data.Type)) {
                        console.log(`[FUSION] ✅ Resolved via HexDB for ${hex}`);
                        return data;
                    }
                }
            } catch (e) {
                console.warn(`[FUSION] HexDB failed for ${hex}: ${e.message}`);
            }

            // Layer 3: Tar1090 Static Fallback
            console.log(`[FUSION] Deep fallback to tar1090 static layer for ${hex}...`);
            const tarData = await fetchTar1090Fallback(hex);
            if (tarData) return tarData;

            // Layer 4: Tactical Unknown
            console.log(`[FUSION] ⚠️ Aircraft ${hex} completely evaded resolution.`);
            isMilitaryOrPrivate = true;
            return { isTacticalUnknown: true };
        };

        const metadataPromise = metadataWaterfall();

        // Route Waterfall (Local OSINT -> AeroDataBox -> DB Route)
        const resolveRouteWaterfall = async () => {
            let routeInfo = await fetchLocalOSINTRoute(callsign);
            if (routeInfo) return routeInfo;
            
            console.log(`[FUSION] Local OSINT route missing for ${callsign}. Falling back to AeroDataBox...`);
            routeInfo = await fetchRouteInfo(callsign);
            if (routeInfo) return routeInfo;

            if (dbRoute) {
                return {
                    origin_iata: dbRoute.origin_iata || dbRoute.departureAirport || 'N/A',
                    origin_name: dbRoute.origin_name || null,
                    origin_city: dbRoute.origin_city || null,
                    destination_iata: dbRoute.destination_iata || dbRoute.arrivalAirport || 'N/A',
                    destination_name: dbRoute.destination_name || null,
                    destination_city: dbRoute.destination_city || null,
                    destination_weather: dbRoute.destination_weather || null
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
                    type: data.type || data.ICAOTypeCode || data.Type || 'Unknown',
                    manufacturer: data.manufacturer || data.Manufacturer || 'Unknown',
                    registration: data.registration || data.Registration || 'Unknown',
                    airline: data.airline || data.RegisteredOwners || 'Unknown',
                    icon_type: data.icon_type || (dbAircraft ? dbAircraft.icon_type : 'STANDARD_JET'),
                    is_military_or_private: false
                };
            }
        } 

        // Process Route Data
        let routeInfo = { origin_iata: 'N/A', destination_iata: 'N/A', destination_weather: null };
        if (results[2].status === 'fulfilled' && results[2].value) {
            routeInfo = results[2].value;
        }

        // [進階] Optional METAR fetch if destination is known
        if (routeInfo.destination_iata && routeInfo.destination_iata !== 'N/A' && routeInfo.destination_iata !== '---') {
            try {
                routeInfo.destination_weather = await fetchNOAAWeather(routeInfo.destination_iata);
            } catch(e) {
                console.warn(`[FUSION WARNING] NOAA METAR fetch failed for ${routeInfo.destination_iata}`);
            }
        }

        // [Fix] Airline fallback: if all sources returned 'Unknown', derive from callsign prefix
        if (!aircraftInfo.airline || aircraftInfo.airline === 'Unknown') {
            aircraftInfo.airline = getAirlineFromCallsign(callsign) || 'Unknown';
        }

        // [Fix] flightNumber fallback: use callsign when flight number is absent
        if (!routeInfo.flightNumber) {
            routeInfo.flightNumber = callsign;
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
            photo_url: photoUrl || (dbAircraft ? dbAircraft.photo_url : null),
            photographer: photographer || (dbAircraft ? dbAircraft.photographer : null),
            is_military_or_private: aircraftInfo.is_military_or_private,
            updatedAt: new Date()
        };

        const mergedRoute = {
            callsign,
            origin_iata: routeInfo.origin_iata,
            origin_name: routeInfo.origin_name,
            origin_city: routeInfo.origin_city,
            destination_iata: routeInfo.destination_iata,
            destination_name: routeInfo.destination_name,
            destination_city: routeInfo.destination_city,
            destination_weather: routeInfo.destination_weather,
            updatedAt: new Date()
        };

        console.log(`[FUSION] 💾 Upserting normalized data back to MongoDB for ${hex}/${callsign}`);
        
        await Promise.all([
            Aircraft.findOneAndUpdate({ $or: [{ hex }, { icao24: hex }] }, { $set: mergedAircraft }, { upsert: true, new: true }),
            Route.findOneAndUpdate({ callsign }, { $set: mergedRoute }, { upsert: true, new: true })
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
        
        // Normalize to internal format (ADSB-Exchange compatibility)
        if (data.aircraft && data.aircraft.length > 0) {
            const a = data.aircraft[0];
            return {
                type: a.t || a.type || null,
                registration: a.r || null,
                manufacturer: a.manufacturer || null,
                airline: a.ownOp || a.operator || null
            };
        }
    } catch (e) {
        console.warn(`[ADSBFI] Fetch failed: ${e.message}`);
    }
    return null;
}
