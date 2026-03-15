# ✈️ AEROSTRAT 全球航空雷達系統 (Global Surveillance Radar) - v4.2.0 "Persistence Edition"

這是一款專門為「極端數據吞吐量」與「大數據持久化」而生的專業級全球航空監控系統。基於 **React (Vite)**、**Node.js (Worker Threads)** 與 **MongoDB**，本系統不僅提供 60fps 的電影級視覺體驗，更具備完善的飛行軌跡紀錄功能。

---

## 🌟 核心突破架構 (Core Innovations)

### 🗄️ 1. MongoDB 深度持久化架構 (Omni-Persistence)
本系統已全面捨棄傳統 JSON 檔案存儲，轉而採用高效能的 **MongoDB** 驅動：
*   **全時自動歷史紀錄**：當伺服器運作時，會自動每隔數十秒抓取全球 5,000+ 架飛機的座標，並透過 **Time-Series (時序資料庫)** 模式存入數據庫。
*   **毫秒級軌跡查詢**：藉由索引優化，系統能瞬間從數十萬筆紀錄中精確撈出特定飛機的飛行路徑。
*   **智慧自動清理 (TTL)**：資料庫內建生存週期管理，自動清理逾期的歷史座標，保證系統能 24/7 長期運作而不塞滿硬碟。

### 🚀 2. AERO-SYNC 原生 Canvas 渲染引擎 (Ultra-High-Performance)
*   **萬架飛機同框流暢**：全面改採硬體加速的 HTML5 Canvas 底層繪圖，支援網頁同時流暢顯示 10,000+ 飛行器。
*   **高解析度視網膜支援 (High-DPI)**：在 4K 螢幕上提供極致銳利的飛機圖示與高清航空公司徽標。
*   **FR24 風格還原**：完美重現 FlightRadar24 經典的發光立體折射、機型按比例縮放（如 A380 vs 小型 Cessna）。

### 🔐 3. 多帳號智慧調度系統 (Multi-Account API Scheduler)
*   **自動額度輪詢**：內建多組 OpenSky 帳號輪流調度算法，當一組帳號達到查詢限制時，系統會智慧切換至下一個可用帳號，保證連線不中斷。
*   **即時配額儀表板**：在 UI 上方可即時監控各帳號的剩餘點數與倒數計時。

---

## 📂 專案架構 (Architecture Map)

```text
project_flightradar/
├── server.js               # 核心中樞：資料庫管理、API 調度、軌跡過濾演算
├── socketEngine.js         # WebSocket 引擎：Delta 編碼推送萬筆座標至前端
├── start.bat / stop.bat    # 專用啟動腳本：自動檢查環境、資料庫狀態與依賴
├── .env                    # 機密配置：API 帳號與 MongoDB 連線網址
├── models/
│   ├── Aircraft.js         # 飛機數據模型 (機型、所屬公司)
│   ├── TrackPoint.js       # 軌跡時序模型 (座標、高度、速度)
│   └── Route.js            # 航線數據模型 (啟程、目的地)
├── client/src/
│   ├── App.jsx             # React UI 核心佈局
│   ├── components/
│   │   ├── MapView.jsx     # AERO-SYNC Canvas 繪圖引擎
│   │   └── Sidebar.jsx     # 飛機詳細規格與高度剖面圖
```

---

## ⚙️ 快速啟動 (Quick Start)

本專案支援 **一鍵式啟動**，會自動幫你檢查 Node.js 環境與資料庫狀態。

1.  **安裝與啟動**：
    直接雙擊執行目錄下的 `start.bat`。它會：
    *   檢查是否有安裝 Node.js 與 npm。
    *   確認 MongoDB 服務是否已啟動。
    *   自動安裝所有專案依賴。
    *   啟動前端編譯與後端伺服器。

2.  **前端網址**：`http://localhost:3000`

---

## 🛠️ 配置說明 (.env)

在專案根目錄的 `.env` 文件中，你可以配置：
*   `MONGODB_URI`: 你的本地或是雲端 MongoDB 連線網址。
*   `OPENSKY_USER / PASS`: OpenSky 帳號資訊（可配置多組，如 `USER2`, `PASS2` 等）。

---

## 📦 維護與最佳化
*   **資料清理**：軌跡資料庫設有 TTL 索引，預設自動保留 48 小時。
*   **生產環境整合**：前端編譯檔案已整合至 `public-react` 目錄，後端 Node.js 會自動代管靜態資源。

---

**✈️ Aerostrat - 全球飛安監控的極致方案。**
