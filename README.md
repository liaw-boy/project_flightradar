# ✈️ 暗黑全球航空雷達 (Dark Flight Radar) - 極致效能版 v2.2.5

這是一款專門為「大數據效能」與「極致流暢視覺」而生的專業級全球航空監控系統。基於 **React (Vite 6)**、**Node.js (Worker Threads)** 與 **OpenSky Network API**，V2.2.5 引入了多項航空工業級的渲染與推算技術。

---

## 🚀 v2.2.5 核心技術突破 (Technical Breakthroughs)
*   **🎉 v2.2.x 深度優化專場**：
    *   **無縫地圖平移 (Seamless Panning)**：移除 25 秒 fetch 鎖定，實現隨移隨抓，且舊飛機不消失。
    *   **動態機場資料庫**：移除 5MB 靜態分塊，改由後端 `/api/airports/list` 按需提供 major/intermediate 機場。
    *   **智慧 METAR 解碼**：支援全方位機場天氣資訊與飛行類別 (VFR/IFR) 顯示。
    *   **清理冗餘程式碼**：移除 Legacy 分塊與無效 import，編譯體積更輕量。

### �️ 1. 後端「全球數據中心」 (The Heavy Lifter)
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
