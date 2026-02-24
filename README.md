# ✈️ 暗黑全球航空雷達 (Dark Flight Radar)

基於 OpenSky Network API 與 Leaflet.js 開發的即時全球航空雷達系統。專注於提供高效能、低延遲的飛機追蹤體驗，同時配備充滿科技感的暗黑螢光主題介面。

本專案升級為 **Node.js Express** 架構，後端伺服器作為外部 API 的反向代理 (Reverse Proxy) 與快取層，有效隱藏敏感的 API 認證資訊，並大幅減少直接調用 OpenSky API 導致的頻率限制 (Rate Limiting) 問題。

---

## ✨ 核心特色

- **🌍 即時航班追蹤**：全球航班的即時位置、高度、速度、航向等資訊。
- **🛡️ 後端代理架構**：隱藏 OpenSky API 帳號密碼，避免前端外洩風險，並解決跨域 (CORS) 問題。
- **⚡ 伺服器端快取 (Server-side Caching)**：內建 15 秒 TTL 快取機制，降低 API 呼叫頻次，不僅加快回應速度，更避免被 OpenSky 伺服器封鎖。
- **🚄 動態流暢渲染**：前端對大量飛機標記進行渲染優化，利用補間插值 (Interpolation) 推算飛行動畫，讓雷達畫面維持順暢。
- **🚨 智慧偵測與過濾**：自動偵測「7700」等緊急狀況 (Squawk)，支援一鍵過濾特定高度或地面滑行的航班。
- **✈️ 動態側邊欄與儀表板**：顯示詳細飛機與飛行軌跡，並支援以航班代碼搜尋飛機。

---

## 📂 系統架構與目錄結構

```text
project_flightradar/
├── server.js               # Express 後端伺服器 (API 代理與快取邏輯)
├── package.json            # 專案依賴與 NPM 腳本
├── .env                    # 🔑 環境變數 (存放 API 帳密，受 .gitignore 保護)
├── .gitignore              # Git 忽略設定
└── public/                 # 前端靜態資源
    ├── index_cl3.html      # 終極優化版主程式 (主要入口)
    ├── index_cl2.html      # 舊版歷史備份
    ├── index_cl.html       # 舊版歷史備份
    └── index.html          # 初始版本備份
```

---

## 🚀 快速開始指南

### 1. 安裝前置作業
確保您的系統已安裝以下環境：
- [Node.js](https://nodejs.org/) (建議 v18 以上)
- [Git](https://git-scm.com/)

### 2. 安裝套件
將專案下載後，進入專案根目錄並安裝相關依賴：

```bash
cd project_flightradar
npm install
```

### 3. 設定環境變數
在專案根目錄下建立一個名為 `.env` 的檔案，以配置您的 OpenSky Network API 帳號授權。（擁有授權帳密可以獲得較高的 API 額度限制）

```env
# /project_flightradar/.env 文件內容範例

# OpenSky Network API Credentials
OPENSKY_USER=your_username
OPENSKY_PASS=your_password

# (Optional) 後端啟動的 Port，預設為 3000
PORT=3000
```
> **注意**：如果不設定 API 金鑰，後端將使用未認證的 API 請求（Unauthenticated），會受到更嚴苛的 IP 速率限制。

### 4. 啟動伺服器
我們在 `package.json` 中配置了兩種啟動指令：

**正式執行模式** (適合一般使用或部署)：
```bash
npm start
```

**開發模式** (使用 node --watch，修改 server.js 存檔後將自動重啟伺服器)：
```bash
npm run dev
```

成功啟動後，終端機會呈現以下畫面：
```text
╔══════════════════════════════════════════╗
║   ✈️  Flight Radar Backend Server        ║
║   🌐 http://localhost:3000               ║
║   📁 Serving: ./public                   ║
║   🔑 Auth: Enabled                       ║
╚══════════════════════════════════════════╝
```

### 5. 開啟雷達監控系統
在您的瀏覽器中輸入以下網址，即可觀看雷達介面：
👉 **[http://localhost:3000/index_cl3.html](http://localhost:3000/index_cl3.html)**

---

## 🔌 API 內部端點說明 (Endpoints)

為防止 CORS 錯誤以及保護金鑰，這個後端服務自行提供了下列本地端 API，由前端 JavaScript 進行抓取。

| HTTP 方法 | 本地端 API 路由 | 用途說明 | 快取時間 (TTL) |
|-----------|-----------------|----------|----------------|
| `GET` | `/api/health` | 檢查 Node.js 伺服器的運作狀態與健康度 | 無 |
| `GET` | `/api/states` | 代理 OpenSky `/states/all`。抓取指定經緯度範圍內的飛機即時資訊。需附帶參數：`lamin`, `lomin`, `lamax`, `lomax` | 15 秒 |
| `GET` | `/api/tracks` | 代理 OpenSky `/tracks`。藉由 `icao24` 飛機識別碼代號抓取過往飛行軌跡座標陣列。 | 無 |

---

## 🛠️ 開發技術棧 (Tech Stack)

### 前端 (Frontend)
- **HTML5 / CSS3 / JavaScript (Vanilla JS)** - 原生語言不依賴前端大型框架，保證極高的執行效能。
- **Leaflet.js** - 輕量化且強大的 2D 互動式 Web 地圖渲染開源程式庫。
- **CartoDB Base Maps** - 無標籤的暗黑地圖圖磚，專門為雷達主題而設。

### 後端 (Backend)
- **Node.js** - 提供伺服器執行環境。
- **Express.js** - 高效的後端網頁應用框架，用來建立並管理 API Routes。
- **dotenv** - 處理並加載環境變數。
- **cors** - 處理跨網域存取的問題。

---

## 📝 後續進階功能規劃 (TODO)
- [ ] 整合 MongoDB 或是 SQLite，儲存歷史航班軌跡。
- [ ] 使用 WebSocket 取代傳統的每隔 N 秒輪詢。
- [ ] 新增多個飛航 API 來源（例如整合 ADS-B Exchange）以補足 OpenSky Network 未涵蓋或是被遮蔽地區的航空資訊。
