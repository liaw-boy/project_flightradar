# ✈️ 暗黑全球航空雷達 (Dark Flight Radar) - React 專業版 v1.1.0

基於 OpenSky Network API、React (Vite) 與 Leaflet 開發的即時全球航空雷達系統。本專案 v1.1.0 引入了業界領先的**「動態配額延展 (Quota Stretching)」**技術與**「多帳號智能輪替系統」**，徹底解決了 OpenSky 免費版 API 嚴格限制的痛點。

系統採用 **Node.js Express 後端** 作為強大的運算與快取層，具備自動化 API 狀態監控、**動態頻率節流**與「本地端靜態航線字典」，搭配 **React 前端 v1.1.0** 打造出具備精密儀表板、零延遲地圖且高效能的飛行監控體驗。

---

## ✨ v1.1.0 核心特色與技術突破

- **⚛️ 智慧動態配額保護 (Quota Stretching)**：
  - **創新演算法**：系統會自動計算「當前剩餘額度」與「距離每日 08:00 (UTC 00:00) 還有幾秒」。
  - **自動節流**：後端會動態計算出最完美的 `recommendedInterval`（如 18 秒、45 秒等），確保額度能精準平分給今天剩下的每一秒，**永久告別額度提前歸零的窘境**。
- **📊 多帳號 API 儀表板 (SVG Multi-Account Stats)**：
  - **視覺化監控**：全新的 API STATS 面板，為每一組 OpenSky 帳號提供獨立的 **SVG 環形進度條**，即時顯示剩餘百分比。
  - **自動出獄倒數**：當帳號因過度請求被 OpenSky「關小黑屋 (Penalty Box)」時，系統會精準攔截 `Retry-After` 秒數並顯示出獄時間。
  - **重生點顯示**：健康帳號會自動將 `UTC 00:00` 轉換為您的**本地系統時間**（如 RESETS: 08:00:00）。
- **🛡️ 雙帳號自動輪替機制**：支援在 `.env` 設定多組帳號。當第一組帳號額度耗盡或被鎖定時，伺服器會**毫秒級自動切換**至第二組帳號，並在 UI 上即時顯示目前活躍的帳號身份。
- **⛅ METAR 即時機場氣象**：整合全球 40+ 機場的即時 METAR 分報，在側邊欄顯示機場的雲量、能見度、風向與氣壓，提供專業級的飛行環境參考。
- **📱 舊設備完美向下相容 (iOS 12+)**：導入 `@vitejs/plugin-legacy`，確保 iPad mini 4 (iOS 12.5.8) 等舊設備也能流暢運行現代化的 React 邏輯。
- **✈️ 動態歷史軌跡與防震跳**：保留 500 個點跡。新增 Anti-Teleportation 逻辑，過濾掉因 API 資料異常產生的「超音速神仙跳躍」偽軌跡。

---

## 📂 系統架構與目錄結構

```text
project_flightradar/
├── server.js               # 後端核心：動態節流演算法、API 智能代理、帳號輪替
├── .env                    # 🔑 帳密存放處 (支援多帳號配置)
├── metar-cache.json        # ⛅ 機場天氣快取 (減少外部請求)
├── aircraft-cache.json     # ✈️ 飛機機型與註冊資訊永久快取
├── data/
│   └── local_routes.json   # 📚 零延遲本地航線字典 (主攻 OpenSky 查不到的隱藏航線)
├── client/                 # ⚛️ React 前端開發源碼
│   ├── src/
│   │   ├── hooks/          # useFlightData (包含智慧迴圈 fetch 邏輯)
│   │   └── components/     # Dashboard (v1.1.0 SVG 儀表板實作)
└── public-react/           # ⚛️ 編譯後的靜態資源檔 (Express 服務對象)
```

---

## 🚀 部署與啟動指南

### 1. 安裝環境
確保安裝 Node.js v18+。
```bash
npm install          # 安裝後端
cd client
npm install          # 安裝前端
```

### 2. 設定多帳號彈性額度
在根目錄建立 `.env`：
```env
OPENSKY_USER=帳號1
OPENSKY_PASS=密碼1

# 額外解鎖多帳號 (強烈建議，增加每日額度)
OPENSKY_USER2=帳號2
OPENSKY_PASS2=密碼2
```

### 3. 編譯並啟動
```bash
# 在 client 目錄編譯
npm run build

# 回到根目錄啟動
cd ..
npm start
```
👉 **網址：[http://localhost:3000/](http://localhost:3000/)**

---

## 🛠️ 維護指南

1. **強制重新整理快取**：當系統版本更新 (如 v1.1.0) 後，建議在瀏覽器按下 **Ctrl + F5**。
2. **新增私房航線**：若看到 `N/A` 航班，可手動將航班號加入 `data/local_routes.json` 後重啟伺服器，即可實現「秒開」航線對應。
3. **API 鎖定處理**：若所有帳號都顯示「RESTRICTED (紅色)」，系統會自動將 `NEXT REFRESH` 拉長以符合 OpenSky 的處分秒數，請耐心等待「UNLOCKS」時間到達。

---

## 📜 版本更新紀錄

- **`v1.1.0` (當前版本)**
  - **核心升級**：實作「動態配額延展 (Quota Stretching)」演算法。
  - **UI 大改成**：API STATS 面板升級為獨立帳號 SVG 環形進度條。
  - **時間機制**：新增「自動 UTC 轉本地」RESET 展示。
  - **功能增強**：整合 METAR 機場天氣實時同步。
  - **穩定性**：優化 Rate Limit 偵測邏輯，解決惡意封鎖秒數解析。
- **`v1.0.26`**
  - 支援多帳號輪替、本地航線字典、iOS 12 舊設備 Polyfills、無限滾動地圖。
- **`v1.0.0`**
  - 最初 React 重構版，取代舊式 HTML/JS 專案。

---
*Developed by Antigravity AI Engine for Professional Radar Monitoring.*
