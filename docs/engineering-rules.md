# 工程守則：會長大的東西都要有上限

2026-09 一連串事故的共同根因不是邏輯寫錯，而是「東西會一直長大，但沒人規劃它怎麼變小」：

| 事故 | 會長大的東西 | 後果 |
|---|---|---|
| 記憶體 14 天 334MB → 34GB | `lastStoredPoint`、`trackCache`、`routeCache` 等 Map 只寫不清 | 整台主機記憶體吃光 |
| 航跡模型連續 11 晚訓練失敗 | `prediction_log` 表 2.46 億筆、每天 +1,760 萬筆，無保留政策 | 重訓查詢超過 30 分鐘被砍，模型 14 天沒更新 |
| `/predict_batch` 頻繁 timeout | 每輪對全機隊預測，batch 隨全球飛機數成長到 10,500+ | 預測服務逾時，連帶讓廣播被跳過 |
| adsb.lol 週期性 429 | 輪詢頻率固定，流量成長後不再足夠 | 地圖定期凍結 |

## 四條守則

1. **新增任何會累積的狀態時，同時寫出它怎麼縮小。**
   Map / Set / cache / DB 表 / log 檔，在同一個 commit 裡定義 TTL、上限或清理排程。參考寫法：`server.js` 的 cache reaper、`db/sqlite.js` 的 `prunePredictionLog`。
   大表的批次刪除要實測單批耗時——同樣 5000 筆，在 `prediction_log` 上一批會卡住 event loop 近 1 秒。

2. **依「目前流量」校準的常數，要標註它會過期。**
   timeout、batch size、輪詢間隔這類數字，註解寫明是依什麼量測、在什麼規模下校準的，並且能做成隨規模調整就不要寫死。反例：`trajectoryPredictor.js` 的 `REQUEST_TIMEOUT_MS` 依「5000 筆 batch」校準，機隊長到兩倍後就開始逾時；outage 秒數寫死 `* 5`，輪詢間隔改了兩次都沒跟著改。

3. **多個服務共用有限資源時，一開始就設計隔離。**
   即時推論（`aerostrat-trajectory-predictor.service`）與夜間重訓共用同一張 GPU；任何新的 GPU / DB 寫入 / 外部 API 使用者，都要先想清楚它跟既有使用者搶資源時誰讓誰。

4. **失敗告警要能分辨「一次」和「一直」。**
   每晚都有 Discord 失敗通知，仍然 11 天沒人處理。重複失敗要升級（`server.js` 重訓 cron 已改為「連續失敗 N 晚」標題），而且失敗時要保留足夠的現場資訊（stdout/stderr、各階段耗時）。
