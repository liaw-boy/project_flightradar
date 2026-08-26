# 部署 / 重啟正式站

## 正式站是誰在管

`backend/server.js` 由 **systemd user service** `aerostrat.service` 管理，不是 pm2（`deploy.sh` 舊版寫的 `pm2 reload` 是過時資訊，機器上根本沒裝 pm2）。

服務定義：`~/.config/systemd/user/aerostrat.service`

```ini
WorkingDirectory=/home/eric/lbw_project/project_aerostrat/backend
ExecStart=.../node server.js
Environment=PORT=3000

Restart=always
RestartSec=5
```

**`Restart=always` 代表 process 只要退出（不管是正常結束還是當掉）,systemd 會在 5 秒內自動重啟。**

## ⚠️ 絕對不要手動 `kill` + `node server.js &`

2026-08-25 發生過一次事故：手動 `kill <pid>` 之後立刻 `nohup node server.js &`,結果跟 systemd 的自動重啟機制互搶 port 3000——兩個 process 短暫同時存在,對同一個 SQLite WAL 檔案並發寫入,造成三層輪詢引擎卡死。`journalctl` 上能看到同一分鐘內好幾個不同 PID 輪流因為 `EADDRINUSE` 死掉重生,間隔剛好是 `RestartSec=5`。

**正確重啟方式只有一種：**

```bash
systemctl --user restart aerostrat.service
```

## 標準重啟流程

```bash
# 1. 語法檢查（先確認不會直接炸掉）
node -c backend/server.js

# 2. 重啟
systemctl --user restart aerostrat.service

# 3. 確認狀態、只有一個 PID
systemctl --user status aerostrat.service --no-pager

# 4. 確認沒有 EADDRINUSE 或其他錯誤
journalctl --user -u aerostrat.service --since "1 minute ago" --no-pager | grep -iE "error|exception"

# 5. 驗證功能
curl -s http://localhost:3000/api/ping
curl -s http://localhost:3000/api/data-freshness

# 6. 觀察融合引擎持續運作（至少看到 10+ 輪 Global baseline，不要看一次就放心）
journalctl --user -u aerostrat.service -f | grep "SYNC"
```

## 常用指令

| 目的 | 指令 |
|---|---|
| 重啟 | `systemctl --user restart aerostrat.service` |
| 停止 | `systemctl --user stop aerostrat.service` |
| 啟動 | `systemctl --user start aerostrat.service` |
| 查狀態 | `systemctl --user status aerostrat.service` |
| 即時 log | `journalctl --user -u aerostrat.service -f` |
| 最近 log | `journalctl --user -u aerostrat.service --since "10 minutes ago"` |

## 在正式站生效前，先在 scratch instance 驗證

改動 `backend/` 底下的程式碼後，**不要直接重啟正式站測**。先在另一個 port（例如 3099）跑一個獨立 instance 驗證：

```bash
cd backend
PORT=3099 AEROSTRAT_DB_PATH=/tmp/aerostrat_scratch.db nohup node server.js > /tmp/scratch.log 2>&1 & disown
```

驗證完，**只殺掉 scratch instance 自己的 PID**（用 `ss -ltnp | grep :3099` 確認 PID，不要用會誤殺其他 process 的模糊 pattern 比對），確認正式站（3000 port）沒被動到，才考慮用上面的標準流程重啟正式站。

**務必帶上 `AEROSTRAT_DB_PATH`**，讓 scratch instance 寫自己獨立的 SQLite 檔案。早期版本讓 scratch 跟正式站共用同一個 `backend/data/aerostrat.db`（當時視為預期行為），但兩個獨立 process 在 WAL 模式下對同一檔案並發寫入，會在其中一方跑 checkpoint／VACUUM 或另一方交易未提交時造成實際的 page 損毀——2026-08-26 兩次 scratch 驗證（posTime 修復、FlightBoard 移植）之後，正式站在下一次整點 prune 都各自跳出一次 `database disk image is malformed`，時間點精準對應。`AEROSTRAT_DB_PATH` 未設定時預設仍是 `backend/data/aerostrat.db`（即正式站路徑），所以這個環境變數是必要、不是可選的。
