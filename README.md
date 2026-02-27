# ✈️ 暗黑全球航空雷達 (Dark Flight Radar) - 專業版 v1.2.3+

這是一款基於 **React (Vite)**、**Node.js (Express)** 與 **OpenSky Network API** 開發的高級實時全球航空監控系統。本專案專為追求「數據精準度」與「系統透明度」的資深航空愛好者打造。

---

## 🚀 v1.2.3+ 核心技術優勢

### 🌍 1. 全球大數據集成 (Global Data Mission)
- **20,329 筆全球機場庫**：棄用傳統 2.8MB 冗長檔案，改由高效能 **伺服器端動態 API** 驅動。支援 ICAO/IATA 代碼、精準座標與時區資料。
- **1,744 個航空公司別名 (Airline Aliasing)**：具備智能解析功能，能自動將呼號轉化（例如：`APJ` -> `MM` 樂桃、`TTW` -> `IT` 虎航），將原本查不到的「隱密航班」對應至正確的靜態資料庫。
- **動態時區偵測**：系統會根據目的地機場座標，自動計算並顯示各國航班的 **正確當地抵達時間**，不再只有單一時區。

### 📡 2. 數據精準度修復機制 (Data Precision)
- **雙源照片邏輯 (Dual-Source Photo Fetch)**：同時透過飛機的 **Hex (16 進位碼)** 與 **Registration (註冊號/機身編號)** 進行交叉查詢，徹底解決飛機改色、更換營運商導致的照片誤刷問題（如：解決樂桃顯示日航照片之 Bug）。
- **五階層路由解析 (5-Tier Routing)**：
  1. **Static DB**：優先檢查專業航班資料庫。
  2. **Local Dictionary**：由使用者手動維護的私信字典（`data/local_routes.json`），具備最高優先修復權。
  3. **Runtime Cache**：快速回應頻繁查詢的航班。
  4. **OpenSky Live**：向全球網路搜尋最新動態。
  5. **Historical Fallback**：若全數落空，則自動追溯該機最近 24 小時的飛行軌跡推算起降點。

### 📊 3. 後端透明化與監控 (Visibility)
- **實時請求日誌 (Request Logging)**：終端機現在能即時顯示每一筆 API 調用狀況：
  - `📡 [時間] GET /api/states - 200 (15ms)`：飛機位置刷新。
  - `❌ [時間] GET /api/route/... - 404`：航線遺失警示。
  - 包含毫秒級處理時間，讓您隨時監控伺服器負載與網路狀態。
- **多帳號輪替 (Auto-Rotation)**：支援最高 5 組 OpenSky 帳號輪替。當某帳號額度耗盡，系統會自動毫秒級切換下一個帳號，確保 24/7 不斷線。

---

## 📂 系統架構說明

```text
project_flightradar/
├── server.js               # 後端中樞：API 代理、別名解析、日誌系統、配額保護
├── data/
│   ├── processed/          # 🌍 經過精煉的 2 萬筆全球機場與航空公司 JSON 資料
│   ├── local_routes.json   # 📚 手動修正檔： CAL6876, APJ30 等航線在此永久修正
│   └── aircraft_static.json# ✈️ 特殊飛機機型資料庫
├── routes-cache.json       # 🗺️ 航班航線動態學習快取庫 (會依據即時動態更新)
├── client/                 # ⚛️ React 前端開發原碼 (Vite 架構)
└── public-react/           # ⚛️ 已編譯之現代化 Web 資源 (iOS 12+ 向下相容)
```

---

## ⚙️ 操作與運行流程

### 1. 初始設定
確保安裝 Node.js v18 以上版本。
```bash
npm install          # 安裝伺服器依賴
cd client && npm i   # 安裝前端依賴
```

### 2. 環境變數 (.env)
在根目錄新增 `.env` 檔案，配置您的 OpenSky 帳號（建議配置多個以防限流）：
```env
OPENSKY_USER=your_user_1
OPENSKY_PASS=your_pass_1
OPENSKY_USER2=your_user_2
OPENSKY_PASS2=your_pass_2
# ... 支援到 USER5
```

### 3. 一鍵啟動
執行根目錄下的批次檔或使用命令列：
- `start.bat`：啟動伺服器。
- `npm start`：手動啟動 Node.js 後端。

---

## 🛠️ 維護與疑難排解 (Maintenance)

- **修正錯誤航班資料**：若發現某航班號顯示錯誤或 `N/A`，直接在 `data/local_routes.json` 中加入該呼號與起降機場 ICAO 代碼並存檔，伺服器將優先採用新數據。
- **照片與型號**：
  - 航空器型號會優先自 `aircraft_static.json` 讀取。
  - 照片抓取若有誤，可檢查飛機註冊號碼是否更新。
- **清理過期數據**：若系統出現異常循環，可手動刪除 `routes-cache.json` 後重啟伺服器。

---
*Powered by Deepmind Antigravity Engine | Professional Data Repair Suite.*
