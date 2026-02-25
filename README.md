# ✈️ 暗黑全球航空雷達 (Dark Flight Radar) - 終極最佳化版

基於 OpenSky Network API 與 Leaflet 開發的即時全球航空雷達系統。專注於提供極致效能、極低延遲的飛機追蹤體驗。配備充滿科技感的暗黑螢光主題介面，並**全面支援舊版瀏覽器 (最低 iOS 12 Safari / IE11)** 以及 **RWD 響應式手機底部抽屜設計**。

本專案採用 **Node.js Express 後端** 作為外部 API 的反向代理 (Reverse Proxy) 與快取層，有效隱藏 API 金鑰，具備完整的 `client_credentials` 認證機制、API 使用量監控系統，並大幅減少直接調用 API 導致的頻率限制 (Rate Limiting) 問題。

---

## ✨ 核心特色與終極優化

- **🌍 全球即時航班追蹤**：一次性快取全地球的航班位置，包含高度、速度、航向、垂直速率、SPI 等完整資訊。
- **🚀 零延遲順暢平移 (Zero-Latency Panning)**：地圖縮放或拖曳時**不再發送 API 請求**。由客戶端直接從已載入的全球資料庫中瞬間篩選可見範圍，達到無縫、無延遲的極致瀏覽體驗。
- **⏱️ 背景 60 秒定期輪詢 (開發期設定)**：為了節省開發階段的 API 額度用量，系統目前設定為每 **60 秒** (1 分鐘) 自動獲取一次全球資料。未來上線可改回 22 秒 (原定每日 4000 次完美利用額度)。
- **📱 手機端底部抽屜 (Bottom Sheet)**：特別為小螢幕設計，側邊欄改為從底部滑出，保留 55% 上半部雷達地圖可見視野。
- **🛡️ 後端代理與 API 監控儀表板**：隱藏 API 帳密，自動處理 Access Token。儀表板即時顯示 **API 總呼叫數**、**被限流次數 (429 Rate Limits)** 與 **資料庫快取數量**。
- **💾 永久快取與批次預取 (Batch Prefetch)**：自動背景抓取當下可見飛機的實體 Metadata (機型、製造商、註冊號) 並永久存檔於 `aircraft-cache.json`，查過一次永不再耗費 API 配額。
- **✈️ 飛機比例圖示與直升機支援**：根據飛機噸位 (Heavy, Large, Small, Light) 動態改變地圖圖示大小 (從 22px 到 40px)，並提供直升機專屬 SVG。
- **🔍 最近機場計算 (Nearest Airport)**：內建全球大型機場座標，使用 Haversine 大圓距離公式，即時算出飛機距離最近的機場與公里數。
- **🌐 國旗與航空公司 Logo 支援**：使用 Unicode Emoji 顯示國名國旗，並從 CDN 動態抓取全球 120+ 航空公司 Logo。
- **🇺🇸/🇹🇼 中英雙語切換 (i18n)**：單鍵即時切換整個 UI 介面語言。
- **💻 跨世代相容性 (ES5)**：全前端程式碼使用嚴格的 ES5 語法 (0 個箭頭函數、0 個模板字串)，確保在十年老舊設備上一樣順暢運行。

---

## 📂 系統架構與目錄結構

```text
project_flightradar/
├── server.js               # Express 後端伺服器 (認證、API 快取、批次預取、狀態監控)
├── aircraft-cache.json     # ✈️ 飛機 Metadata 永久離線快取資料庫
├── package.json            # 後端依賴與腳本
├── .env                    # 🔑 環境變數 (存放 API 帳密)
├── public/                 # 前端 HTML/CSS/JS 應用程式
│   └── index_cl3.html      # ⭐ 終極優化版主程式 (入口點)
```

---

## 🚀 快速開始指南

### 1. 安裝環境與套件
確保您的系統已安裝 [Node.js](https://nodejs.org/)。

```bash
# 進入專案目錄
cd project_flightradar

# 安裝依賴 (express, cors, dotenv, node-fetch)
npm install
```

### 2. 設定 .env API 憑證
1. 前往 [OpenSky Network](https://opensky-network.org/) 註冊並建立 API Client。
2. 取得 `client_id` 與 `client_secret`。
3. 在根目錄建立 `.env` 檔案：

```env
# /project_flightradar/.env
OPENSKY_USER=您的_client_id
OPENSKY_PASS=您的_client_secret
PORT=3000
```

### 3. 啟動伺服器與使用

```bash
# 啟動 Node.js 後端伺服器
node server.js
```

👉 **請開啟瀏覽器訪問終極版入口**：  
⭐ **[http://localhost:3000/index_cl3.html](http://localhost:3000/index_cl3.html)**

---

## 🔌 API 內部端點說明 

為防止 CORS 錯誤、隱藏金鑰並實作認證，後端伺服層提供了下列本地端 API：

| HTTP 方法 | 本地端 API 路由 | 用途說明 | 處理邏輯 |
|-----------|-----------------|----------|----------|
| `GET` | `/api/stats` | 查看目前的 Node API 呼叫次數、快取大小、限流狀況與運行時間。 | 系統監控 |
| `GET` | `/api/states` | 代理 OpenSky `/states/all`。抓取全球 **所有飛機** 的即時狀態。無須夾帶經緯度座標參數。 | **8 秒動態快取** |
| `GET` | `/api/tracks` | 透過 `icao24` 抓取單一飛機的完整過往軌跡線。 | 15 秒動態快取 |
| `GET` | `/api/metadata/:icao24` | 抓取單一架飛機的特徵實體資料 (機型、製造商等)。 | **永久 JSON 快取** |
| `POST` | `/api/metadata/batch` | 批量預取多架飛機特徵，上限 10 架，間隔 300ms 保護機制。 | **永久 JSON 快取** |

---

## 🛠️ 常見問題

**Q: 為什麼地圖沒有出現飛機，儀表板顯示 ⚠️ RATE LIMITS 增加？**  
A: OpenSky API 對於免費層或是剛註冊的 token 有嚴格的頻率限制 (約 5~10 秒一次)。剛啟動伺服器或過度密集重新整理網頁時會遭遇 429 限流懲罰。請**靜置網頁不操作大約 2~3 分鐘**，系統的背景定時輪詢 (Polling) 會在限流懲罰結束後自動把全球飛機抓下來並顯示在地圖上。

**Q: 如何在手機上觀看？**  
A: 確保手機與電腦在同一個 Wi-Fi 網路下，在手機瀏覽器輸入 `http://<您的電腦區域網路 IP>:3000/index_cl3.html` 即可體驗手機專屬的底部抽屜 UI 設計。
