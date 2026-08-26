const { Worker } = require('worker_threads');
const path = require('path');

// Regression test for the posTime bug: workers/parser.js was silently
// dropping OpenSky's time_position (states[][3]), which left posTime null
// on every OpenSky-sourced record and caused isPositionUpdateTrustworthy()
// to bypass all arbitration guards for that data (see services/stateMerge.js).
function runParser(rawJsonString) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(path.join(__dirname, '..', 'workers', 'parser.js'));
        worker.once('message', (msg) => {
            worker.terminate();
            resolve(msg);
        });
        worker.once('error', (err) => {
            worker.terminate();
            reject(err);
        });
        worker.postMessage(rawJsonString);
    });
}

describe('workers/parser.js OpenSky state parsing', () => {
    test('extracts time_position (index 3) into posTime', async () => {
        const payload = JSON.stringify({
            time: 1700000200,
            states: [
                ['abc123', 'TEST123 ', 'Taiwan', 1700000123, 1700000125, 121.5, 25.0, 10000, false, 200, 90, 0, null, 10500, '1234', false, 0, 0],
            ],
        });

        const result = await runParser(payload);

        expect(result.success).toBe(true);
        expect(result.planes).toHaveLength(1);
        expect(result.planes[0].posTime).toBe(1700000123);
        expect(result.planes[0].icao24).toBe('abc123');
        expect(result.planes[0].callsign).toBe('TEST123');
    });

    test('posTime is null when OpenSky reports null time_position', async () => {
        const payload = JSON.stringify({
            time: 1700000200,
            states: [
                ['abc123', 'TEST123 ', 'Taiwan', null, 1700000125, 121.5, 25.0, 10000, false, 200, 90, 0, null, 10500, '1234', false, 0, 0],
            ],
        });

        const result = await runParser(payload);

        expect(result.planes[0].posTime).toBeNull();
    });
});
