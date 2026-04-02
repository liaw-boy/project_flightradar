# AEROSTRAT Flight Radar

AEROSTRAT 是一個基於 React (Vite)、Node.js 與 MongoDB 的航班監控系統，提供即時的全球航班追蹤與歷史軌跡查詢功能。

## 主要功能

### 1. 前端渲染
*   **動態機型圖示**：根據真實 `typecode` 自動切換不同機型的 SVG 圖示（包含客機、輕型機、直升機等）。
*   **Canvas 繪圖效能優化**：透過 ImageBitmap 快取與預先處理 Data URI，確保在地圖上同時渲染大量飛機時的流暢度。

### 2. 後端與資料處理
*   **BBox API 優化**：`/api/planes/bbox` API 專注於空間範圍過濾，提供快速的航班位置查詢。
*   **背景資料整合**：系統定期從資料庫取得航班 Metadata，並於記憶體中與即時位置資料整合。

### 3. 資料儲存
*   **歷史軌跡紀錄**：自動抓取並儲存航班座標，以 Time-Series 格式存入 MongoDB。
*   **自動清理過期資料**：利用 MongoDB TTL 索引，自動刪除 48 小時前的舊資料。

## 專案架構

```text
project_flightradar/
├── server.js               # 核心伺服器，處理 API 與背景資料整合
├── socketEngine.js         # WebSocket 服務，推送即時航班資料
├── setup.bat / check-env.js # 環境檢查與初始化腳本
├── backend/                # 後端程式碼與設置
├── client/src/
│   ├── components/
│   │   ├── MapView.jsx     # Canvas 地圖渲染元件
│   │   └── Sidebar.jsx     # 側邊欄，顯示航班詳細資訊與高度圖
│   └── utils/
│       ├── aircraftIcons.js # SVG 圖示產生與處理
│       └── flightUtils.js  # 相關輔助計算函式
```

## 快速啟動

本專案包含自動化啟動腳本。

1.  **安裝與啟動**：
    執行 `setup.bat`（Windows）以檢查環境、安裝依賴套件並啟動服務。
2.  **存取本機服務**：
    開啟瀏覽器前往 `http://localhost:3000`

## 資料來源
預設使用 OpenSky Network API 提供即時航班資料，並結合本地資料庫的 Metadata 進行擴充。
