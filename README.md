# ✈️ 暗黑全球航空雷達 (Dark Flight Radar) - React 終極完整版 v1.0.26

基於 OpenSky Network API、React (Vite) 與 Leaflet 開發的即時全球航空雷達系統。本專案經歷了從純 HTML/JS 升級至現代化 React 框架的重大重構，並針對亞洲區域航班資料缺失、API 限流無限迴圈、舊設備 (iOS 12) 相容性等問題提出了深度的客製化解決方案。

系統採用 **Node.js Express 後端** 作為反向代理與快取層，有效保護 API 金鑰，具備完整的認證輪替機制、**5分鐘懲罰冷卻保護**與「本地端靜態航線字典檔 (`local_routes.json`)」，搭配 **React 前端** (30秒智慧輪詢) 打造出零延遲、高質感的暗黑科技風追蹤體驗。

---

## ✨ 核心特色與技術突破

- **⚛️ 現代化 React + Vite 架構**：全站組件化 (Components) 重構，狀態集中管理，支援多語言 (i18n) 與流暢的 UI 渲染。
- **📱 舊設備完美向下相容 (iOS 12+)**：導入 `@vitejs/plugin-legacy`，在前端編譯時自動生成 ES5 Polyfills。即使是 iPad mini (iOS 12.5.8)、舊版 Safari，也能完美無錯誤執行現代 JavaScript 語法。
- **🛡️ 零延遲本地航線字典 (Offline Static Route Dictionary)**：
  - **痛點解法**：OpenSky API 常常缺失各家航空的起降點 (例如 `DAL521` 顯示 `N/A`)。
  - **創新實作**：在後端建立 `data/local_routes.json`。當 OpenSky 查無此航班時，系統會**0 毫秒**直接攔截，翻譯成 3 碼 IATA (如 `DTW ✈ ATL`) 傳回前端展示，徹底消滅 N/A 且完全文字置中對齊。
- **⏳ 智慧 API 限流防護 (Rate Limit Penalty Box)**：
  - 前端輪詢頻率已由 11 秒大幅放寬至 **30 秒**，以節省每日 1000 次的 API 額度。
  - 當所有備用帳號皆耗盡單日額度 (HTTP 429) 時，後端 `server.js` 會自動進入 **5 分鐘全域懲罰冷卻 (Global Cooldown)**，期間攔截所有 OpenSky 請求並以「最後一次已知地圖快取」直接回應，完美達成優雅降級 (Graceful Degradation)，終止前端 5 秒瘋狂重試的迴圈轟炸。
- **🌍 無界橫向地圖 (Infinite Horizontal Map)**：解除 Leaflet 的 `maxBounds` 限制並開啟 `worldCopyJump`，實現真正的地球無限平移與飛機地標無縫接軌。
- **✈️ 動態長尾歷史軌跡**：保留最新的 500 個飛行座標點點跡。並新增防震跳 (Anti-Teleportation) 邏輯，避免跨日資料夾雜導致經緯度出現時速超音速 (> 400m/s) 的誇張畫面撕裂。
- **🎨 精準的航空公司與機型圖示**：修正 ICAO 代碼衝突，並讀取飛機種類 (`category`) 去渲染不同的 SVG 形狀，如商用客機、直升機、私人小飛機、無人機與地勤拖車。

---

## 📂 系統架構與目錄結構

```text
project_flightradar/
├── server.js               # Express 後端核心 (API 代理、快取機制、全域防護冷卻)
├── routes-cache.json       # 🗺️ 舊版自動暫存歷史航線紀錄
├── data/
│   └── local_routes.json   # 📚 零延遲本地航線字典 (手動擴充的絕對來源)
├── aircraft-cache.json     # ✈️ 飛機 Metadata 永久離線快取
├── metar-cache.json        # ⛅ 機場天氣快取
├── .env                    # 🔑 環境變數 (存放 OpenSky 帳密)
├── client/                 # ⚛️ React 前端原始碼目錄 (開發區)
│   ├── index.html          # Vite 進入點
│   ├── vite.config.js      # Vite 配置 (包含 legacy plugin 設定)
│   ├── package.json        # 前端相依套件 (Leaflet, React 等)
│   └── src/
│       ├── App.jsx         # React 主程式 (30秒輪詢間隔設定處)
│       ├── App.css         # 全域暗黑主題樣式
│       ├── hooks/          # useFlightData (軌跡與航班資料邏輯)
│       ├── utils/          # flightUtils (IATA 對應、圖標渲染引擎)
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
1. 前往 [OpenSky Network](https://opensky-network.org/) 註冊帳號並建立 API Client 取得 credentials (免費用戶每日限額 500 次呼叫)。
2. 回到專案根目錄 (不是 client 裡面)，確認是否存在 `.env` 檔案。
3. 填入您的 OpenSky 帳號與密碼 (支援多帳號以突破 API 限流)：

```env
OPENSKY_USER=您的帳號名稱或client_id
OPENSKY_PASS=您的密碼或client_secret
PORT=3000

# (選用) 備用帳號自動輪替機制
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
*(看到終端機顯示啟動成功、各帳號快取檔案載入紀錄，即代表啟動成功。)*

### 步驟 5：開始追蹤航班
打開您的瀏覽器 (電腦、手機、iPad 皆可)，輸入以下網址：

👉 **[http://localhost:3000/](http://localhost:3000/)**

> 若要在手機或 iPad 上觀看，請確保手機與電腦連線至「同一個 Wi-Fi 路由器」，並在手機瀏覽器輸入電腦的區域網路 IP (例如：`http://192.168.1.100:3000`)。

---

## 🛠️ 維護與除錯指南 (Troubleshooting)

### 1. 畫面顯示 N/A 或找不到航班？
- **如何手動新增靜態航線？**：如果你知道該航班的起降點，請直接打開 `project_flightradar/data/local_routes.json`，依樣畫葫蘆輸入 `{"航班號": ["起飛地IATA", "降落地IATA"]}`。存檔後，在終端機按下 `Ctrl + C`，重新執行 `npm start` 即可永久生效！
- **限流保護冷卻中**：若剛啟動伺服器，且帳號皆已超過每日限制，伺服器會自動將前端請求封鎖 5 分鐘，這之間畫面會「凍結」播放舊快取檔。請耐心等待解鎖，或等待 UTC 換日。

### 2. 為什麼計時器是跑到 30 秒？
因為 OpenSky 免費版極為珍貴的 1000 次每日限制，我們將 API 輪詢間隔設定為 30 秒，不僅能流暢追蹤整個台灣的航空領域，又能讓這 1000 次的使用壽命維持長達 **8 小時連續監看**。

### 3. 如何更新版本號以強制清除舊設備快取？
如果您修改了程式碼（例如加入了新的 CSS，或是更改了 `local_routes.json` 後想要確保各裝置載入最新邏輯），舊版 iOS Safari 很容易因為快取而看不到新畫面。
1. 前往 `client/src/components/Dashboard.jsx`。
2. 找到 `<span ...>v1.0.xx</span>` 的字樣，將其 + 1。
3. 執行 `cd client` -> `npm run build`。
4. 您的使用者進入網頁時看到新版號，或者強制按 **Ctrl + F5**，就代表快取已成功刷新！

---
**近期版本紀錄:**
- `v1.0.26` - API 輪詢拉長至 30 秒、支援 `local_routes.json` 靜態字典零延遲秒開、修復 OpenSky 429 前後端無限迴圈重試 Bug、新增 5 分鐘全域防護冷卻機制、Sidebar 航線卡文字完美置中、解放地圖無界限無限滾動。
- `v1.0.11` - 解決 OpenSky 歷史資料出發/抵達地為 null 導致備援失效問題；新增跨亞航空識別庫。
- `v1.0.8` - 導入防震跳邏輯；發佈 iOS 12 polyfills。
- `v1.0.0` - 全面從 HTML 轉型至 React/Vite 架構。
