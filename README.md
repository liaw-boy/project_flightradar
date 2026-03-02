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

---

## 🛡️ 實戰一：多帳號 API 輪控系統 (Quota Shield)
**核心挑戰**：當 OpenSky 回傳 HTTP 429 (Too Many Requests) 時，系統必須瞬間切換帳號並重試，確保服務不中斷。

**實作技術 (Node.js)**：
*   **建立帳號池**：啟動時讀取 `.env`，將所有帳號密碼封裝成陣列。
*   **指標追蹤 (Cursor Tracking)**：使用 `currentAccountIndex` 全域變數管理當前使用的帳號。
*   **攔截器邏輯**：系統會攔截 429 錯誤，自動執行 `currentAccountIndex = (currentAccountIndex + 1) % accounts.length`，更新 Headers 並重新發送原請求。對主程式而言，這一切都是透明且無感的。

## 🧮 實戰二：60fps 物理預測與大圓航法
**核心挑戰**：在沒有新資料的 60 秒內，精準推算飛機在地圖上的即時位置。

**實作技術 (前端 JavaScript Math)**：
*   **Destination Point 公式**：基於球面三角學，利用速度、時間與方位角計算下一點。
*   **角距離 ($\delta$)**：將移動距離 $d$ 除以地球半徑 $R$。
*   **大圓公式**：
    $$\varphi_2 = \arcsin( \sin\varphi_1\cos\delta + \cos\varphi_1\sin\delta\cos\theta )$$
    $$\lambda_2 = \lambda_1 + \operatorname{arctan2}(\sin\theta\sin\delta\cos\varphi_1, \cos\delta - \sin\varphi_1\sin\varphi_2)$$
*   **電競級渲染**：透過 `requestAnimationFrame` 脫離 React 渲染束縛，在獨立的動畫迴圈中更新 Marker 座標，達成 60fps 的滑順感。

## 🧠 實戰三：機場學習系統 (Auto Learning)
**核心挑戰**：系統如何主動發現「飛機降落了」，並識別其降落機場？

**實作技術 (後端 Node.js + JSON 快取)**：
*   **狀態機快取**：維護一個 `previousStates` Map，對比前後兩次資料的 `onGround` 狀態。
*   **事件觸發**：當飛機從「空中」轉為「地面」時，觸發降落事件。
*   **空間搜尋 (Spatial Query)**：拿飛機座標與 2 萬筆機場資料進行比對。
*   **效能優化**：不跑全量迴圈，先用正方形 BBox 粗篩出區域機場，再精算最短距離鎖定 ICAO 代碼。

## ✨ 實戰四：反瞬移的平滑校正 (LERP)
**核心挑戰**：真實數據進來時，如何消除預測座標與真實座標之間的「跳轉感」？

**實作技術 (前端 LERP)**：
*   **線性插值 (Linear Interpolation)**：當收到新資料，系統不會立刻「閃現」到新點。
*   **過渡期補償**：在接下來的 0.5 秒 (約 30 幀) 內，讓飛機稍微偏離預測軌道，朝向真實位置滑行。
*   **公式**：`currentPos = 預測位置 + (真實位置 - 預測位置) * (已經過時間 / 校正時間)`。

