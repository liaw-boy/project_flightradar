# AEROSTRAT — 全球即時航空監控系統

即時全球 ADS-B 航空監控平台。後端從多來源融合 ADS-B 遙測資料，配合機型、航線等 Metadata 豐富化後，透過 WebSocket 以 Delta 編碼 + MessagePack 二進位格式串流至前端地圖介面。

---

## 技術棧

| 層級 | 技術 |
|------|------|
| 後端 | Node.js 24+ / Express 5 / Mongoose 9，Port **3000** |
| 前端 | React 19 / Vite 6 / Leaflet 1.9，Port **3005** (dev) |
| 資料庫 | MongoDB（本機，`aerostrat` database） |
| 套件管理 | npm（後端 CommonJS，前端 ES Modules） |

---

## 快速啟動

```bash
# 同時啟動後端 (:3000) + 前端 (:3005)
npm run dev

# 僅後端
cd backend && npm start
# 健康檢查：http://localhost:3000/api/health

# 僅前端
cd client && npm run dev
```

**首次安裝後需初始化資料：**

```bash
cd backend
node scripts/syncOsintData.js   # 從遠端 CSV 載入機場與航線參考資料
npm run seed-shapes              # 載入機型 SVG 輪廓（AircraftShape）
npm run sync-mictronics          # 同步 Mictronics 機型登記資料庫
```

---

## 環境變數（`/backend/.env`）

```
PORT=3000
MONGODB_URI=mongodb://localhost:27017/aerostrat

# OpenSky 5 帳號輪替池
OPENSKY_USER1–5 / OPENSKY_PASS1–5

PRIMARY_TELEMETRY_URL      # 預設：OpenSky Network
FALLBACK_TELEMETRY_URL     # 預設：api.adsb.lol

AERODATABOX_API_KEY
TDX_CLIENT_ID / TDX_CLIENT_SECRET
```

---

## 系統架構

### 資料流

```
OpenSky API（30s cron，5 帳號輪替）
  → backend/workers/parser.js（Worker Thread，off-main JSON 解析）
  → MongoDB 豐富化（Aircraft、Route、TrackPoint collections）
  → backend/socketEngine.js（Delta 編碼 → msgpack → WebSocket 依 bbox 過濾推送）
  → client/src/workers/flightWorker.js（Off-thread 解碼，33ms debounce flush）
  → React state（App.jsx）→ MapView.jsx Canvas（60fps）
```

### 後端主要檔案

| 檔案 | 用途 |
|------|------|
| `backend/server.js` | Express 主程式、OpenSky 輪詢、所有 API 路由、Session 狀態機 |
| `backend/socketEngine.js` | Delta 編碼飛機狀態 → msgpack → 依 client bbox 廣播 |
| `backend/controllers/flightController.js` | 4 層 Metadata + 航線融合、外部 API 整合 |
| `backend/workers/parser.js` | Worker Thread：OpenSky 原始陣列 → 輕量飛機物件 |
| `backend/config.js` | dotenv 載入（PORT、MONGODB_URI） |
| `backend/scripts/syncOsintData.js` | 下載/同步機場與航線參考資料 |
| `backend/ecosystem.config.js` | PM2 設定（單 instance，512MB 上限，log → `./logs/`） |

**MongoDB Collections**：Aircraft、Airport、AircraftRegistry、AircraftShape、Airline、AirportDictionary、RouteDictionary、FlightSession、ActiveFlight、TrackPoint（TTL 24h，time-series）、Route、Metar。

**API 路由**（皆在 `/api` 下）：

| 路由 | 說明 |
|------|------|
| `GET /planes/bbox` | 空間過濾，回應 <5ms |
| `GET /flight-details/:hex/:cs` | 融合機型 + 航線資料 |
| `GET /metadata/:icao24` | 單筆機型 Metadata |
| `POST /metadata/batch` | 批次 Metadata 查詢 |
| `GET /route/:icao24` | 航線查詢 |
| `GET /tracks` | 歷史軌跡 |
| `GET /airports/list` | 機場清單 |
| `GET /metar` | 天氣資料 |
| `GET /stats` | 系統統計 |
| `GET /health` | 健康檢查 |

### 前端主要檔案

| 檔案 | 用途 |
|------|------|
| `client/src/App.jsx` | State root；管理選中飛機、篩選條件、縮放、播放 |
| `client/src/components/MapView.jsx` | 自訂 Leaflet Canvas layer；Path2D SVG 快取、軌跡環形 buffer、航向旋轉 |
| `client/src/hooks/useFlightData.js` | BBox-aware 輪詢 + WebSocket 管理，含自動 fallback |
| `client/src/workers/flightWorker.js` | Off-thread WebSocket + msgpack 解碼；維護飛機 Map；指數退避重連 |
| `client/src/services/dataManager.js` | L1/L2/L3 快取門面（React state → LRU 500 筆/30min → IndexedDB） |
| `client/src/store/FlightDataStore.js` | Zero-GC TypedArray 環形 buffer（Float32Array）存軌跡歷史 |
| `client/src/utils/aircraftIcons.js` | 50+ 機型 SVG 路徑、高度色彩映射、縮放比例計算 |

---

## 關鍵設計

**Delta 編碼**：每次 WebSocket 幀只包含 lat/lng（±0.0001°）或 heading（±1°）有變化的飛機，以及獨立的移除清單。

**Zero-GC 渲染**：`FlightDataStore` 使用固定大小 `Float32Array` 環形 buffer；`MapView` 快取 `Path2D` 物件並重用座標參考，避免 60fps Canvas 渲染產生 GC 壓力。

**多帳號 OpenSky 輪替**：在收到 429 或配額低於 50 次時自動切換至下一個帳號（共 5 個）。

**4 層 Metadata 解析**（由快到慢）：本機 CSV 索引 → MongoDB Aircraft → Tar1090 fallback → 外部 API。

**3 層前端快取**：L1 React state（即時）→ L2 LRU 記憶體（30min TTL）→ L3 IndexedDB（持久化，機場 + 機型輪廓）。

---

## 部署

### PM2

```bash
cd backend && pm2 start ecosystem.config.js   # 以 'aerostrat' 啟動
pm2 logs aerostrat                            # 追蹤日誌
```

### Docker（後端 + MongoDB，不含前端容器）

```bash
docker-compose up -d
```

OpenSky 帳號憑證檔案位於 `backend/credentials1–5.json`（Docker 中以 read-only volume 掛載）。

---

## E2E 測試

需同時啟動後端（:3000）與前端（:3005）。

```bash
cd client && npx playwright test
cd client && npx playwright test tests/e2e/aerostrat.spec.js
cd client && npx playwright show-report ../pw-report
```

> 目前無 unit / integration 測試；後端與前端 `package.json` 的 test scripts 為 stub。
