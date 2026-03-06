# ✈️ AEROSTRAT 全球航空雷達系統 (Global Surveillance Radar) - v3.1.0

這是一款專門為「大數據效能」與「極致流暢視覺」而生的專業級全球航空監控系統。基於 **React (Vite 6)**、**Node.js (Worker Threads)** 與 **OpenSky Network API**，最新版本 v3.1.0 引進了革命性的 **TimePlayer 歷史回放**、**航空公司艦隊聚焦模式** 與 **60fps 絕對定位引擎**。

---

## 🌟 v3.1.0 核心功能 (Featured Capabilities)

### 🕒 1. TimePlayer 歷史軌跡回放 (Historical Playback)
系統現在支援全功能的時間旅行模式。當選中飛機後，您可以：
*   **⏳ 自由拖拉時間軸**：查看飛機過去數小時內的精確位置。
*   **▶️ 平滑回放**：以插值演算法 (Linear Interpolation) 模擬飛機在歷史時間點的平滑移動與轉向。
*   **📊 歷史狀態反映**：回放時，儀表板會同步顯示該時間點的歷史高度與速度。

### 🎯 2. 航空公司艦隊聚焦 (Airline Fleet Focus)
專為航空迷與業者設計的過濾系統。
*   **🔍 快速過濾**：在設定面板中選擇特定航空公司 (如 EVA, CAL, UAE)，地圖將立即隱藏其餘交通，僅呈現該公司的全球運行狀況。
*   **📈 實時統計**：TopBar 會同步反映該艦隊目前的空中與地面飛機總數。

### 🧬 3. 60fps 絕對定位預測引擎 (Absolute Dead Reckoning)
解決 ADS-B 數據更新延遲 (通常為 60s) 帶來的視覺突兀感。
*   **絕對定位 (Absolute DR)**：每幀從最後一次真實接收的時間戳出發，精確推算「當下」應處位置，徹底消除 API 更新時的「瞬移」或「倒退」現象。
*   **大圓航法 (Great Circle)**：軌跡與預測路徑皆採用球面三角學算法，確保跨洲際飛行路徑的物理準確性。

### 🧠 4. 機場推理與自動學習 (Airport Inference Engine)
*   **起降偵測**：系統會根據垂直速度與高度變化自動識別 Take-off 與 Landing 事件。
*   **智能路徑補完**：若 API 缺失航線資料，系統會根據地理位置推論起降機場，並更新至本地快取。

---

## 📂 專案架構 (Architecture Map)

```text
project_flightradar/
├── server.js               # 高效能中樞：路由管理、多帳號額度調度、BBox 切割
├── workers/
│   └── parser.js           # ⚡ Worker Thread: 背景非同步解析上萬筆 ADS-B 原始數據
├── data/
│   ├── processed/          # 🌍 全球 20,000+ 機場與導航點資料庫
│   ├── local_routes.json   # 📚 手動航線修正檔 (靜態強固)
│   └── aircraft_static.json# ✈️ 高精細航空器機型映射表
├── client/src/
│   ├── App.jsx             # React UI 佈局與狀態管理
│   ├── hooks/
│   │   └── useFlightData.js# 🪝 狀態同步、SSE 監聽、API 頻率優化
│   ├── components/
│   │   ├── MapView.jsx     # 🎨 核心渲染引擎：Leaflet + DR 預測算法
│   │   ├── TopBar.jsx      # 📊 系統狀態儀表板與搜尋中心
│   │   ├── TimePlayer.jsx  # 🕒 歷史回放控制組件 (v3.1 New)
│   │   └── Sidebar.jsx     # 📋 飛機詳細規格與高度剖面圖
│   └── utils/
│       └── flightUtils.js  # 🧮 物理運算核心：大圓路徑、SVG 生成
```

---

## ⚙️ 快速部署 (Deployment)

### 1. 安裝依賴
```bash
npm install && cd client && npm install
```

### 2. 環境變數 (.env)
系統支援多帳號輪替以最大化 API 配額。
```env
OPENSKY_USER=your_user
OPENSKY_PASS=your_password
# 可增加 USER2, PASS2... 最多 5 組
```

### 3. 生產模式執行
```bash
npm run build   # 編譯產出至 /public-react
npm run start   # 啟動生產環境伺服器
```

---

## 🛠️ 開發優化重點 (Optimizations)
*   **Gzip 壓縮**：所有 API 響應皆經過 `compression` 中間件，網路頻寬占用降低 70%。
*   **SSE 真即時推送**：伺服器解析完畢後立即通知瀏覽器，消除無謂的頻繁輪詢壓力。
*   **玻璃擬態 UI**：採用現代化 Dark Glass UI 語法，提供極簡、專業的監控視覺體驗。
