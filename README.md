# ✈️ 暗黑全球航空雷達 (Dark Flight Radar) - 極致效能版 v2.5.0

這是一款專門為「大數據效能」與「極致流暢視覺」而生的專業級全球航空監控系統。基於 **React (Vite 6)**、**Node.js (Worker Threads)** 與 **OpenSky Network API**，V2.5.0 引進了強大的 **機場學習系統 (Airport Learning System)**。

---

## 🚀 v2.5.0 核心技術突破 (Technical Breakthroughs)
*   **🧠 v2.5.0 機場學習系統 (Airport Learning System)**：
    *   **🛫 自動起降偵測**：系統會比較飛機的先後狀態，自動識別起飛與降落事件，並精準鎖定機場。
    *   **🗺️ 資料庫自我成長**：學習到的新航線會自動寫入 `routes-cache.json`，讓雷達越跑越強大，減少對外部 API 的依賴。
    *   **📍 物理空間推測**：當偵測到起降時，會從本地 20 萬筆機場資料中找出最近的機場。
*   **🎉 v2.3.10 API 同步邏輯優化 (API Sync Logic Optimization)**：
    *   **💓 獨立心跳計時器 (Independent Heartbeat)**：將「25秒自動刷新」與「地圖移動 BBox 請求」邏輯解耦。地圖移動現在不會再重置視覺上的 25 秒倒數計時。
    *   **🛡️ 地圖防抖請求 (Map Move Debounce)**：新增 1.5 秒防抖機制，避免在頻繁拖動地圖時產生多餘的 API 請求，有效保護 API 配額。
    *   **📊 全方位資源監測 (System Resource Monitor)**：支援顯示即時渲染比例、節流係數與標記上限，並具備可摺疊 UI 保持介面整潔。
    *   **智慧 METAR 解碼**：支援全方位機場天氣資訊與飛行類別 (VFR/IFR) 顯示。
    *   **清理冗餘程式碼**：移除 Legacy 分塊與無效 import，編譯體積更輕量。

### ️ 1. 後端「全球數據中心」 (The Heavy Lifter)
*   **25s 全域定時輪詢**：後端獨立於前端需求，每 25,000ms 自動向 OpenSky 擷取全球 ~15,000 架飛機的即時狀態快取。
*   **Worker Threads 異步解析**：利用 Node.js 多執行緒技術，將 CPU 密集型的龐大 JSON 字串解析與數據清洗工作交給背景執行緒，確保 API 回應主執行緒 **零阻塞 (Event Loop Unblocked)**。
*   **BBox Slicer (智能裁切 API)**：前端不再下載全球數據。伺服器依據地圖邊界動態裁切（帶有 **10% Buffer Zone**），僅傳輸當前視野內的飛機，大幅降低移動端頻寬消耗。

### 🧬 2. 前端「物理運動引擎」 (Physics & Animation Engine)
*   **60FPS 物理推算 (Dead Reckoning)**：棄用傳統的跳躍式更新。系統採用 Great Circle (大圓航法) 物理公式，根據飛機的 `velocity` 與 `heading` 即時計算下一幀位置，實現極致絲滑的 60FPS 飛行滑行效果。
*   **即時軌跡「蛇形追加」 (Snake Appending)**：當您選中飛機時，軌跡線不再是死板的線段。隨著飛機在螢幕上移動，後端推送的新坐標會即時「銜接」至歷史軌跡，實現類似雷達螢幕的動態增長效果。
*   **多層次細節渲染 (LOD Rendering)**：
    *   **Zoom < 5**: 僅顯示 5000m 以上巡航機，減少全球視角效能損耗。
    *   **Zoom 6-9**: 隱藏地面飛機 (onGround)，聚焦空域交通。
    *   **Zoom >= 10**: 開放精細渲染，包含所有地面與低空目標。

### � 3. 數據精煉與自動修復 (Data Resilience)
*   **航空別名自動解析 (Airline Aliasing)**：智能將 ICAO 呼號 (如 `APJ`) 轉化為 IATA 營運碼 (`MM`)，精準匹配航空公司 Logo。
*   **Waterfall 路由獲取策略**：優先查詢 **RAM Cache** -> **Static DB** -> **TDX API**，徹底解決 OpenSky 原始數據中「起降機場」遺失的問題。
*   **雙源照片交叉驗證**：透過 Hex 與 Reg 雙代碼查詢 Planespotters，確保飛機照片精準無誤。

---

## 📂 核心架構地圖

```text
project_flightradar/
├── server.js               # 高效能中樞：API Slicer、帳號輪替、配額保護
├── workers/
│   └── parser.js           # ⚡ Worker Thread: 負載解析全球 >15,000 架飛機數據
├── data/
│   ├── processed/          # 🌍 2 萬筆全球機場 (ICAO/IATA/時區)
│   ├── local_routes.json   # 📚 手動航線修正檔 (Priority: 1)
│   └── aircraft_static.json# ✈️ 高精細航空器型號庫
├── client/src/
│   ├── hooks/
│   │   └── useFlightData.js# 🧬 BBox 動態拉取與資料流管理
│   ├── utils/
│   │   └── flightUtils.js  # 🧮 物理推算算法中心
│   └── components/
│       └── MapView.jsx     # 🎨 60FPS 渲染與 LOD 邏輯中樞
```

---

## ⚙️ 快速部署

### 1. 安裝環境
需 Node.js v18+。
```bash
npm install && cd client && npm install
```

### 2. 環境變數 (.env)
系統自動支持 **多帳號輪控**：
```env
OPENSKY_USER=user1
OPENSKY_PASS=pass1
OPENSKY_USER2=user2
OPENSKY_PASS2=pass2
# 支援多組帳號輪替，每組額度獨立計算
```

### 3. 一鍵啟動
```bash
npm run build   # 前端編譯
npm start       # 啟動後端並託管前端
```

---

## 🛠️ 專業級操作小撇步

*   **物理推算校正**：若發現飛機在數據更新瞬間有些微位移，這是物理引擎正將觀測座標與推算座標進行 **平滑校正 (LERP Correcting)**，以維持地圖位置的絕對真實性。
*   **效能監控**：可以在後端終端機觀察 `📦 [WORKER] Parse complete` 日誌，理想狀態下解析 15,000 架飛機僅需 10ms 以內。

---
*Powered by Deepmind Antigravity Engine | Professional Aero Data Analysis Suite.*
