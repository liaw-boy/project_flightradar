# AEROSTRAT

> **高效能全球航空監控與實時雷達系統**

[![React](https://img.shields.io/badge/Frontend-React%2019-61DAFB?style=flat-square&logo=react)](https://reactjs.org/)
[![Node.js](https://img.shields.io/badge/Backend-Node.js%2024-339933?style=flat-square&logo=nodedotjs)](https://nodejs.org/)
[![SQLite](https://img.shields.io/badge/Database-SQLite%203-003B57?style=flat-square&logo=sqlite)](https://www.sqlite.org/)
[![Leaflet](https://img.shields.io/badge/Map-Leaflet%201.9-199900?style=flat-square&logo=leaflet)](https://leafletjs.com/)
[![Playwright](https://img.shields.io/badge/Tests-Playwright-45ba4b?style=flat-square&logo=playwright)](https://playwright.dev/)

AEROSTRAT 是一款專為航空愛好者設計的全球實時監控平台。系統整合 OpenSky、ADSB-Fi 等多源資料，透過二進制 WebSocket 協議與 60fps Canvas 渲染技術，提供流暢專業的雷達體驗。

**線上展示 →** https://flyradar.spkuan.cc

---

## 目錄

- [介面預覽](#介面預覽)
- [主要功能](#主要功能)
- [技術架構](#技術架構)
- [目錄結構](#目錄結構)
- [快速開始](#快速開始)
- [環境變數](#環境變數)
- [部署](#部署)
- [測試](#測試)

---

## 介面預覽

### 主畫面 — 全球雷達地圖

![主畫面](docs/images/01-homepage.png)

*全球 ADS-B 即時飛機分佈，金色點陣為各架飛機，點擊後顯示側邊欄詳情*

### 即時飛機顯示

![飛機顯示](docs/images/02-map-aircraft.png)

*Canvas 渲染引擎，60fps 平滑移動；金色圖示，選中後顯示亮金高亮*

### 搜尋功能

![搜尋](docs/images/03-search.png)

*全文搜尋：輸入呼號 (CI101)、ICAO24 地址或機型代碼，即時定位；輸入時右側顯示清除按鈕*

### 登入系統

![登入](docs/images/04-auth.png)

*登機證風格登入介面；支援帳號密碼、Google OAuth、Facebook OAuth*

### 頂部導航列

![頂部](docs/images/05-topbar.png)

*點擊 AEROSTRAT logo 回到地圖預設中心 · 即時航班計數 · 使用者選單 · 個人航班記錄入口*

---

## 主要功能

### 即時雷達追蹤
- **60fps 平滑動畫** — Canvas 引擎 + 航位推算 (Dead Reckoning)，資料更新間隙不閃爍
- **金色圖示系統** — 普通飛機金色 (`#D4AF37`)，選中飛機亮金 (`#FFD700`)
- **3-Tier 渲染管線** — SVG 精確圖形 > Path2D 嵌入輪廓 > 戰術點陣，自動降級
- **航跡追蹤** — 顯示歷史軌跡路徑，支援 24 小時歷史回放
- **高度色彩圖例** — ALTITUDE / TACTICAL / MONO 三種配色方案，底部顯示 ALT 色帶標籤

### 資料融合
- **多源整合** — OpenSky、ADSB-Fi、adsb.lol 三重冗餘，自動切換
- **機型資料庫** — Mictronics 全球 21 萬架航機資料，本地離線查詢
- **航線解析** — VRS 靜態路線庫 + ADSB.fi 即時路線 + AeroDataBox 時刻表
- **機場資料庫** — 全球機場 ICAO/IATA 代碼 + 座標快查

### 過濾與搜尋
- **多維度篩選** — 高度、地速、機型代碼、軍事/商業分類
- **全文搜尋** — 呼號、ICAO24、機型、航空公司，支援快速清除（✕ 按鈕）
- **Logo 回中心** — 點擊頂部 AEROSTRAT logo 即可飛回預設視角 (25.17°N, 121.44°E)

### 個人航班記錄
- **我的航班** — 登入後可新增、編輯、刪除個人飛行記錄
- **登機證卡片** — 垂直卡片佈局，顯示 IATA 代碼、時間、機型、座位等資訊
- **資料連線狀態** — SSE 斷線超過 8 秒顯示 `LIVE LOST`；後台資料過期顯示 `DATA STALE`

### 多國語言
- **中英雙語** — 所有 UI 文字支援繁體中文 / English 即時切換（含統計標籤、搜尋提示）

---

## 技術架構

### Frontend
| 技術 | 版本 | 用途 |
|------|------|------|
| React | 19 | UI 框架 |
| Vite | 6 | 構建工具 |
| Leaflet | 1.9 | 地圖底圖 |
| Canvas API | — | 飛機渲染（60fps） |
| Lucide React | — | 圖示系統 |
| Playwright | — | E2E 測試 |

### Backend
| 技術 | 版本 | 用途 |
|------|------|------|
| Node.js | 24 | 執行環境 |
| Express | 4 | HTTP 伺服器 |
| better-sqlite3 | 12 | 本地資料庫 |
| SSE | — | 即時飛機推送 |
| PM2 | — | 程序管理 |

---

## 目錄結構

```
project_aerostrat/
├── backend/
│   ├── server.js            # 主伺服器入口
│   ├── db/                  # SQLite 資料庫操作
│   ├── routes/              # API 路由
│   ├── services/            # 資料爬取、同步任務
│   └── data/                # 機型、機場、路線等靜態資料
├── client/
│   ├── src/
│   │   ├── components/      # React 元件
│   │   ├── hooks/           # 自訂 Hook（含 useI18n、useAnomalyStream）
│   │   ├── utils/           # 飛機圖示、渲染工具
│   │   ├── services/        # DataManager、IndexedDB 快取
│   │   └── workers/         # flightWorker.js
│   └── tests/e2e/           # Playwright 測試
├── public-react/            # Build 輸出（由 backend 靜態服務）
├── docs/images/             # README 截圖
├── docker-compose.yml
└── deploy.sh                # 快速部署腳本
```

---

## 快速開始

### 環境需求
- Node.js 20+
- PM2（選用，生產環境推薦）

### 1. 複製並安裝

```bash
git clone https://github.com/liaw-boy/project_flightradar.git
cd project_flightradar

# 後端依賴
cd backend && npm install

# 前端依賴
cd ../client && npm install
```

### 2. 設定環境變數

```bash
cd backend
cp .env.example .env   # 依需求填寫（見下方說明）
```

### 3. 啟動開發環境

```bash
# 終端 1 — 後端
cd backend && node server.js

# 終端 2 — 前端 (Vite dev server)
cd client && npm run dev
# 前端 → http://localhost:3005
# 後端 → http://localhost:3000
```

### 4. Build 並以 PM2 運行

```bash
cd client && npm run build
cd ..
pm2 start backend/ecosystem.config.js
# 訪問 http://localhost:3000
```

---

## 環境變數

`backend/.env` 設定：

```env
# 必填
JWT_SECRET=<長隨機字串，至少 32 字元>

# OAuth（選填，不填則停用對應登入方式）
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
APP_URL=http://localhost:3000

# API Keys（選填，增加資料來源）
AERODATABOX_API_KEY=

# 監控頁面密碼
MONITOR_PASSWORD=<自設密碼>

# CORS（逗號分隔）
ALLOWED_ORIGINS=http://localhost:3000,http://localhost:3005

# 其他
PORT=3000
LOG_LEVEL=INFO
NODE_ENV=production
```

> **注意：** `JWT_SECRET` 未設定時伺服器拒絕啟動。不要使用預設值於生產環境。

---

## 部署

### 使用 deploy.sh（推薦）

```bash
# 自動：git pull → npm build → pm2 reload
./deploy.sh
```

### 使用 Docker Compose

```bash
docker-compose up -d
```

### 手動部署流程

```bash
# 1. 拉取最新程式碼
git pull origin main

# 2. 建置前端
cd client && npm install && npm run build

# 3. 重啟後端
pm2 reload aerostrat
```

---

## 測試

### 執行 UX 流程測試（本地）

```bash
cd client
npx playwright test tests/e2e/ux_flow.spec.js
```

測試涵蓋：
1. 首頁無致命 JS 錯誤
2. 地圖渲染 + 飛機出現（15s 內）
3. 搜尋欄可輸入 + 清除按鈕功能
4. 登入 Modal 開啟
5. 頂部導航列渲染 + Logo 回中心
6. My Flights 面板 + 全頁表單（返回按鈕回列表）
7. API Ping 健康檢查
8. 即時飛機資料 API 回應
9. 高度圖例 ALT 標籤顯示

### 執行生產煙霧測試

```bash
npx playwright test tests/e2e/prod_smoke.spec.js
```

### 執行完整 E2E 套件

```bash
npx playwright test tests/e2e/
```

---

> 如果您喜歡這個專案，歡迎給一個 Star ⭐
