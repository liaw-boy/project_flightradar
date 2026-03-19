---
name: aerostrat-canvas-renderer
description: >
  AEROSTRAT 專案專用的 Canvas 飛機渲染技能。當使用者需要新增飛機圖示、
  修改地圖渲染邏輯、處理 WebSocket 即時更新、或優化 60 FPS Canvas 效能時，
  必須使用此技能。任何涉及 MapView、Canvas 繪圖、SVG 圖示、飛機旋轉、
  ImageBitmap 快取、或 socketEngine 的任務都應觸發此技能。
---

# AEROSTRAT Canvas 渲染技能

本技能涵蓋 AEROSTRAT 專案中最核心也最容易出錯的兩個領域：
**Canvas 渲染引擎** 與 **WebSocket 即時資料流**。

---

## 核心原則

### 1. Zero-GC 渲染（60 FPS）

目標是讓主渲染迴圈零垃圾回收（GC），保持 60 FPS。

**必須遵守：**
```javascript
// ✅ 正確：預先快取 ImageBitmap
const cache = new Map(); // 在元件外部建立，跨幀共用

async function getAircraftBitmap(type, heading) {
  const key = `${type}-${Math.round(heading / 5) * 5}`; // 每 5° 一個 key
  if (!cache.has(key)) {
    const svg = generateAircraftSVG(type);
    const blob = new Blob([svg], { type: 'image/svg+xml' });
    const bitmap = await createImageBitmap(await blob.arrayBuffer()
      .then(b => new Blob([b], { type: 'image/svg+xml' })));
    cache.set(key, bitmap);
  }
  return cache.get(key);
}

// ✅ 正確的繪圖封裝
function drawAircraft(ctx, x, y, heading, bitmap) {
  ctx.save();                          // 保存狀態
  ctx.translate(x, y);                 // 移至飛機座標
  ctx.rotate((heading * Math.PI) / 180); // 套用校準後的航向
  ctx.drawImage(bitmap, -16, -16, 32, 32);
  ctx.restore();                       // 還原狀態
}
```

**禁止：**
```javascript
// ❌ 錯誤：在渲染迴圈內解析 SVG
function renderLoop() {
  aircraft.forEach(plane => {
    const svg = generateSVG(plane.type); // 每幀重新生成
    const img = new Image();
    img.src = `data:image/svg+xml,${svg}`; // 觸發 GC
  });
}

// ❌ 錯誤：忘記 restore
ctx.save();
ctx.rotate(angle);
ctx.drawImage(bitmap, x, y);
// 沒有 ctx.restore()！後續繪圖全部跑偏
```

---

### 2. 飛機旋轉校準

**概念：** 飛機 SVG 圖示朝上（North = 0°），但 Canvas `rotate()` 以「3點鐘方向」為 0°。

```javascript
// ✅ 正確：加入 rotationOffset 校準
const ROTATION_OFFSET = -Math.PI / 2; // -90° 校準

function getCanvasRotation(trueTrack) {
  // trueTrack：飛機真實航向（0° = 北，順時針）
  return (trueTrack * Math.PI) / 180 + ROTATION_OFFSET;
}

// 使用範例
ctx.rotate(getCanvasRotation(plane.true_track));
```

---

### 3. WebSocket 分區廣播

`socketEngine.js` 根據地圖視窗（bounding box）過濾飛機，只推送當前視窗內的資料。

**修改 socketEngine 時的檢查清單：**
- [ ] 確認訂閱/取消訂閱的事件名稱一致（`subscribe-region` / `unsubscribe-region`）
- [ ] 確認 bounding box 格式：`{ north, south, east, west }`
- [ ] 確認廣播前有做範圍過濾，禁止全量廣播
- [ ] 確認 msgpack-lite 序列化正確

```javascript
// ✅ 正確：分區廣播模式
wss.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = msgpack.decode(data);
    if (msg.type === 'subscribe-region') {
      ws.region = msg.bbox; // 儲存訂閱區域
    }
  });
});

// 廣播時過濾
function broadcastToRegion(aircraft) {
  wss.clients.forEach(client => {
    if (!client.region) return;
    const filtered = aircraft.filter(a => isInRegion(a, client.region));
    if (filtered.length > 0) {
      client.send(msgpack.encode({ type: 'update', data: filtered }));
    }
  });
}
```

---

### 4. MongoDB 軌跡查詢模式

```javascript
// ✅ 正確：利用 TTL index，查詢近期軌跡
const tracks = await FlightTrack.find({
  icao24: plane.icao24,
  timestamp: { $gte: Date.now() - 3600000 } // 最近 1 小時
}).sort({ timestamp: 1 }).lean(); // lean() 減少記憶體消耗

// 注意：TTL 設定為 48 小時，超過會自動刪除
// Schema 中應有：trackSchema.index({ timestamp: 1 }, { expireAfterSeconds: 172800 })
```

---

## 新增飛機圖示類型的標準流程

1. 在 `client/src/utils/` 新增 SVG 生成函式
2. 在 ImageBitmap 快取的 key 中加入新類型識別碼
3. 在 `rotationOffset` 常數確認圖示方向（SVG 預設必須朝北）
4. 在 Canvas 渲染迴圈中加入新類型的分支判斷
5. 測試 60 FPS 不降幀（開 Chrome DevTools Performance 確認）

---

## 常見 Bug 及解法

| 問題 | 原因 | 解法 |
|------|------|------|
| 飛機方向全部偏 90° | 未套 rotationOffset | 加上 `ROTATION_OFFSET = -Math.PI/2` |
| Canvas 繪圖狀態累積污染 | 缺少 restore() | 每個 drawAircraft 都包 save/restore |
| 幀率掉到 30 FPS 以下 | 渲染迴圈內解析 SVG | 移至 ImageBitmap 預先快取 |
| WebSocket 推送全部飛機 | 未做分區過濾 | 在 socketEngine 加 bounding box 過濾 |
| msgpack 解碼失敗 | 前後端版本不一致 | 確認兩端都使用 msgpack-lite 同版本 |
