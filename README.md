# ✈️ 暗黑全球航空雷達 (Dark Flight Radar) - 極致效能版 v2.5.0

這是一款專門為「大數據效能」與「極致流暢視覺」而生的專業級全球航空監控系統。基於 **React (Vite 6)**、**Node.js (Worker Threads)** 與 **OpenSky Network API**，V2.5.0 引進了革命性的 **混合動態架構 (Hybrid Dynamic Architecture)** 與 **機場學習系統 (Airport Learning System)**。

---

## 🚀 v2.5.0 核心技術突破 (Technical Breakthroughs)

### 🧠 1. 機場學習系統 (Airport Learning System)
系統現在具備「自我進化」能力，能從物理軌跡中自動學習並補完全球航線庫。
*   **🛫 自動起降偵測 (Auto Event Detection)**：透過即時比較飛機的先後狀態，自動識別起飛與降落事件。
*   **� 規律補完 (Logic Inference)**：偵測到起降後，會自動從本地 20 萬筆機場資料中計算最近的機場，並永久寫入 `routes-cache.json`。
*   **�️ 資料庫成長 (DB Growth)**：運行時間越長，本地航線資料越完整，徹底擺脫對收費 API 的依賴。

### 🏎️ 2. 混合智慧架構 (Hybrid 60s/60fps Hub)
解決了數據更新頻率與視覺流暢度之間的矛盾。
*   **💓 60s 低功耗數據中心**：後端每 60 秒擷取一次全球數據，大幅降低 API 額度消耗並提升伺服器穩定性。
*   **🧬 60fps 物理預測引擎 (Dead Reckoning)**：前端採用大圓航法 (Great Circle) 公式，在數據更新的間隔內，每秒 60 幀即時推算飛機「下一秒的位置」。
*   **✨ 視覺感官**：即使數據 60 秒才更新一次，但在雷達螢幕上，飛機依然維持 **絲滑飛行、永不停歇**。

### 📊 3. API 配額保護系統 (Quota Shield)
*   **🔄 多帳號輪控系統**：支援 5+ 組帳號自動切換，當一組額度快用完時自動切換至下一組，確保系統 24/7 不間斷。
*   **🛡️ 智能防抖 (Request Debounce)**：地圖移動時自動合併請求，避免產生多餘的 API 負載。

---

## 📂 核心架構地圖

```text
project_flightradar/
├── server.js               # 高效能中樞：機場學習邏輯、帳號輪替、BBox Slicer
├── workers/
├── parser.js           # ⚡ Worker Thread: 負載解析全球 >15,000 架飛機數據
├── data/
│   ├── processed/          # 🌍 2 萬筆全球機場 (ICAO/IATA/時區)
│   ├── local_routes.json   # 📚 手動航線修正檔 (Priority: 1)
│   ├── routes-cache.json   # 🧠 [NEW] 自動學習生成的航線知識庫
│   └── aircraft_static.json# ✈️ 高精細航空器型號庫
├── client/src/
│   ├── utils/
│   │   └── flightUtils.js  # 🧮 60fps 物理推算算法核心
│   └── components/
│       └── MapView.jsx     # 🎨 渲染與 LOD 邏輯中樞
```

---

## ⚙️ 快速部署

### 1. 安裝環境
需 Node.js v18+。
```bash
npm install && cd client && npm install
```

### 2. 環境變數 (.env)
```env
OPENSKY_USER=user1
OPENSKY_PASS=pass1
OPENSKY_USER2=user2
OPENSKY_PASS2=pass2
# 支援多組帳號輪替
```

### 3. 一鍵啟動
```bash
npm run build   # 前端編譯
npm start       # 啟動後端並託管前端
```

---

## 🛠️ 專業級操作細節
*   **座標校正 (LERP)**：當 60 秒真實數據進來時，物理引擎會自動平滑校正前端推算位置與真實觀測點的微小落差，維持軌跡絕對真實性。
*   **效能分級 (LOD)**：系統會根據縮放層級動態調整顯示的飛機數量，確保在低階設備上也能流暢運行。

