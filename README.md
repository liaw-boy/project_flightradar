# ✈️ 暗黑全球航空雷達 (Dark Flight Radar) - React 終極完整版 v1.0.11

基於 OpenSky Network API、React (Vite) 與 Leaflet 開發的即時全球航空雷達系統。本專案經歷了從純 HTML/JS 升級至現代化 React 框架的重大重構，並針對亞洲區域航班資料缺失、舊設備 (iOS 12) 相容性問題提出了深度的客製化解決方案。

系統採用 **Node.js Express 後端** 作為反向代理與快取層，有效隱藏 API 金鑰，具備完整的認證機制與「終極靜態航線生成器」，搭配 **React 前端** 打造出零延遲、高質感的暗黑科技風追蹤體驗。

---

## ✨ 核心特色與技術突破

- **⚛️ 現代化 React + Vite 架構**：全站組件化 (Components) 重構，狀態集中管理，支援多語言 (i18n) 與流暢的 UI 渲染。
- **📱 舊設備完美向下相容 (iOS 12+)**：導入 `@vitejs/plugin-legacy`，在前端編譯時自動生成 ES5 Polyfills (`polyfills-legacy.js`)。即使是 iPad mini (iOS 12.5.8)、舊版 Safari，也能完美無錯誤執行現代 JavaScript 語法。
- **🛡️ 終極靜態航線備援 (Ultimate Static Route Database)**：
  - **痛點解法**：OpenSky API 對於台灣國內線 (立榮 UIA、華信 MDA) 以及部分亞洲航班 (虎航 TTW、星宇 SJX、國泰 CPA、酷航 TGW) 嚴重缺乏起終點歷史資料，導致畫面經常顯示 "N/A"。
  - **創新實作**：在後端 `server.js` 實作自動攔截器，當 API 回傳的機場資料為空 (Null) 時，系統會針對特定呼號啟發式配發最真實的亞洲預設航線 (例如：UIA 強制對應 松山-馬公)，徹底消滅 N/A 破圖現象。
- **✈️ 動態長尾歷史軌跡**：前端將飛行座標的記憶體保留上限大幅擴充至 **500 個點 (約 83 分鐘)**，解決了盯著飛機看時軌跡線突然消失的 Bug。即使 API 回傳 404，也能從本地記憶體立刻畫出實況軌跡。
- **🚀 零延遲順暢平移 (Zero-Latency Panning)**：地圖縮放或拖曳時不再頻繁發送 API 請求。由客戶端直接從已載入的全球資料庫中瞬間篩選可見範圍。
- **🎨 精準的航空公司與機型圖示**：修正了立榮 (Uni Air) 與華信 (Mandarin Airlines) 的 ICAO 代碼衝突，並依據飛機類別 (商用客機、直升機、無人機、輕型機) 渲染不同形狀的 SVG。

---

## 📂 系統架構與目錄結構

```text
project_flightradar/
├── server.js               # Express 後端核心 (API 代理、快取機制、終極航線生成器)
├── routes-cache.json       # 🗺️ 靜態航線字典檔 (手動擴充的亞洲備援航線)
├── aircraft-cache.json     # ✈️ 飛機 Metadata 永久離線快取
├── metar-cache.json        # ⛅ 機場天氣快取
├── .env                    # 🔑 環境變數 (存放 OpenSky 帳密)
├── client/                 # ⚛️ React 前端原始碼目錄 (開發區)
│   ├── index.html          # Vite 進入點
│   ├── vite.config.js      # Vite 配置 (包含 legacy plugin 設定)
│   ├── package.json        # 前端相依套件 (Leaflet, React 等)
│   └── src/
│       ├── App.jsx         # React 主程式
│       ├── App.css         # 全域暗黑主題樣式
│       ├── hooks/          # useFlightData (軌跡與航班資料邏輯)
│       ├── utils/          # flightUtils (航空公司字典、ICAO 對應、距離計算)
│       └── components/     # UI 組件 (MapView, Sidebar, Dashboard, FilterPanel)
└── public-react/           # ⚛️ 前端建置輸出檔 (供 Express 提供靜態網頁服務)
```

---

## 🚀 完整的操作與部署過程 (Step-by-Step Guide)

要讓這套系統順利運行，必須同時啟動「前端的建置檔」與「後端的 Node.js 伺服器」。請依序執行以下步驟：

### 步驟 1：安裝環境與相依套件
確保您的系統已安裝 [Node.js](https://nodejs.org/) (建議 v18 以上版本)。

首先，安裝後端伺服器所需的套件：
```bash
# 在專案根目錄 (project_flightradar) 下執行
npm install
```

接著，進入 `client` 資料夾，安裝 React 前端所需的套件：
```bash
cd client
npm install
```

### 步驟 2：設定 API 憑證 (環境變數)
1. 前往 [OpenSky Network](https://opensky-network.org/) 註冊帳號並建立 API Client 取得 credentials。
2. 回到專案根目錄 (不是 client 裡面)，確認是否存在 `.env` 檔案。
3. 填入您的 OpenSky 帳號與密碼 (支援多帳號以突破 API 限流)：

```env
OPENSKY_USER=您的帳號名稱或client_id
OPENSKY_PASS=您的密碼或client_secret
PORT=3000

# (選用) 備用帳號自動輪替
OPENSKY_USER2=第二組帳號
OPENSKY_PASS2=第二組密碼
```

### 步驟 3：編譯 React 前端 (Build)
系統的後端 (`server.js`) 被設計為會直接讀取 `public-react` 資料夾裡的靜態檔案。因此，每次修改 `client/src` 裡的 React 程式碼後，都必須重新編譯 (Build)。

```bash
# 確保你目前在 client 資料夾底下 (project_flightradar/client)
npm run build
```
*(執行完畢後，終端機會顯示 Vite building for production... 以及舊設備專用的 polyfills-legacy.js 產出訊息。這代表前端已準備完畢。)*

### 步驟 4：啟動後端伺服器 (Start Server)
退回到專案根目錄，啟動 Node.js 伺服器：

```bash
# 退回根目錄
cd ..

# 啟動伺服器
npm start
# (等同於執行 node server.js)
```
*(看到終端機出現 `✅ React Flight Radar Server running on port 3000` 即代表啟動成功。)*

### 步驟 5：開始追蹤航班
打開您的瀏覽器 (電腦、手機、iPad 皆可)，輸入以下網址：

👉 **[http://localhost:3000/](http://localhost:3000/)**

> 若要在手機或 iPad 上觀看，請確保手機與電腦連線至「同一個 Wi-Fi 路由器」，並在手機瀏覽器輸入電腦的區域網路 IP (例如：`http://192.168.1.100:3000`)。

---

## 🛠️ 維護與除錯指南 (Troubleshooting)

### 1. 畫面顯示 N/A 或找不到航班
- **限流問題**：OpenSky API 相當嚴格。若剛啟動伺服器，可能正處於 HTTP 429 限流狀態。請耐心等待 2~3 分鐘，系統的自動輪替機制會在限流解除後將全地球的飛機抓取下來。
- **終極備援失效？**：如果你點擊了台灣虎航 (TTW) 卻還是顯示 N/A，請退回專案終端機按下 `Ctrl + C`，然後重新執行 `npm start`，確保後端載入的是最新的 `server.js` 邏輯。

### 2. 不同設備的「資料更新倒數」不同步？
本系統架構採 **客戶端輪詢 (Client Polling)** 機制。每個設備 (iPad, 手機, 電腦) 是依照自己打開網頁的當下時間開始計時「每 10 秒打一次 API」。因此，不同設備的更新時間與 API 累計次數有 3~5 秒的落差是**完全正常**的行為。

### 3. 如何更新版本號以強制清除舊設備快取？
如果您修改了程式碼（例如在 `flightUtils.js` 中新增了一家航空公司），舊版 iOS Safari 很容易因為快取而看不到新畫面。
1. 前往 `client/src/components/Dashboard.jsx`。
2. 找到 `v1.0.11` 的字樣，將其修改為 `v1.0.12`。
3. 執行 `cd client` -> `npm run build`。
4. 您的使用者進入網頁時看到新版號，就代表快取已成功刷新！

---
**版本紀錄:**
- `v1.0.11` - 解決 OpenSky 歷史資料出發/抵達地為 null 導致備援失效問題；新增 TGW (酷航) 等亞洲各級航空識別支援。
- `v1.0.9` - 導入「終極靜態航線生成機制」(Ultimate Static Fallback)，修復立榮(UIA)圖標衝突。
- `v1.0.8` - 飛行軌跡記憶體從 50 擴充至 500；發布 iOS 12 polyfills。
- `v1.0.0` - 全面從 HTML 轉型至 React/Vite 架構。
