# AGENTS.md

本文件定義此專案的產品邊界、技術決策與協作規則。所有代理（agents）在此專案中工作時，必須遵守以下內容。

## 1. 專案定位

一句話：在不改 Codex 核心、不自建歷史資料庫的前提下，把 Codex 本機能力透過安全、可遠端、可手機操作的 Web UI 呈現出來。

## 2. 必要目標（Must）

1. 可從瀏覽器（桌機/手機）遠端操控本機 Codex（經由 gateway）。
2. 完整呈現 thread/turn timeline（使用者輸入、模型輸出、工具事件、狀態、錯誤）。
3. Approval 流程可視且可控（allow/deny 可追溯）。
4. 歷史與 session 以 Codex 本機機制為單一事實來源（SSOT）。

## 3. 非目標（Non-goals）

1. 不做 tmux/terminal 內嵌。
2. 不做自建聊天歷史資料庫（可做索引/快取，但不可取代 SSOT）。
3. 不追求 IDE 等級編輯器（僅需 patch/diff 檢視能力）。

## 4. 架構硬性決策

1. `codex app-server` 一律優先使用 `stdio`（JSONL-over-stdio）。
2. `--listen ws://...` 屬 experimental，不作為 production 基礎。
3. Gateway 是唯一對接 app-server 的元件；前端不可直接連 app-server。
4. 前端即時更新以事件串流為核心，MVP 固定使用 SSE。
5. 技術棧固定為 TypeScript Fullstack（Gateway: Node.js；Web: Next.js App Router）。
6. 不改 Codex 核心邏輯與資料格式。

## 5. 系統元件職責

### 5.1 Codex app-server（本機）

1. 提供 JSON-RPC 協定、thread/turn/event/approval/auth 等能力。
2. 提供既有 session/history 機制（SSOT）。

### 5.2 Gateway（本專案核心）

1. 管理 app-server subprocess（啟動/重啟/健康狀態）。
2. 協定橋接（stdio JSON-RPC <-> 前端 API/事件串流）。
3. 限流、審計、錯誤追蹤與事件補流。
4. 本機 session/history 的唯讀索引（列表/搜尋/摘要）。
5. 認證授權/裝置管理在 Phase 2 導入（MVP 先依賴 Tailscale ACL）。

### 5.3 Web UI

1. Threads 列表、搜尋、篩選。
2. Timeline 視覺化（turn 分段 + event streaming）。
3. Approval 互動（allow/deny）。
4. 控制操作（stop/retry/cancel/fork/export 視能力映射）。

## 6. 狀態模型（概念）

1. Thread/Session：持續工作脈絡。
2. Turn：一次輸入觸發的工作單元。
3. Event Stream：輸出與狀態變更的串流。
4. Approval Request：等待使用者決策的節點。

## 7. 安全基線（Must）

1. Gateway 預設只綁定 `127.0.0.1`。
2. 遠端使用以 Tailscale 內網為主（可選 VPN/SSH port-forward）。
3. 可選綁定 Tailscale IP，但必須顯式設定，不可作為預設值。
4. MVP 可不做內層登入/token；Phase 2 必須補上裝置 token 與 revoke。
5. 必須有 CORS allowlist、rate limit 與 request size 限制。
6. 涉及 write/exec 的操作需清楚顯示並經 approval。

## 8. 歷史與儲存原則

1. 歷史來源為本機 Codex session/history（例如 `~/.codex/history.jsonl`、`~/.codex/sessions/`）。
2. Gateway 只能做索引與快取，不得主導歷史真相。
3. 索引快取採 SQLite，預設路徑 `~/.codex-web-gateway/`。
4. 匯出可做；匯入沿用 Codex 既有機制，不定義自製格式。

## 9. 最小 API 目標（MVP）

1. `GET /threads`
2. `POST /threads`
3. `GET /threads/{id}`
4. `POST /threads/{id}/turns`
5. `GET /threads/{id}/events?since=...`
6. `POST /threads/{id}/approvals/{approval_id}`
7. `POST /threads/{id}/control`

## 10. 開發順序（分期）

### Phase 1（MVP）

1. Gateway 啟動 app-server + 事件串流（SSE）+ thread/turn/approval 基礎映射。
2. UI：threads list、timeline、send turn、approval allow/deny。
3. history：啟動掃描 + 增量索引。
4. 支援手機完整操作（看/送/批）與斷線重連補流。

### Phase 2（穩定與體驗）

1. 內層認證（device token）與裝置 revoke。
2. 分頁、搜尋、標籤、fork/archive/export。
3. 強化風險分級與安全策略。

### Phase 3（產品化）

1. 多裝置/多使用者權限。
2. 完整審計與通知能力。

## 11. 工程協作規範

1. 開發模式固定為垂直切片：每次只做一條「完成即可使用」的功能。
2. 每個切片完成前，必須用 CDP MCP 做桌機與手機 viewport 驗證。
3. 每個切片完成後立刻 commit（每切片 1 commit）。
4. commit 規範固定使用 Conventional Commits。
5. push 策略：先本機 commit，不強制每片立即 push。
6. 任何偏離本文件的設計，必須先在 PR/issue 說明原因。
7. 文件與介面命名盡量一致（thread/turn/event/approval）。
8. 實作 app-server 相關能力時，必須優先參考官方 OpenAI/Codex 文件（openai-docs skill）。
9. 本專案溝通預設使用繁體中文。
