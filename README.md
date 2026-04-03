# ✈️ AEROSTRAT 全球航空雷達系統 (Global Surveillance Radar) - v10.5 "HYBRID"
 
這是一款專門為「極端數據吞吐量」與「大數據持久化」而生的專業級全球航空監控系統。基於 **React (Vite)**、**Node.js (Worker Threads)** 與 **Hybrid Storage (SQLite + Memory)**，本系統提供 60fps 的電影級視覺體驗，具備完善的飛行紀錄與動態機型渲染功能。
 
---
 
## 🌟 核心突破架構 (Core Innovations)
 
### 🎨 1. AERO-DYNAMIC SVG 渲染引擎 (Next-Gen Visuals)
本系統實作了業界領先的「SVG Data URI 轉譯引擎」，徹底擺脫單一圖示限制：
*   **動態機型識別**：根據真實 `typecode` (如 A388, B77W, H25B) 自動切換 5 種高精度輪廓（窄體客機、廣體客機、巨無霸、輕型機、直升機）。
*   **戰術發光特效 (Neon Glow)**：內建 SVG Filter 發光濾鏡與高對比戰術配色，在任何縮放層級均能保持極致視覺清晰度。
*   **Zero-GC 渲染優化**：透過 Image Bitmap 快取與 Data URI 預編碼，確保在萬架飛機同時渲染時依然維持 60 FPS 平穩幀率。
 
### ⚡ 2. 背景情報預縫合架構 (Pre-Stitched Metadata)
為了追求毫秒級的響應速度，系統將「情報融合」壓力從讀取端移至背景寫入端：
*   **毫秒級 BBox API**：`/api/planes/bbox` 現在僅執行經緯度範圍過濾，回應時間低於 5ms，實現無感地圖拖拽。
*   **背景自動縫合**：每 30 秒自動從 MongoDB 撈取全球航機 Metadata (機型、公司) 並直接縫合至記憶體快取，確保數據即時性 100%。
 
### 🗄️ 3. 混合持久化架構 (Hybrid-Persistence)
*   **預設 SQLite 模式 (No-DB)**：系統內建 SQLite 引擎，無需安裝 MongoDB 即可自動紀錄飛行軌跡與會話，適合輕量化部署。
*   **全時自動歷史紀錄**：自動每隔數十秒抓取全球 5,000+ 架飛機座標，並以 Time-Series 模式持久化。
*   **智慧自動清理 (TTL)**：資料庫內建生存週期管理，自動清理 24-48 小時前的歷史資料。
 
---
 
## 📂 專案架構 (Architecture Map)
 
```text
project_flightradar/
├── server.js               # 核心中樞：背景情報融合、API 調度、超高速 BBox 過濾
├── socketEngine.js         # WebSocket 引擎：即時推送萬筆座標與遙測數據
├── start.bat / stop.bat    # 專用啟動腳放：自動檢查環境、資料庫狀態與自動化 Build
├── client/src/
│   ├── components/
│   │   ├── MapView.jsx     # AERO-DYNAMIC Canvas 繪圖引擎 (SVG Data URI 驅動)
│   │   └── Sidebar.jsx     # 飛行情報、機型細節與高度剖面圖
│   └── utils/
│       ├── aircraftIcons.js # SVG Data URI 指令集與轉譯引擎
│       └── flightUtils.js  # 航電計算、投影演算與垂直速率格式化
```
 
---
 
## ⚙️ 快速啟動 (Quick Start)
本專案支援 **環境預檢** 與 **混合式啟動**。

1.  **環境檢查與修復**：
    執行 `node check-env.js`。它將自動檢查 Node.js 版本、數據完整性與端口可用性。
2.  **開發模式啟動**：
    在根目錄執行 `npm run dev`。這會同時啟動後端 (Port 3000) 與前端 (Port 3005)。
3.  **前端網址**：`http://localhost:3005` (開發環境) / `http://localhost:3000` (生產環境)
 
---
 
## 📦 維護與最佳化
*   **數據即時性**：預設由 OpenSky 驅動，結合後台 Metadata 資料庫進行動態補全。
*   **效能監控**：伺服器啟動日誌會顯示 BBox API 的回應延遲與背景縫合成功率。
 
---
 
**✈️ Aerostrat - 全球飛安監控與大數據融合的極致方案。**
