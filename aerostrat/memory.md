# AEROSTRAT Project Memory

> 這是 Claude Code 的跨 session 學習筆記。
> 前 200 行會在每次 session 開始時自動載入。
> 請定期清理過時條目。

---

## 核心慣例

- 後端在 /backend，前端在 /client，兩者完全分離
- 後端用 CommonJS（require），前端用 ES Modules（import）
- 套件管理統一用 npm，禁止用 pnpm 或 yarn
- 啟動系統用 start-backend.bat + start-frontend.bat（Windows 環境）

## 渲染慣例

- Canvas 繪圖一律用 ctx.save() / ctx.restore() 包裹
- 飛機圖示預設 North-Up，渲染時套 rotationOffset 校準
- SVG 圖示預先快取為 ImageBitmap，不在渲染迴圈重新解析

## 資料傳輸慣例

- WebSocket 訊息用 msgpack-lite 序列化，不用純 JSON
- OpenSky 用 5 組帳號輪詢，避免單一帳號 rate limit
- MongoDB 軌跡資料 TTL 48 小時，功能設計需考量此上限

## 安全慣例

- 所有金鑰存於 /backend/.env，禁止硬編碼
- .env 禁止 commit，參考 .env.example

---

## 待補充區域

> 當 Claude 在工作中學到新的專案慣例，會自動新增至此區塊。

<!-- 例：
- 2025-xx-xx：發現 MapView 元件的 props 命名用 camelCase
- 2025-xx-xx：後端 /api/flights 回傳格式改為分頁結構
-->

---

## 子主題引用

當記憶內容超過 150 行，請將細節移至子檔案並在此引用：

- 後端 API 模式：@memory/backend-patterns.md（待建立）
- 前端渲染技巧：@memory/frontend-patterns.md（待建立）
- 已知 Bug 追蹤：@memory/known-issues.md（待建立）
