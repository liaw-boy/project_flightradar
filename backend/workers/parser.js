const { parentPort } = require('worker_threads');

// 監聽主執行緒傳來的原始 JSON 字串
parentPort.on('message', (rawJsonString) => {
    try {
        const startTime = Date.now();
        const data = JSON.parse(rawJsonString);
        const planes = [];

        if (data.states) {
            for (let i = 0; i < data.states.length; i++) {
                const plane = data.states[i];
                const icao24 = plane[0];
                const callsign = plane[1] ? plane[1].trim() : '';

                // 經緯度不可為空
                if (plane[5] === null || plane[6] === null) continue;

                let altitude = plane[7] !== null ? Math.round(plane[7]) : 'N/A';
                let onGround = plane[8];
                let velocity = plane[9] || 0;
                const heading = plane[10] || 0;

                // 若高度過低卻未標示為地面，強制校正
                if (altitude !== 'N/A' && altitude < 1500) {
                    onGround = true;
                    altitude = 'GROUND';
                    velocity = 0;
                }

                // 僅回傳 V2 前端動畫與渲染所需的最輕量化欄位
                const nowUnix = Math.floor(Date.now() / 1000);
                const lastContact = plane[4] || nowUnix;

                planes.push({
                    icao24,
                    callsign,
                    lat: plane[6],
                    lng: plane[5],
                    altitude,
                    velocity,
                    heading,
                    onGround,
                    isEmergency: ['7700', '7600', '7500'].includes(plane[14]),
                    category: plane[17] || 0,
                    // [V2.0.0] 為了讓 Sidebar 正確顯示，補回原本必要的欄位
                    country: plane[2] || 'Unknown',
                    geoAltitude: plane[13] ? Math.round(plane[13]) : null,
                    vRate: plane[11] || 0,
                    squawk: plane[14] || '',
                    spi: plane[15] || false,
                    positionSource: plane[16] || 0,
                    lastContact
                });
            }
        }

        const parseTimeMs = Date.now() - startTime;

        // 傳回解析完的輕量陣列
        parentPort.postMessage({
            success: true,
            planes,
            parseTimeMs,
            time: data.time || Math.floor(Date.now() / 1000)
        });

    } catch (error) {
        parentPort.postMessage({ success: false, error: error.message });
    }
});
