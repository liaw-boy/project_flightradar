# AEROSTRAT 多裝置同步與快速啟動指南

當你在另一台電腦同步此專案時，請按照以下步驟完成環境初始化。

## 1. 程式碼同步 (Code Sync)
確保已拉取最新的程式碼：
```powershell
git pull
```

## 2. 環境變數設定 (.env Setup)
確保專案根目錄下有 `.env` 檔案。你需要配置以下關鍵金鑰：
```env
# 核心 API (用於深層飛機資料與外部航線備援)
AERODATABOX_API_KEY=你的_RapidAPI_金鑰

# MongoDB 連線 (預設為本地)
MONGODB_URI=mongodb://127.0.0.1:27017/aerostrat
```

## 3. 全球資料庫初始化 (Data Seeding)
**這是最重要的步驟。** 由於 MongoDB 儲存於本地，新電腦必須重新執行同化腳本以建立全球 30,000+ 機場與航空公司資料庫：
```powershell
node seedGlobal.js
```
*此腳本會下載約 10MB 的資料並寫入本地 MongoDB。*

## 4. 一鍵啟動 (Startup)
專案內建了 `start.bat` 指標腳本，會自動檢查 Node.js、安裝套件、啟動 MongoDB 服務、編譯前端並開啟伺服器：
```powershell
./start.bat
```

---

### 已建置的核心功能摘要 (可參閱 brain 目錄)
*   **全天候背景輪詢**：伺服器啟動後即自動抓取全球飛機快照，不依賴網頁開啟。
*   **24h 軌跡紀錄**：自動將抓取到的點位存入 `TrackPoint`，並設有 24 小時自動過期機制 (TTL)。
*   **航空公司識別系統**：本地 6,000+ 航空公司資料，包含自動配對的 Logo。
*   **全球機場庫**：本地 29,000+ 機場實體資料，支援 ICAO/IATA 瞬間查詢。
