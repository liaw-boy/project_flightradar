# AEROSTRAT 全球航空雷達系統

即時全球航空交通監控平台，整合多來源 ADS-B 資料，提供 60fps 動態地圖、飛行軌跡記錄與歷史回放功能。

---

## 技術架構

**後端**：Node.js + Express + WebSocket (`ws`)
**前端**：React (Vite) + Leaflet + Canvas 渲染
**資料庫**：SQLite (`better-sqlite3`)
**協定**：WebSocket binary (msgpack-lite)

```
project_aerostrat/
├── backend/
│   ├── server.js           # 主伺服器：API、資料融合、輪詢排程
│   ├── socketEngine.js     # WebSocket 引擎：delta 推送、track_point 推送
│   ├── db/
│   │   ├── trackStore.js   # 飛行軌跡 SQLite 存取
│   │   ├── sessionStore.js # 飛行會話管理
│   │   └── routeStore.js   # 航線資料庫
│   └── config.js
├── client/src/
│   ├── components/
│   │   └── MapView.jsx     # Canvas 地圖引擎：DR 插值、軌跡渲染、SVG 機型圖示
│   ├── hooks/
│   │   └── useFlightData.js # 資料狀態管理、Dead Reckoning 更新
│   └── workers/
│       └── flightWorker.js  # WebSocket 連線、msgpack 解碼
├── docker-compose.yml
└── deploy.sh
```

---

## 核心功能

### 即時資料
- 每 10-25 秒從 ADS-B 來源（adsb.lol / Airplanes.Live）取得全球航機位置
- WebSocket delta 編碼推送，只傳送有變化的欄位
- 空間過濾：每個客戶端只收到自己視野範圍內的飛機

### 動畫顯示
- **Dead Reckoning**：依最後已知位置、速度、航向持續推算當前位置，實現 60fps 平滑移動
- **軌跡顏色編碼**：依高度由低到高呈現藍→綠→黃→紅漸層
- **Live Extension**：從最後記錄點延伸虛線至目前 DR 位置（最長 10 分鐘）

### 飛行軌跡
- SQLite 記錄每架飛機的航跡點，保留 24 小時
- 歷史軌跡回放（時間軸拖拉）
- WS `track_point` 即時推送給選取中飛機的客戶端

### 機型識別
- 依 `typecode`（A388、B77W 等）渲染對應輪廓 SVG
- 支援窄體、廣體、巨無霸、輕型機、直升機

---

## 快速啟動

### 開發環境

```bash
# 後端
cd backend
cp .env.example .env   # 填入 API 金鑰
npm install
node server.js

# 前端（另開 terminal）
cd client
npm install
npm run dev            # http://localhost:5173
```

### 生產環境（PM2）

```bash
npm install -g pm2
pm2 start backend/server.js --name aerostrat
```

### Docker

```bash
docker compose up -d
```

服務啟動後前往 `http://localhost:3000`。

---

## 環境變數

在 `backend/.env` 設定：

```env
PORT=3000
NODE_ENV=production
```

API 金鑰依所使用的 ADS-B 資料來源填入（見 `backend/config.js`）。

---

## 資料來源

本系統對接以下 ADS-B 公開 API：

- [adsb.lol](https://api.adsb.lol) — 全球基準資料
- [Airplanes.Live](https://airplanes.live) — 備援來源

---

## 系統需求

- Node.js 18+
- 磁碟空間：SQLite 軌跡資料庫每日約 500MB（含 24h TTL 自動清理）
- 記憶體：建議 1GB+（依同時追蹤飛機數而定）
