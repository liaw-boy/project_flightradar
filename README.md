# AEROSTRAT 全球航空監控系統

AEROSTRAT 是一款專為高效能設計的全球實時航空交通監控系統。系統整合了多個 ADS-B 遙測資料源，透過後端資料融合（Data Fusion）與元數據增強，並利用 WebSocket 增量編碼技術，在前端實現了 60fps 的平滑航空雷達視覺化體驗。

---

## 核心功能

### 1. 高完整度即時追蹤
- **多源資料融合**：整合 OpenSky Network、ADSB-Fi 等多個遙測平台資料。
- **4層元數據解析**：系統依序從內建 CSV 索引、本地 SQLite 快取、第三方 fallback API 以及外部專業航空資料庫獲取航機詳細資訊。
- **空間過濾（Spatial Filtering）**：WebSocket 僅針對各客戶端的地圖視野邊界（BBox）推送相關飛機資料，大幅節省頻寬。

### 2. 極致視覺體驗
- **60fps Canvas 渲染**：捨棄傳統 DOM/SVG 標記，直接在 Canvas 上進行萬級點位的高效繪製。
- **航位推算（Dead Reckoning）**：利用航機最後已知的速度、航向與位置，在資料更新間隙自動模擬平滑移動。
- **高度色彩編碼**：動態軌跡依據高度進行藍、綠、黃、紅漸層染色，清晰展現爬升與下降狀態。

### 3. 會話與歷史回放
- **持久化軌跡存儲**：採用 SQLite (WAL 模式) 記錄每一條飛行路徑，支持 24 小時內的完整歷史回放。
- **時光機回放系統**：支持透過時間軸拖動，回溯全球任意時間點的航空態勢。

### 4. 管理與安全 (NEW)
- **認證系統**：整合安全的用戶登入與權限驗證機制。
- **管理後台**：內置管理控制台（Admin Panel），支持系統運行監控與基礎資料維護。

---

## 技術架構

### 後端 (Backend)
*   **運行環境**：Node.js 24+ / Express 5
*   **實時通訊**：WebSocket (MessagePack 二進制封裝)
*   **資料存儲**：
    *   **SQLite**：儲存飛行會話（Flight Sessions）與高頻航跡點（Track Points）。
    *   **In-Memory**：Airport、Route、Aircraft Shape 等靜態字典。
*   **併發處理**：使用 Worker Threads 處理大量 JSON 遙測資料解析，避免阻塞主線程。

### 前端 (Frontend)
*   **框架**：React 19 / Vite 6
*   **地圖引擎**：Leaflet 1.9 + 自研 Canvas 渲染引擎
*   **性能優化**：
    *   **Zero-GC Rendering**：使用 Float32Array 環形緩衝區存儲軌跡。
    *   **三層快取**：React State (L1) → In-memory LRU (L2) → IndexedDB (L3)。
    *   **Web Worker**：將 WebSocket 解碼與複雜邏輯移至後台線程。

---

## 目錄結構

```text
project_aerostrat/
├── backend/
│   ├── db/                 # 資料庫存取層 (SQLite/Session)
│   ├── scripts/            # 資料同步與初始化腳本
│   ├── workers/            # 遙測數據解析 Worker
│   ├── server.js           # API 與 API Gateway
│   └── socketEngine.js     # WebSocket 增量編碼引擎
├── client/
│   ├── src/
│   │   ├── components/     # 地圖引擎與介面組件
│   │   ├── hooks/          # 資料狀態與實時邏輯
│   │   ├── services/       # 持久化與快取管理 (IndexedDB)
│   │   ├── store/          # 全域狀態管理
│   │   └── workers/        # WebSocket 處理線程
└── docker-compose.yml      # 容器化部署配置
```

---

## 快速啟動

### 環境要求
- Node.js 18.0 或更高版本
- 磁碟空間：約 500MB (供 SQLite 24h 軌跡緩衝)

### 1. 配置環境變量
在 `backend/` 目錄下建立 `.env` 文件：
```env
PORT=3000
MONGODB_USE_LOCAL=false
# 填入您的 OpenSky 或其他 ADS-B 來源金鑰
```

### 2. 安裝與啟動 (開發模式)
從項目根目錄執行：
```bash
# 安裝依賴
npm install

# 同步基礎資料（首次運行）
cd backend && node scripts/syncOsintData.js

# 啟動開發伺服器
cd ..
npm run dev
```
訪問 `http://localhost:3005` 啟動前端介面。

### 3. 部署 (生產模式)
推薦使用 PM2 進行管理：
```bash
cd backend
pm2 start ecosystem.config.js
```

---

## 測試
本專案使用 Playwright 進行 End-to-End 測試：
```bash
cd client
npx playwright test
```

---

## 數據來源說明
本系統接入以下公開遙測協議與 API：
- OpenSky Network
- ADSB-Fi / airplanes.live
- OurAirports (機場數據)
- Virtual Radar Server (航路與機型數據)

---

## 授權
[請在此插入您的授權協議，例如 MIT]
