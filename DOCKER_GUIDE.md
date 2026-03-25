# AEROSTRAT Docker 部署與遷移指南

本指南將說明如何將 AEROSTRAT 專案部署到另一台電腦（如 Linux 伺服器、另一台 Windows 電腦或 Raspberry Pi）上。

## 1. 準備工作

在目標電腦上，您需要安裝：
- **Docker**: [安裝教學](https://docs.docker.com/get-docker/)
- **Docker Compose**: (現代 Docker 版本已內建 `docker compose` 指令)

## 2. 遷移檔案

您可以透過 Git clone 或直接複製資料夾的方式將專案移至目標電腦。請確保包含以下目錄結構：

```text
/project_flightradar
  ├── backend/
  │   ├── .env (需要根據範例手動建立)
  │   ├── credentials1.json (若有使用的話)
  │   └── ...
  ├── docker-compose.yml
  └── ...
```

## 3. 環境變數配置 (.env)

在目標電腦的 `backend/` 目錄下，根據 `.env.example` 建立 `.env` 檔案：

```bash
cp backend/.env.example backend/.env
```

請編輯 `backend/.env` 並填入必要的資訊：
- `MONGODB_URI`: 在 Docker 中請保持 `mongodb://mongodb:27017/aerostrat` (程式會自動抓取 service name)。
- `TDX_CLIENT_ID / SECRET`: 若要同步航班時刻表則需填寫。
- `OPENSKY_USER / PASS`: 若有註冊 OpenSky 帳號可填寫以增加 API 額度。

## 4. 啟動服務

在專案根目錄下執行以下指令：

```bash
# 建立並啟動容器
docker compose up -d --build
```

- `-d`: 在背景執行。
- `--build`: 強制重新編譯映像檔（確保程式碼變更生效）。

## 5. 驗證運行狀態

執行以下指令查看容器狀態：

```bash
docker compose ps
```

您可以透過瀏覽器存取：`http://<目標電腦IP>:3000`

## 6. 特殊說明 (Raspberry Pi / ARM)

如果您是在 Raspberry Pi 4/5 上執行，Docker Compose 會自動根據您的處理器架構偵測並編譯對應的映像檔。

> [!TIP]
> **效能建議**：在 Raspberry Pi 上首次編譯可能需要較長時間（約 5-10 分鐘），請耐心等候。

## 7. 常用維護指令

- **查看日誌**：`docker compose logs -f backend`
- **停止服務**：`docker compose stop`
- **移除容器與網絡**：`docker compose down`
- **備份資料庫**：掛載的 `mongo-data` 資料夾即包含所有持久化數據。
