# Local Codex Web App

在不修改 Codex 核心、也不自建歷史資料庫的前提下，把本機 Codex 能力透過安全、可遠端、可手機操作的 Web UI 呈現出來。

## 專案目標

1. 透過瀏覽器（桌機/手機）遠端操控本機 Codex（經 Gateway）。
2. 完整呈現 thread/turn timeline（使用者輸入、模型輸出、工具事件、狀態、錯誤）。
3. Approval 流程可視、可追溯、可 allow/deny。
4. 歷史與 session 以 Codex 本機機制為單一事實來源（SSOT）。

## 非目標

1. 不做 tmux/terminal 內嵌。
2. 不做自建聊天歷史資料庫（可索引/快取，但不可取代 SSOT）。
3. 不追求 IDE 等級編輯器（僅需 patch/diff 檢視能力）。

## 核心架構

```text
Web UI (Next.js)
    ⇅ SSE / HTTP API
Gateway (Node.js / TypeScript)
    ⇅ JSON-RPC over stdio
codex app-server (local)
    ⇅
~/.codex/history.jsonl + ~/.codex/sessions/   (SSOT)
```

## Monorepo 結構

```text
apps/
  gateway/        # Gateway: app-server subprocess 管理、協定橋接、事件補流、審計等
  web/            # Next.js App Router UI（desktop + mobile）
packages/
  shared-types/   # Web/Gateway 共用型別
scripts/
  dev.mjs         # 本機開發啟動腳本（同時啟 gateway + web，並注入預設 env）
AGENTS.md         # 產品邊界與協作規範（本專案最高優先協作文件）
```

## 環境需求

1. Node.js（建議 20+）
2. pnpm（專案使用 `pnpm@10.6.2`）
3. 本機可用的 Codex CLI / app-server 環境
4. 可選：Tailscale（遠端手機連線推薦）

## 快速開始

1. 安裝相依套件

```bash
pnpm install
```

2. 啟動開發環境（Gateway + Web）

```bash
pnpm dev
```

3. 開啟 UI

```text
http://localhost:3000
```

4. 若要確認 `dev` 寫入了哪些預設環境變數

```bash
LCWA_DEV_DRY_RUN=1 pnpm dev
```

## 常用指令

```bash
# 開發
pnpm dev
pnpm dev:gateway
pnpm dev:web

# 建置
pnpm build

# 品質檢查
pnpm lint
pnpm typecheck
pnpm test
pnpm test:unit
pnpm test:integration
pnpm test:coverage
pnpm test:e2e
pnpm check
```

## 測試與 check gate

`pnpm check` 會依序執行：

1. `pnpm lint`
2. `pnpm typecheck`
3. `pnpm test:coverage`
4. `pnpm test:e2e`

首次跑 e2e 若遇到 Playwright browser 不存在（`Executable doesn't exist`），先執行：

```bash
pnpm exec playwright install
```

## 開發常用環境變數（`scripts/dev.mjs`）

| 變數 | 預設值 | 說明 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Gateway bind host（dev 腳本預設，方便同網段手機測試） |
| `PORT` | `8787` | Gateway port |
| `WEB_PORT` | `3000` | Next.js port（也用來生成 CORS allowlist） |
| `LCWA_PUBLIC_HOST` | 自動偵測 | 優先指定公開可達主機位址（覆蓋自動選擇） |
| `NEXT_PUBLIC_GATEWAY_URL` | `http://<preferred-host>:8787` | 前端連線 Gateway URL |
| `CORS_ALLOWLIST` | 自動生成 | 包含 localhost/127.0.0.1 與可達 IPv4 清單 |
| `LCWA_DEV_DRY_RUN` | 無 | 設 `1` 時只輸出 env 計算結果，不實際啟動服務 |

## MVP API（目前設計目標）

1. `GET /api/threads`
2. `POST /api/threads`
3. `GET /api/threads/{id}`
4. `POST /api/threads/{id}/turns`
5. `GET /api/threads/{id}/events?since=...`
6. `POST /api/threads/{id}/approvals/{approval_id}`
7. `POST /api/threads/{id}/control`

## 安全基線

1. Gateway 為 app-server 唯一對接點，前端不可直連 app-server。
2. 遠端使用以 Tailscale 內網為主。
3. 必須具備 CORS allowlist、rate limit、request size limit。
4. 涉及 write/exec 的操作必須透過 approval 流程明確呈現與決策。
5. 生產基線是保守綁定；開發腳本的 `0.0.0.0` 屬本機測試便利設定。

## 開發路線圖

### Phase 1（MVP）

1. Gateway 啟動 app-server + SSE 事件串流 + thread/turn/approval 基礎映射。
2. UI：threads list、timeline、send turn、approval allow/deny。
3. history：啟動掃描 + 增量索引。
4. 手機完整操作與斷線重連補流。

### Phase 2（穩定與體驗）

1. 內層認證（device token）與 revoke。
2. 分頁、搜尋、標籤、fork/archive/export。
3. 風險分級與安全策略強化。

### Phase 3（產品化）

1. 多裝置/多使用者權限。
2. 完整審計與通知能力。

## 協作與提交規範

1. 以垂直切片開發：每次交付一條「完成即可使用」功能。
2. 每個切片完成前，需做桌機與手機 viewport 驗證。
3. 每個切片完成後建議立即 commit（Conventional Commits）。
4. 新功能需補 unit + integration；關鍵 UI 流程需補 e2e。
5. 任何偏離 `AGENTS.md` 的設計，需先在 PR/issue 說明原因。

---

若你要先從產品規格與架構約束開始，請先讀 `AGENTS.md`。
