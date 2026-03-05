# ✈️ 暗黑全球航空雷達 (Dark Flight Radar) - 極致效能版 v2.8.7

這是一款專門為「大數據效能」與「極致流暢視覺」而生的專業級全球航空監控系統。基於 **React (Vite 6)**、**Node.js (Worker Threads)** 與 **OpenSky Network API**，最新版本的系統引進了革命性的 **混合動態架構 (Hybrid Dynamic Architecture)**、**機場預測引擎 (Airport Logic Inference)** 與多種進階伺服器優化。

---

## 🚀 v2.8.2 核心技術突破 (Technical Breakthroughs)

### 🧠 1. 機場學習系統 (Airport Learning Engine)
系統具備「自我進化」能力，能從飛機物理軌跡中自動學習並補完全球航線庫。
*   **🛫 自動起降偵測 (Auto Event Detection)**：透過即時比較飛機的歷史與當前狀態，自動識別起飛與降落事件。
*   **📡 空間推算邏輯 (Spatial Inference)**：偵測到起降事件後，自動計算座標周圍的 BBox，並從本地萬筆機場資料庫中尋找最短距離的機場，永久寫入 `routes-cache.json`。
*   **🛠️ 本地龐大資料庫**：內建靜態飛機庫 (`aircraft_static.json`) 與手動航線修正檔 (`local_routes.json`)，最大化降低對第三方付費 API 的依賴。

### 🏎️ 2. 混合智慧架構 (Hybrid 60s/60fps Hub)
解決了數據更新頻率極低與視覺流暢度需求極高之間的矛盾。
*   **💓 低功耗數據中心**：後端預設採用背景拉取制，以動態推薦間隔（如每 20-60 秒）擷取全球數據，避免伺服器因頻繁 API 請求而遭到封鎖。
*   **🧬 絕對定位式 60fps 預測引擎 (Absolute Dead Reckoning)**：前端脫離 React DOM 渲染，透過 `requestAnimationFrame` 與大圓航法，每幀從「真實 ADS-B 接收時間戳 (lastContact)」推算飛機位置，徹底根除長時間預測累積的誤差與 API 更新時的倒退滑動現象。
*   **✨ FR24 專業級視覺感官**：導入 Flightradar24 風格的永久智慧標籤系統 (Smart LOD Labels)。選中飛機擁有專屬帶箭頭氣泡與航空公司 Logo，並支援依據 Zoom 級別自動隱藏重疊標籤，確保畫面清爽。

### 📊 3. API 配額保護系統 (Quota Shield & Stretching)
*   **🔄 多帳號輪控系統**：支援多達 5 組帳號無縫自動切換。當其中一組額度枯竭 (HTTP 429)，自動更換 Header 進行請求。
*   **🛡️ 動態延展 (Quota Stretching)**：演算法動態計算當日剩餘額度、距離 UTC 00:00 重置的時間，智慧調整最佳輪詢間隔 (Recommended Interval)，確保系統 24/7 持續運作。
*   **⏱️ 更新同步**：完美同步伺服器輪詢、快取 TTL 與用戶端更新間隔。

### 🐞 4. 容錯與除錯系統 (Fault Tolerance & Logging)
*   **📝 資料缺失日誌 (Data Deficiency Logging)**：自動追蹤解析失敗的 ICAO24、機型與航班號，保存至 `missing-data.json` 提供管理者進行資料庫查修。
*   **✅ 背景自我修復 (Self-Healing Cache)**：針對過期或損壞的快取，系統會在啟動與運作期間自動進行清理與預熱。

---

## 📂 核心架構地圖 (Architecture Map)

```text
project_flightradar/
├── server.js               # 高效能中樞：路由、多帳號輪控、BBox API、動態額度計算
├── workers/
│   └── parser.js           # ⚡ Worker Thread: 背景非同步解析上萬筆 OpenSky 狀態，不卡主執行緒
├── data/
│   ├── processed/          # 🌍 全球機場與導航點資料表
│   ├── local_routes.json   # 📚 手動航線強固檔 (最高優先級)
│   ├── routes-cache.json   # 🧠 自動學習引擎生成的航線知識庫
│   └── aircraft_static.json# ✈️ 高精細航空器型號映射表
├── client/src/
│   ├── App.jsx             # React 主流與 UI 控制中心
│   ├── hooks/
│   │   ├── useFlightData.js# 🪝 狀態管理與 API 狀態/定時器同步
│   │   └── useI18n.js      # 🌐 多語系(i18n)即時切換邏輯
│   ├── utils/
│   │   └── flightUtils.js  # 🧮 物理推算算法 (大圓航法/SVG生成)核心
│   └── components/
│       └── MapView.jsx     # 🎨 Leaflet 地圖渲染、虛擬化列表與 60fps LERP 邏輯中樞
```

---

## ⚙️ 快速部署 (Quick Start)

### 1. 安裝環境
需 Node.js v18+。
```bash
npm install && cd client && npm install
```

### 2. 環境變數 (.env)
系統可依據配置自動分配負載。
```env
OPENSKY_USER=user1
OPENSKY_PASS=pass1
OPENSKY_USER2=user2
OPENSKY_PASS2=pass2
# 最高支持 5 組帳號輪替
```

### 3. 一鍵啟動
```bash
npm run build   # 編譯 React 生產版本
npm run start   # 以生產模式啟動 Node.js 後端
# 或使用 npm run dev 進行後端熱重載開發
```

---

## 🛠️ 專業級實戰算法拆解 (In-Depth Mechanisms)

### ✨ 實戰一：反瞬移與絕對定位推算 (Absolute DR & LERP)
**核心挑戰**：免費 API 更新間隔長達 60 秒，若採增量推算 (前一幀座標 + 速度)，60 秒後預測點會大幅偏離真實軌道，導致 API 更新時飛機發生嚴重的「倒退滑動」。

**實作技術 (Client: MapView.jsx)**：
*   **絕對定位式推算 (Absolute Dead Reckoning)**：拋棄增量計算。每幀一律從「API 最後一次真實 ADS-B 接收座標」出發，加上「距今真實流逝時間 (elapsed)」算出目前應處位置。API 更新時座標與時間戳同步刷新，新舊預測路徑完美銜接。
*   **極速線性插值 (Aggressive LERP)**：收到新資料的第一瞬間，利用極高的 `lerpFactor (0.5)` 在 3~4 幀 (約 67ms) 內收斂微小誤差，人類視覺無法察覺任何跳躍，只會覺得飛機順滑地拐了一個極小且迅速的彎。

### 🧮 實戰二：60fps 物理預測與大圓航法 (Great Circle)
**核心挑戰**：在全球範圍的球面地圖中移動，直線預測會導致嚴重的路徑變形。

**實作技術 (Client: flightUtils.js)**：
*   **Destination Point 算法**：基於球面三角學，利用飛機的真實速度 (m/s)、UTC 時間差與方位角 (True Track) 精準計算。
*   **大圓公式**：
    $$\varphi_2 = \arcsin( \sin\varphi_1\cos\delta + \cos\varphi_1\sin\delta\cos\theta )$$
    $$\lambda_2 = \lambda_1 + \operatorname{arctan2}(\sin\theta\sin\delta\cos\varphi_1, \cos\delta - \sin\varphi_1\sin\varphi_2)$$

### 📡 實戰三：BBox Slicer 與虛擬化渲染 (LOD & Virtualization)
**核心挑戰**：渲染數萬架飛機與數千個機場圖標會瞬間癱瘓瀏覽器的 DOM 系統。

**實作技術 (Server & Client)**：
*   **空間切割 (BBox)**：前端根據目前可視範圍 (Bounds) 向後端發出切割請求，後端只回傳在這個矩形範圍內的航班。
*   **LOD (Level of Detail)**：根據地圖 Zoom 等級，決定機場顯示的顆粒度（縮小顯示大型機場，放大才顯示小型機場與氣象 Popup）。
*   **DOM 即時回收**：飛機離開可視範圍或消失時，即刻從 Leaflet Layer 中移除，嚴格限制最大渲染數量。

### 🛡️ 實戰四：API 狀態與 UTC 00:00 完美同步
**核心挑戰**：API 額度每日重置，如果前端無法準確預測重置時間，容易造成恐慌式頻繁重試。

**實作技術 (Full Stack Sync)**：
*   由後端負責精算 `unlockTime`，前端利用此指標顯示「Next Refresh」倒數計時器。
*   徹底對齊前後端的 API Request 生命週期，包含緩存過期時間 (TTL) 與計時器，達成資料庫、快取與 UI 的三重狀態同步。
