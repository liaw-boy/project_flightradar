# ✈️ AEROSTRAT 全球航空雷達系統 (Global Surveillance Radar) - v3.5.0 "AERO-SYNC"

這是一款專門為「極端數據吞吐量」與「60fps電影級流暢視覺」而生的專業級全球航空監控系統。基於 **React (Vite)**、**Node.js (Worker Threads)** 與 **Leaflet Canvas 渲染引擎**，本系統獨家研發了 **AERO-SYNC 毫米級預測架構**，徹底顛覆傳統 Web 地圖渲染效能極限。

---

## 🌟 核心突破架構 (Core Innovations)

### 🚀 1. AERO-SYNC 原生 Canvas 渲染引擎 (Ultra-High-Performance)
捨棄傳統耗效能的 DOM 節點 (Markers) 繪製，全面改採硬體加速的 HTML5 Canvas 底層繪圖。
*   **萬架飛機同框流暢不卡頓**：利用 Frustum Culling (視錐剔除) 與 WebGL 級別的批量渲染，支援網頁同時容納 10,000+ 飛行器。
*   **高解析度視網膜支援 (High-DPI)**：採用動態 `devicePixelRatio` 縮放，在 4K 與 Mac Retina 螢幕上提供無毛邊的極致銳利 SVG 飛機圖示。
*   **飛航視覺還原 (FlightRadar24 Style)**：完美重現 FR24 經典的發光立體折射、機型按比例縮放（如 A380/無人機 尺寸差異化），以及白色「對話框式」的精標呼號與高清實體航空公司徽標。

### 🧠 2. 智慧全域感知追蹤 (Smart Auto-Tracking)
搭載了目前世界上最抗干擾的地圖鏡頭跟蹤邏輯。
*   **物理行為級別防誤判機制**：系統追蹤目標時會自動監聽並劫持網頁底層的滑鼠 (`mousedown`) 與滾輪 (`wheel`) 信號，徹底解決 Leaflet 原生動畫事件循環所導致的「視角被強制拉回」惡性 Bug。
*   **10秒智慧接管**：當使用者強行介入操作地圖時，系統會智慧靜默，使用者一旦停手滿 10 秒，運鏡又會絲滑地切回目標客機。

### 🛰️ 3. 軌跡歷史深度淨化引擎 (Historical Geometry Sanitization)
針對 OpenSky 歷史資料庫中的時空錯亂與座標抖動，後台會進行自動洗淨重構：
*   **消除幾何多邊形故障**：全自動掃除歷史軌跡中「時光倒流」或「重疊點」導致的螢幕閃爍與線條交錯。
*   **完美跨越國際換日線 (Anti-Meridian)**：獨家 `splitPathAtIDL` 演算法，保證跨越太平洋航班的追蹤線段不會在地圖上橫穿地球畫成鋸齒狀。

### 🕒 4. TimePlayer 第四維度回放 (Historical Playback)
*   **⏳ 自由拖拉時間軸**：查看飛機過去數小時內的精確位置。
*   **▶️ 平滑插值回放**：以線性內插模擬飛機在任何歷史切片中的平滑狀態。

### 🎯 5. 航空公司艦隊矩陣 (Airline Fleet Focus)
專為航空迷與業者設計的過濾系統。
*   **🔍 極速過濾**：在設定面板中輸入航空公司代碼 (如 EVA, CAL)，地圖將瞬間隱藏全球其餘百萬交通，僅追蹤該艦隊狀況。

---

## 📂 專案架構 (Architecture Map)

```text
project_flightradar/
├── server.js               # 高效能中樞：路由管理、多帳號額度調度、軌跡過濾演算
├── workers/
│   └── parser.js           # ⚡ Worker Thread: 背景非同步解析上萬筆 ADS-B 原始數據
├── data/
│   ├── processed/          # 🌍 全球 20,000+ 機場與導航點資料庫
│   └── aircraft_static.json# ✈️ 高精細航空器機型映射表
├── client/src/
│   ├── App.jsx             # React UI 佈局與狀態管理
│   ├── hooks/
│   │   └── useFlightData.js# 🪝 SSE / WebSocket 與 API 頻率優化調度
│   ├── components/
│   │   ├── MapView.jsx     # 🎨 AERO-SYNC Canvas 核心渲染引擎與互動層
│   │   ├── TopBar.jsx      # 📊 系統狀態儀表板與搜尋中心
│   │   └── Sidebar.jsx     # 📋 飛機詳細規格與高度剖面圖
│   └── utils/
│       └── flightUtils.js  # 🧮 物理運算核心：大圓路徑、SVG 幾何縮放、時光修復
```

---

## ⚙️ 快速部署 (Deployment)

### 1. 安裝依賴
```bash
npm install && cd client && npm install
```

### 2. 生產模式執行
```bash
npm run build   # 編譯高速純靜態生產包至 /public-react
npm run start   # 啟動雙向 Node.js 伺服器
```

---

## 🛠️ 開發優化重點 (Optimizations)
*   **SVG 光柵化快取 (Rasterization Cache)**：在 Canvas 繪製前預先將所有飛機轉印為點陣暫存圖，每幀節省 80% 渲染運算。
*   **SSE 真即時推送**：伺服器解析完畢後立即通知瀏覽器，消除無謂的頻繁輪詢壓力。
*   **玻璃擬態 UI**：全面採用強大且絲滑的 Dark Glass 語言，呈現純粹黑底極光科技感。
