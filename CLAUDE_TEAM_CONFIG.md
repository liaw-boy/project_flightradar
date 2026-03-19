# AEROSTRAT Agent Swarm 團隊配置

本檔案定義了 AEROSTRAT 專案專屬的代理團隊（Agent Teams）角色與協作流程，基於 Claude Code 的 Swarm 協議優化。

## 1. 核心團隊 (Core Teams)

### 🛰️ Data Integration Team (數據整合組)
*   **目標**: 處理 TDX 爬蟲、數據清洗、OpenSky/ADSB-Fi 融合與緩存策略。
*   **建議配置**:
    - `Lead`: 負責協調整體數據流向。
    - `Researcher`: 負責查詢 TDX API 變動或新的航班元數據來源。
    - `Implementer`: 專門寫 Node.js 爬蟲邏輯。

### 🎨 UI Performance Team (前端性能組)
*   **目標**: 優化 Leaflet Canvas 渲染、實現 60FPS 平滑動畫、處理大規模飛機圖標緩存。
*   **建議配置**:
    - `Renderer-Spec`: 專精於 `MapView.jsx` 與 Canvas API。
    - `Verification`: 負責在多種瀏覽器環境下測試幀率 (FPS)。

---

## 2. 協作協議 (Swarm Protocol)

- **同步指令**: 在終端輸入 `/swarm [指令]` 來啟動團隊。
- **隔離重構**: 針對大規模 API 改動，優先使用 `isolation: "worktree"` 模式。
- **自動報告**: 每個隊員完成工作後，必須產生一份 `Task Summary` 傳回給 Team Lead。

## 3. 啟動範例

```bash
/swarm "整合 TDX 歷史航跡 API 並實現後端緩存邏輯"
```
這將自動喚醒數據組，並根據 `CLAUDE_TEAM_CONFIG.md` 分配子任務。
