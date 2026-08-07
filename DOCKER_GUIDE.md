# AEROSTRAT Docker 部署指南

本指南將引導您如何在任何電腦（包括 Windows、Linux 或 Raspberry Pi）上使用 Docker 部署 AEROSTRAT。

## 系統需求
- 已安裝 [Docker Desktop](https://www.docker.com/products/docker-desktop/) (Windows/Mac) 或 Docker Engine (Linux)。
- 建議至少 2GB RAM。

## 步驟 1：準備環境與素材
1. 進入 `backend` 目錄。
2. 將 `.env.example` 複製並重新命名為 `.env` 並填入金鑰。
3. **重要：手動複製素材**：
   由於 `.gitignore` 會忽略大型素材，請將原電腦上的 `assets/AircraftShapesSVG/` 資料夾（包含內部的 SVG 檔案）複製到新電腦的相同位置。
   - `TDX_CLIENT_ID` / `SECRET` (用於航班同步)
   - `OPENSKY_USER` / `PASS` (用於 OpenSky API)

## 步驟 2：啟動 AEROSTRAT
在專案根目錄下執行以下指令：
```bash
docker compose up -d --build
```
這會自動執行以下操作：
1. 編譯前端專案。
2. 啟動後端伺服器（預設開啟 `3000` 埠），資料庫使用 SQLite（WAL 模式），檔案位於 `backend/data/aerostrat.db`，由 `./backend/data` volume 掛載持久化，無需另外啟動資料庫容器。

## 步驟 3：資料初始化
飛機註冊資料庫（Mictronics/tar1090-db）、航線資料庫（VRS）、TDX 進出港資料會在後端啟動時自動檢查並補跑（若資料為空或已過期），無需手動執行同步腳本。

## 步驟 4：驗證部署
1. 打開瀏覽器存取：`http://localhost:3000`
2. 查看日誌確認服務啟動：
   ```bash
   docker compose logs -f backend
   ```
   您應該會看到 `✅ SQLite initialized (WAL mode)`。

## 故障排除
- **飛機圖示異常**：本版本已優化高解析度（High-DPI）螢幕渲染，若仍有問題請清除瀏覽器快取。
- **重新初始化資料庫**：若需完全重設，請執行：
  ```bash
  docker compose down -v
  ```
  接著手動刪除 `backend/data/aerostrat.db`（volume 卸載不會自動清空 bind mount 裡的檔案）。這會清除所有過往軌跡資料。

---
*AEROSTRAT - 高可靠性飛行追蹤系統*
