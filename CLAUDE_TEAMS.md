# 👥 Claude Code Agent Teams (實驗性功能)

本文件說明如何在 AEROSTRAT 專案中啟用並使用 Claude Code 的「Agent Teams (代理團隊)」功能。這個功能讓你同時協調多個 Claude 實例，分別處理前端、後端或測試任務。

## ⚙️ 啟用方式 (已完成)

我們已經在 `~/.claude/settings.json` 中配置了以下環境變數：
```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

## 🚀 如何啟動團隊

你可以直接用自然語言告訴 Claude 你的目標，它會自動分配任務。

### 範例指令 1：全疊開發 (Fullstack)
> 「啟動一個專案團隊：一位負責研究 `backend/crawler.js` 的穩定性，一位負責優化 `client/src/MapView.jsx` 的效能，並讓第三位成員編寫這兩部分的整合測試規則。」

### 範例指令 2：並行除錯 (Parallel Debugging)
> 「目前地圖上的飛機軌跡偶爾會閃爍。啟動一個 2 人的除錯團隊：一位追蹤 WebSocket 的資料推送 (`server.js`)，另一位檢查前端的資料更新邏輯 (`dataManager.js`)。」

## 💻 在 Windows 上的操作技巧

由於 Windows 預設不支持分割窗格 (Split Panes)，團隊將以 **In-Process** 模式運行。

- **切換成員**：按下 `Shift + Down` 可以在不同的成員視窗中切換。
- **共享清單**：輸入 `/task` 可以查看團隊目前的所有任務狀態。
- **任務認領**：成員會自動認領任務，你也可以指定「請成員 A 負責 X」。

## ⚠️ 注意事項

- **Token 消耗**：Agent Teams 會同時開啟多個 Context，消耗量會比單一會話快得多，請密切監控 `claude-monitor`。
- **檔案衝突**：盡量讓不同的成員負責不同的檔案路徑，避免發生寫入衝突。
- **清理團隊**：任務完成後，請記得輸入 `Clean up the team` 來釋放資源。

---
*更多詳細資訊可參考 [Claude Code 擴展指南](https://code.claude.com/docs/agent-teams)*
