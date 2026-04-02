const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:9222/devtools/page/D45911AB16D36445C26013FEC68A3C4C');

ws.on('open', () => {
    ws.send(JSON.stringify({ id: 1, method: 'Log.enable' }));
    ws.send(JSON.stringify({ id: 2, method: 'Runtime.enable' }));
    console.log('Connected.');
});

ws.on('message', data => {
    try {
        const msg = JSON.parse(data);
        if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
            console.log('LOG_ERROR:', msg.params.entry.text);
        }
        if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
            const args = msg.params.args.map(a => a.value || a.description).join(' ');
            console.log('RUNTIME_ERROR:', args);
        }
    } catch (e) { }
});

setTimeout(() => {
    console.log('Done collecting logs.');
    process.exit(0);
}, 2000);
