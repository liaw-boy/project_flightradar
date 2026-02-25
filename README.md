# ✈️ 暗黑全球航空雷達 (Dark Flight Radar) - 終極最佳化版

基於 OpenSky Network API 與 Leaflet 開發的即時全球航空雷達系統。專注於提供極致效能、極低延遲的飛機追蹤體驗。配備充滿科技感的暗黑螢光主題介面，並**全面支援舊版瀏覽器 (最低 iOS 12 Safari / IE11)** 以及 **RWD 響應式手機底部抽屜設計**。

本專案採用 **Node.js Express 後端** 作為外部 API 的反向代理 (Reverse Proxy) 與快取層，有效隱藏 API 金鑰，具備完整的 `client_credentials` 認證機制、**多帳號自動輪替 (Token Rotation)** 與 API 使用量監控系統。

---

## ✨ 核心特色

- **🌍 全球即時航班追蹤**：一次性快取全地球的航班位置，包含高度、速度、航向、垂直速率、SPI 等完整資訊。
- **🚀 零延遲順暢平移 (Zero-Latency Panning)**：地圖縮放或拖曳時**不再發送 API 請求**。由客戶端直接從已載入的全球資料庫中瞬間篩選可見範圍。
- **⏱️ 分散式雙帳號輪詢**：支援多組 OpenSky 帳號自動輪替。目前配置兩組帳號，API 額度翻倍至每日 8000 次，系統優化為 **每 11 秒** 更新一次全球資料。
- **⚛️ 雙版本並存 (HTML + React)**：經典 HTML 版 (`index_cl3.html`) 與現代 React 版 (`/`) 同時部署在同一伺服器上。
- **🏗️ 全球機場標記 (Airport Markers)**：內建全球主要國際機場座標，根據地圖縮放層級自動顯示/隱藏機場圖示與名稱標籤，方便定位航班出發與降落地點。
- **📱 全方位 RWD 響應式設計**：完美兼容各種視窗尺寸與設備 — 桌面大螢幕、平板 (iPad)、各品牌手機 (iPhone / Android)，乃至 **iOS 12 Safari、Android 5+ WebView、IE11** 等老舊系統瀏覽器。手機端側邊欄自動變為底部抽屜 (Bottom Sheet)，保留 55% 上半部雷達視野。
- **🛡️ 後端代理與 API 監控儀表板**：隱藏 API 帳密，自動處理 Access Token。儀表板即時顯示 API 呼叫數、限流次數與快取數量。
- **💾 永久快取與批次預取 (Batch Prefetch)**：自動背景抓取當下可見飛機的實體 Metadata 並永久存檔於 `aircraft-cache.json`。
- **✈️ 飛機比例圖示與直升機支援**：根據飛機噸位動態改變地圖圖示大小，並提供直升機專屬 SVG。
- **🔍 最近機場計算**：使用 Haversine 大圓距離公式，即時算出飛機距離最近的機場與公里數。
- **🌐 國旗與航空公司 Logo 支援**：Unicode Emoji 國旗 + CDN 動態抓取全球 120+ 航空公司 Logo。
- **🇺🇸/🇹🇼 中英雙語切換 (i18n)**：單鍵即時切換整個 UI 介面語言。
- **💻 跨世代相容性 (ES5)**：HTML 版前端程式碼使用嚴格的 ES5 語法，確保在十年老舊設備上順暢運行。

---

## 📂 系統架構與目錄結構

```text
project_flightradar/
├── server.js               # Express 後端 (多帳號認證、輪替、API 快取、監控)
├── aircraft-cache.json     # ✈️ 飛機 Metadata 永久離線快取
├── .env                    # 🔑 環境變數 (存放多組 API 帳密)
├── start.bat               # Windows 一鍵啟動
├── public/                 # 🏛️ 經典 HTML 版前端
│   └── index_cl3.html      # ⭐ ES5 終極優化版主程式
├── client/                 # ⚛️ React 版前端原始碼
│   ├── src/
│   │   ├── App.jsx
│   │   ├── components/     # MapView, Dashboard, Sidebar, SearchBar...
│   │   ├── hooks/          # useFlightData, useNotification
│   │   └── utils/          # flightUtils (解析器、SVG 產生器)
│   └── vite.config.js      # Vite 建置設定 (proxy → localhost:3000)
└── public-react/           # ⚛️ React 版建置輸出 (npm run build)
```

---

## 🚀 快速開始指南

### 1. 安裝環境與套件
確保您的系統已安裝 [Node.js](https://nodejs.org/)。

```bash
cd project_flightradar
npm install
```

### 2. 設定 .env API 憑證
1. 前往 [OpenSky Network](https://opensky-network.org/) 註冊並建立 API Client。
2. 取得 `client_id` 與 `client_secret`。
3. 在根目錄建立 `.env` 檔案：

```env
OPENSKY_USER=您的_client_id_1
OPENSKY_PASS=您的_client_secret_1
PORT=3000

# (選用) 第二組帳號 - 額度翻倍至 8000次/天
OPENSKY_USER2=您的_client_id_2
OPENSKY_PASS2=您的_client_secret_2
```

### 3. 啟動伺服器

```bash
node server.js
# 或是直接雙擊 start.bat
```

### 4. 開啟雷達

| 版本 | 網址 | 說明 |
|------|------|------|
| ⚛️ React 版 | [http://localhost:3000/](http://localhost:3000/) | 現代化組件架構 |
| 🏛️ HTML 經典版 | [http://localhost:3000/index_cl3.html](http://localhost:3000/index_cl3.html) | ES5 相容、極致輕量 |

---

## 🔌 後端 API 端點說明

| HTTP | 路由 | 說明 | 快取 |
|------|------|------|------|
| `GET` | `/api/health` | 伺服器健康狀態、目前使用帳號、帳號總數 | — |
| `GET` | `/api/stats` | API 呼叫次數、限流次數、快取大小、活躍帳號 | — |
| `GET` | `/api/states` | 代理 OpenSky `/states/all`，抓取全球所有飛機即時狀態 | **8 秒** |
| `GET` | `/api/tracks?icao24=` | 單一飛機的飛行軌跡線 | 15 秒 |
| `GET` | `/api/metadata/:icao24` | 飛機特徵資料 (機型、製造商等) | **永久** |
| `POST` | `/api/metadata/batch` | 批量預取多架飛機特徵 (上限 10 架) | **永久** |

---

## 📡 OpenSky API 完整資料分析

### `/states/all` 回傳的 18 個欄位 (State Vector)

| Index | 欄位名稱 | 類型 | 我們是否使用 | 說明 |
|-------|----------|------|:---:|------|
| 0 | `icao24` | string | ✅ | 飛機唯一識別碼 (ICAO 24-bit 十六進制) |
| 1 | `callsign` | string | ✅ | 航班呼號 (如 `EVA252`) |
| 2 | `origin_country` | string | ✅ | 註冊國家名稱 |
| 3 | `time_position` | int | ✅ | 最後一次位置更新的 Unix 時間戳 |
| 4 | `last_contact` | int | ✅ | 最後一次訊號接收的 Unix 時間戳 |
| 5 | `longitude` | float | ✅ | WGS-84 經度 |
| 6 | `latitude` | float | ✅ | WGS-84 緯度 |
| 7 | `baro_altitude` | float | ✅ | 氣壓高度 (公尺) |
| 8 | `on_ground` | bool | ✅ | 是否在地面 |
| 9 | `velocity` | float | ✅ | 地面速度 (m/s) |
| 10 | `true_track` | float | ✅ | 真航向 (度) |
| 11 | `vertical_rate` | float | ✅ | 垂直速率 (m/s，正=爬升) |
| 12 | `sensors` | int[] | ❌ | 貢獻此資料的接收器 ID 列表 |
| 13 | `geo_altitude` | float | ❌ | **幾何高度** (GPS 高度，與氣壓高度不同) |
| 14 | `squawk` | string | ✅ | 應答機代碼 (Squawk) |
| 15 | `spi` | bool | ✅ | 特殊位置識別 (Special Purpose Indicator) |
| 16 | `position_source` | int | ❌ | **位置來源** (0=ADS-B, 1=ASTERIX, 2=MLAT, 3=FLARM) |
| 17 | `category` | int | ❌ | **飛行器類別** (見下表) |

### 飛行器類別 (Category) 對照表

| 代碼 | 類別 | 代碼 | 類別 |
|------|------|------|------|
| 0 | 無資訊 | 8 | 旋翼機 (直升機) |
| 2 | Light (< 15,500 lbs) | 9 | 滑翔機 |
| 3 | Small (15,500-75,000 lbs) | 10 | 輕型飛船 |
| 4 | Large (75,000-300,000 lbs) | 11 | 跳傘員 |
| 5 | High Vortex Large (B-757 等) | 12 | 超輕航空器 |
| 6 | Heavy (> 300,000 lbs) | 14 | **無人機 (UAV)** |
| 7 | High Performance (> 5g) | 15 | 太空載具 |

### 🛫 關於「飛機目的地」

> **OpenSky 的即時 API (`/states/all`) 不提供目的地資訊。**

但可以透過以下**額外端點**取得出發/目的地機場 (資料延遲約 1 天)：

| HTTP | 端點 | 說明 | 回傳關鍵欄位 |
|------|------|------|-------------|
| `GET` | `/flights/aircraft?icao24=&begin=&end=` | 查詢特定飛機的航班記錄 | `estDepartureAirport`, **`estArrivalAirport`** |
| `GET` | `/flights/departure?airport=&begin=&end=` | 查詢某機場的出發航班 | `estArrivalAirport`, `callsign` |
| `GET` | `/flights/arrival?airport=&begin=&end=` | 查詢某機場的抵達航班 | `estDepartureAirport`, `callsign` |
| `GET` | `/flights/all?begin=&end=` | 查詢時間區間內所有航班 | 出發/到達機場、時間 |

> ⚠️ **注意**：這些航班端點的資料是**每日夜間批次更新**的，並非即時資料。時間區間上限為 2 小時。

---

## 🗺️ 未來功能增強路線圖 (Roadmap)

### 🔴 高優先 — 可立即加入

| 功能 | 說明 | 資料來源 |
|------|------|---------|
| **幾何高度 (GPS Altitude)** | 在側邊欄同時顯示氣壓高度與 GPS 高度的差異 | `state[13]` |
| **位置來源標記** | 用不同的圖標底色區分 ADS-B / MLAT / FLARM 位置 | `state[16]` |
| **飛行器類別篩選** | 新增篩選器：只顯示商用客機 / 直升機 / 無人機 / 滑翔機等 | `state[17]` |
| **航班歷史查詢 (目的地)** | 點選飛機後，從 `/flights/aircraft` 查出它昨天的出發/目的地機場 | `/flights/aircraft` |

### 🟡 中優先 — 需要額外開發

| 功能 | 說明 |
|------|------|
| **機場出發/抵達看板** | 模擬機場大廳的出發/到達航班資訊板，顯示所有進出航班 |
| **速度單位切換** | 支援 m/s、km/h、knots 三種速度單位即時切換 |
| **高度單位切換** | 支援公尺 (m) 與英呎 (ft) 切換 |
| **多語言擴充** | 加入日文 (🇯🇵)、韓文 (🇰🇷) 等更多語言 |
| **飛機收藏與追蹤清單** | 允許用戶收藏特定飛機，追蹤它的每日航線 |
| **WebSocket 即時推播** | 取代目前的 HTTP 輪詢，使用 WebSocket 實現真正的即時推送 |

### 🟢 低優先 — 進階功能

| 功能 | 說明 |
|------|------|
| **3D 地球儀視角** | 使用 Cesium.js 或 Globe.gl 實現 3D 地球渲染 |
| **歷史回放 (Time Machine)** | 利用 OpenSky 歷史資料庫回放過去任意時段的空域狀態 |
| **碰撞風險警報** | 計算附近飛機的距離與航向，偵測潛在衝突 |
| **天氣圖層疊加** | 在地圖上疊加即時氣象雷達 (如雷雨、風場) |

---

## 🛠️ 常見問題

**Q: 為什麼地圖沒有出現飛機，儀表板顯示 ⚠️ RATE LIMITS 增加？**  
A: OpenSky API 有嚴格的頻率限制。剛啟動伺服器時會遭遇 429 限流懲罰。請**靜置網頁不操作大約 2~3 分鐘**，系統的背景輪詢會在限流結束後自動把全球飛機抓下來並顯示。如果配置了雙帳號，系統會自動切換到未被限流的帳號繼續運作。

**Q: 如何查看飛機的目的地？**  
A: OpenSky 的即時 API 不提供目的地。但可以透過 `/flights/aircraft` 端點查詢該飛機**昨天**的航班記錄來得知出發/目的地機場 (ICAO 代碼)。此功能已列入開發路線圖。

**Q: 如何在手機上觀看？**  
A: 確保手機與電腦在同一個 Wi-Fi 網路下，在手機瀏覽器輸入 `http://<您的電腦區域網路 IP>:3000/index_cl3.html` 即可。

**Q: React 版和 HTML 版有什麼差別？**  
A: 兩者連接到同一個後端 API，功能完全相同。HTML 版是單一檔案、ES5 相容、極致輕量；React 版是現代組件化架構，適合未來功能擴展。
