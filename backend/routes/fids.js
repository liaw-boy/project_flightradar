'use strict';
function registerFidsRoutes(app, { getFidsBoard, listBoardAirports }) {
    app.get('/api/fids/airports', (req, res) => {
        res.json(listBoardAirports());
    });

    app.get('/api/fids/board', (req, res) => {
        const iata = (req.query.iata || 'TPE').toUpperCase();
        const board = getFidsBoard(iata);
        if (!board) {
            return res.status(404).json({ error: `No board data for ${iata} yet — try again shortly` });
        }
        res.json({ iata, ...board });
    });
}

module.exports = { registerFidsRoutes };
