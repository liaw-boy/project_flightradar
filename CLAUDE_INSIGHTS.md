# Claude Code 系統提示詞深度分析與架構洞察報告

本文件總結了對 Anthropic `claude-code` 系列洩漏提示詞（System Prompts）的分析結果。這些洞察揭示了 Claude Code 的核心運作邏輯、安全策略、開發工作流以及代理協作（Swarm/Agent Teams）的實現方式。

## 1. 核心架構：代理協作 (Agentic Architecture)

Claude Code 並非單一的大型模型呼叫，而是由多個專門化代理構成的生態系統。

### 關鍵代理類型 (Agent Types)
- **Explore (探索者)**: 專職代碼庫掃描。支援 `quick`、`medium`、`very thorough` 三種徹底程度。優先用於模糊搜索、查找實例、理解架構。
- **Plan (架構師)**: 不進行代碼編寫，專門生成步驟化實施計畫。負責識別關鍵文件與架構權衡。
- **Bash (執行員)**: 專精於終端指令執行（Git, NPM, Docker）。
- **Verification Specialist (驗證專家)**: 一種專門的 Persona，用於「破壞」代碼以驗證其健壯性，而非僅僅通過測試。

### 協作模式 (Swarm Protocol)
- **訊息傳遞**: 代理之間透過 `SendMessage` (`type: "message"` 或 `"broadcast"`) 進行結構化溝通。
- **資源清理**: 使用 `TeamDelete` 在任務完成後清理臨時專案目錄與背景進程。
- **隔離執行**: 支援 `isolation: "worktree"`，允許代理在獨立的 Git Worktree 中運行，避免破壞主分支。

---

## 2. 自動化工作流：Hooks 系統

這是 Claude Code 實現「開發自動化」的秘密武器。透過 `settings.json` 中的 `hooks` 節點，可以在特定事件發生時自動執行指令。

### 常見事件 (Events)
- `PreToolUse`: 在工具執行前（如 `Bash`, `Write`）進行攔截或預檢。
- `PostToolUse`: 工具執行成功後觸發。最常用於：
    - **自動格式化**: `PostToolUse(Write|Edit) -> prettier --write $FILE`
    - **自動測試**: `PostToolUse(Write|Edit) -> npm test`
- `Stop`: 在工作階段結束、Clear 或 Compact 時執行的清理動作。

---

## 3. 開發守則與專業準則

洩漏出的提示詞強調了極高的專業與客觀性標準：

- **專業客觀性 (Professional Objectivity)**: 優先考慮技術真實性而非迎合使用者。如果使用者是錯的，必須客觀指正。
- **嚴禁佔位符 (No Placeholders)**: 嚴禁寫出 `// TODO: implement later`。必須提供完整、可執行的代碼。
- **禁止時間預估 (No Time Estimates)**: 禁止說「這很快」、「只需要 5 分鐘」。專注於任務本身，由使用者判斷進度。
- **簡單至上 (Simplicity)**: 3 行相似代碼優於過早的抽象化（Premature Abstraction）。

---

## 4. 進階工具與技術細節

### 瀏覽器自動化 (Browser Automation)
- **GIF 錄製**: 支援自動錄製操作過程並導出 GIF，提供點擊指示器與水印，用於 Demo 演示。
- **無障礙樹 (Accessibility Tree)**: 優先使用無障礙樹 (A11Y Tree) 來理解頁面結構，而非單純的 HTML 解析。

### 交互模式
- **Learn by Doing**: 代理會在代碼中加入 `TODO(human)`，並引導使用者手動實現核心算法或設計決策，以達到教學目的。
- **EnterPlanMode**: 進入計畫模式，要求使用者簽署（Sign-off）具體方案後才開始編寫代碼。

---

## 5. 對 AEROSTRAT 專案的實踐建議

基於上述洞察，我們可以對本專案進行以下優化：

1.  **實施計畫優先**: 每個非瑣碎任務都應先生成 `implementation_plan.md` 並要求 review。
2.  **建立自動化 Hooks**: 在 `.claude/settings.json` 中加入 `PostToolUse`，實現自動 Lint 與測試檢核。
3.  **路徑特定規則**: 已透過 `.claude/rules/` 實現前端與後端的行為區隔，這與 Claude Code 的最佳實踐高度一致。
4.  **代理團隊應用**: 針對複雜重構，啟用 `Agent Teams` 進行並行處理（已在 `CLAUDE_TEAMS.md` 中記錄）。

> [!NOTE]
> 這些資訊源自洩漏的內部提示詞，代表了 Anthropic 團隊對高效 AI 編程助理的最優設定考量。我們應儘可能對齊這些模式以獲得最佳協作效果。
