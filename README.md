# ✈️ 暗黑全球航空雷達 (Dark Flight Radar)

基於 OpenSky Network API 與 React + Leaflet 開發的即時全球航空雷達系統。專注於提供高效能、低延遲的飛機追蹤體驗，同時配備充滿科技感的暗黑螢光主題介面，並**全面支援 RWD 響應式網頁設計**（支援手機、平板與桌面瀏覽）。

本專案採用 **React 前端 + Node.js Express 後端** 架構。後端伺服器作為外部 API 的反向代理 (Reverse Proxy) 與快取層，有效隱藏 API 金鑰，完整實作 OAuth2 認證流程，並大幅減少直接調用 API 導致的頻率限制 (Rate Limiting) 問題。

---

## ✨ 核心特色

- **🌍 即時航班追蹤**：全球航班的即時位置、高度、速度、航向與垂直速率等資訊。
- **📱 全面 RWD 支援**：自動適應手機、平板與桌面螢幕，在手機版提供底部導覽與全寬搜尋體驗。
- **🛡️ 後端 OAuth2 代理架構**：隱藏 OpenSky API 帳密，後端自動處理 `client_credentials` 交換 Access Token 的流程，解決前端 CORS 與安全性問題。
- **⚡ 伺服器端快取 (Server-side Caching)**：內建 15 秒 TTL 快取機制，降低 API 呼叫頻次，避免被 OpenSky 伺服器封鎖。
- **🚄 動態流暢渲染**：前端對大量飛機標記進行渲染優化，利用補間插值 (Interpolation) 推算飛行動畫，讓雷達畫面維持順暢 (可達 100+ FPS)。
- **🚨 智慧偵測與過濾**：自動偵測「7700」等緊急狀況 (Squawk) 並在地圖上呈現紅色閃爍特效；支援一鍵過濾特定高度或地面滑行的航班。
- **✈️ 動態側邊欄與搜尋**：顯示詳細飛機與飛行軌跡，並支援以航班代碼 (如 CX123) 快速搜尋飛機。

---

## 📂 系統架構與目錄結構

```text
project_flightradar/
├── server.js               # Express 後端伺服器 (OAuth2 認證、API 代理與快取)
├── package.json            # 後端依賴與 NPM 腳本
├── .env                    # 🔑 環境變數 (存放 API 帳密，受 .gitignore 保護)
├── client/                 # React + Vite 前端原始碼
│   ├── index.html          # React 進入點
│   ├── package.json        # 前端依賴
│   ├── vite.config.js      # Vite 開發代理與建構設定
│   └── src/
│       ├── App.jsx         # 主應用程式佈局
│       ├── components/     # React 視圖元件 (地圖、儀表板、側邊欄等)
│       ├── hooks/          # 自訂 React Hooks (資料抓取、通知系統)
│       └── utils/          # 共用邏輯 (SVG 繪製、位置預測算法)
├── public-react/           # React 建構後的靜態產出檔案 (由後端伺服)
└── public/                 # 舊版 Vanilla HTML 歷史備份
```

---

## 🚀 快速開始指南

### 1. 安裝前置作業
確保您的系統已安裝以下環境：
- [Node.js](https://nodejs.org/) (建議 v18 或 v24 以上 LTS 版本)
- [Git](https://git-scm.com/)

### 2. 安裝套件
將專案下載後，需要分別安裝「後端」與「前端」的依賴套件：

```bash
# 安裝後端依賴
cd project_flightradar
npm install

# 安裝前端依賴
cd client
npm install
```

### 3. 設定環境變數與取得 API 憑證
OpenSky Network 目前嚴格要求使用 **OAuth2 Client Credentials** 進行認證。請按照以下步驟取得憑證：

1. 前往 [OpenSky Network](https://opensky-network.org/) 註冊 / 登入帳號。
2. 進入個人 Account 設定，建立一個新的 **API Client**。
3. 取得您的 `client_id` 與 `client_secret`。

在專案根目錄下建立一個名為 `.env` 的檔案，填入以下內容：

```env
# /project_flightradar/.env

# OpenSky Network API Credentials
OPENSKY_USER=填入你的_client_id
OPENSKY_PASS=填入你的_client_secret

# (Optional) 後端啟動的 Port，預設為 3000
PORT=3000
```

### 4. 啟動伺服器

我們提供兩種啟動模式：**正式環境 (Production)** 與 **開發環境 (Development)**。

#### 🟢 模式 A：正式環境 (部署與一般使用)
首先將 React 前端編譯為靜態檔案，然後啟動 Express 後端伺服器來提供服務。

```bash
# 1. 構建前端 (會輸出到 /public-react 資料夾)
cd client
npm run build

# 2. 回到根目錄啟動後端
cd ..
npm start
```

👉 開啟瀏覽器訪問：**[http://localhost:3000](http://localhost:3000)**

#### 🛠️ 模式 B：開發環境 (前端熱重載 + 後端自動重啟)
如果您要修改程式碼，請開啟**兩個終端機視窗**：

**終端機 1 (啟動後端 API 伺服器):**
```bash
cd project_flightradar
npm run dev
```

**終端機 2 (啟動 Vite 前端開發伺服器):**
```bash
cd project_flightradar/client
npm run dev
```

👉 開啟瀏覽器訪問 Vite 提供的本地網址（通常是 **[http://localhost:5173](http://localhost:5173)**），Vite 會自動將 `/api` 請求代理給後端的 3000 port。

---

## 🔌 API 內部端點說明 (Endpoints)

為防止 CORS 錯誤、隱藏金鑰並實作 OAuth2 流程，後端服務自行提供了下列本地端 API：

| HTTP 方法 | 本地端 API 路由 | 用途說明 | 快取時間 (TTL) |
|-----------|-----------------|----------|----------------|
| `GET` | `/api/health` | 檢查 Node.js 伺服器的運作狀態與健康度。 | 無 |
| `GET` | `/api/states` | 代理 OpenSky `/states/all`。抓取指定經緯度範圍內的飛機即時資訊。需附帶參數：`lamin`, `lomin`, `lamax`, `lomax` | 15 秒 |
| `GET` | `/api/tracks` | 代理 OpenSky `/tracks`。藉由 `icao24` 飛機識別碼代號抓取過往飛行軌跡座標陣列。 | 15 秒 |

*(註：所有 `/api/*` 以外的請求，若找不到對應檔案，伺服器會自動 Fallback 回傳 React 的 `index.html`，以支援前端 Client-side Routing)*

---

## 🛠️ 開發技術棧 (Tech Stack)

### 前端 (React Client)
- **[React 19](https://react.dev/) + [Vite](https://vitejs.dev/)** - 現代化的高速前端開發環境與組件化架構。
- **[Leaflet.js](https://leafletjs.com/)** - 輕量化強大的 Web 地圖渲染工具 (使用原生 DOM 控制，優化大量實體標記效能)。
- **Vanilla CSS** - 原生 CSS 進行客製化暗黑螢光 UI 與響應式設計，無額外樣式庫負擔。

### 後端 (Express Server)
- **Node.js + Express.js** - 後端 API Server 與靜態檔案伺服。
- **OAuth2 Token Exchange** - 自動透過 `/token` endpoint 獲取並更新 OpenSky Bearer Token。
- **node-fetch** - (Node 內建) 發送 HTTP 請求。
- **dotenv** - 管理環境變數。

---

## 📝 後續進階功能規劃 (TODO)
- [ ] 整合 MongoDB 或是 SQLite 儲存歷史航班軌跡，開放歷史回放功能。
- [ ] 使用 WebSocket 取代傳統的每隔 N 秒輪詢。
- [ ] 新增多個飛航 API 來源（例如整合 ADS-B Exchange）以補足 OpenSky Network 未涵蓋或是被遮蔽地區的航空資訊。
