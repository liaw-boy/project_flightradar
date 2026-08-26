'use strict';
function registerFidsRoutes(app, { queryFlights, getStats, listBoardAirports, getAirportInfo }) {
    function resolveAirport(req) {
        const codes = listBoardAirports().map(a => a.code);
        const code = (req.query.airport || 'TPE').toUpperCase();
        return codes.includes(code) ? code : 'TPE';
    }

    app.get('/api/airports', (req, res) => {
        res.json({ airports: listBoardAirports() });
    });

    app.get('/api/flights', (req, res) => {
        const code = resolveAirport(req);
        const direction = req.query.direction === 'departure' ? 'departure' : 'arrival';
        const result = queryFlights({
            code,
            direction,
            terminal: req.query.terminal || null,
            airline: req.query.airline || null,
            q: req.query.q || null,
            cargo: req.query.cargo === '1',
            history: req.query.all === '1',
        }, getAirportInfo);
        res.json({
            airport: code,
            direction,
            lastUpdated: result.lastUpdated,
            count: result.flights.length,
            flights: result.flights,
        });
    });

    app.get('/api/flights/stats', (req, res) => {
        const code = resolveAirport(req);
        const direction = req.query.direction === 'departure' ? 'departure' : 'arrival';
        res.json(getStats({ code, direction, cargo: req.query.cargo === '1' }, getAirportInfo));
    });
}

module.exports = { registerFidsRoutes };
