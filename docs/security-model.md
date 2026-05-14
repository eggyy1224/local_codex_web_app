# Security model

Single source of truth for what the local Codex web app *currently* protects
against, what it *deliberately* does not, and what we plan to add in Phase 2.
AGENTS.md retains the canonical "what the product is"; this doc owns the
"what the safety boundary is".

## Threat model in one paragraph

The product is a **browser UI** that talks to a **Fastify gateway** that talks
to the local **`codex app-server`** child process. Everything runs on the
user's Mac. The threat we defend against is: another device or process on the
network reaching the gateway and impersonating the user. The threat we
explicitly do not defend against is: the user's Mac being compromised. If an
attacker is already on the Mac with the user's account, they have the codex
CLI and the rollout files directly — the gateway is not the weakest link.

## Network boundary

| Surface | Listens on | Reachable from |
| --- | --- | --- |
| Gateway HTTP/WS | `127.0.0.1:8795` (configurable via `HOST` / `PORT`) | anything that can route to that address |
| Web dev server | `127.0.0.1:3000` (Next.js) | same |
| Codex app-server | stdin/stdout of the gateway-spawned child | gateway only |

Two recommended deployment shapes:

1. **Local only** (default). `HOST=127.0.0.1`. Only the same Mac can reach
   the gateway. No additional auth needed.

2. **Tailscale-only remote** (mobile use). `HOST=0.0.0.0` *iff* the machine
   is reachable only over Tailscale. The Mac's firewall is expected to drop
   non-Tailscale inbound to 8795/3000. CORS narrows the browser-facing
   contract on top of the network layer.

We do **not** support raw public-internet exposure. Phase 2 device tokens
(below) are the unlock for that.

## CORS allowlist

The gateway sets `corsAllowlist` to the comma-separated `CORS_ALLOWLIST`
env var, defaulting to `WEB_ORIGIN` (default `http://127.0.0.1:3000`). The
checks are:

- HTTP routes (via `@fastify/cors`): reject when `Origin` is present and not
  in the allowlist.
- SSE (`GET /api/threads/:id/events`): mirrors the matching origin into the
  `Access-Control-Allow-Origin` header, falls back to allowlist[0] when no
  origin is set.
- Terminal WS (`GET /api/terminal/ws`): rejects with a `terminal/error`
  envelope (`TERMINAL_WS_ORIGIN_DENIED`) and a `terminal.origin_denied`
  audit row when `Origin` is set and not allowlisted.

The allowlist is a network-layer check, not authentication. Treat it as
"which origins should a same-network actor be allowed to phrase requests
from", not "who is the user".

## Approval-gated capabilities

Codex itself classifies turns by side-effect class. The gateway exposes the
contract surface and audits the decision:

- `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`
  produce pending `ApprovalProjection` rows. The UI presents Allow / Deny /
  Cancel, the route writes the decision to the app-server and an
  `approval.decided` audit row to SQLite.
- `tool/requestUserInput` produces a pending `InteractionProjection`. The
  same lifecycle, with `interaction.requested` / `interaction.responded`
  audits.
- The control-mode select (`local` / `auto` / `full-access`) maps to
  app-server `approvalPolicy` / `approvalsReviewer`. `full-access` lifts the
  per-action prompt; we audit that it was chosen but do not re-prompt.

The user is in control. The gateway does not auto-approve anything on its
own.

## Terminal dock boundary

The desktop terminal dock is a controlled remote-work surface. Mobile does
not get a terminal pane (AGENTS rule). The gateway hard-gates the dock with:

- `TERMINAL_DOCK_ENABLED` env / `terminalEnabled` config flag. When `false`,
  `TerminalManager` is not constructed and the WS responds with
  `TERMINAL_WS_DISABLED`. Audit row: `terminal.disabled`.
- Origin allowlist check before any session work happens. Audit row:
  `terminal.origin_denied`.
- Per-session audit lifecycle: `terminal.opened`, `terminal.closed`
  (`reason: client_message | socket_closed | reopened`), `terminal.open_failed`
  (with `stage: resolveContext | openClient`), `terminal.session_ended`
  (`reason: exit | expired | evicted | destroyed`) when the manager kills a
  session out-of-band.
- Sessions are pinned to a thread's `cwd`. The shell is spawned with the
  user's environment, no special escalation.

If the dock is off (`TERMINAL_DOCK_ENABLED=false`), there is no PTY
spawned anywhere in the process tree.

## Audit log

Every state-changing decision the gateway makes is written to
`audit_log` in `~/.codex-web-gateway/index.db`. Schema is
`{ ts, actor, action, threadId, turnId, metadata }`. Actions cover:

- `approval.requested`, `approval.decided`
- `interaction.requested`, `interaction.responded`, `interaction.cancelled`
- `terminal.disabled`, `terminal.origin_denied`, `terminal.opened`,
  `terminal.closed`, `terminal.session_ended`, `terminal.open_failed`

Audit is local-only; no remote shipping. Use `sqlite3 ~/.codex-web-gateway/index.db`
to inspect.

## What we do NOT do

These are explicit non-goals for the current shape:

- **No end-to-end encryption of the browser↔gateway channel.** Loopback +
  Tailscale carries the trust; the gateway does not negotiate keys.
- **No device-level authentication.** Anyone reachable inside the
  trust boundary (loopback or Tailscale) is the user. There is no
  per-device token, no per-session pairing, no revoke.
- **No internet exposure path.** We do not provide a hosted relay. Self-host
  the Mac on Tailscale or behind your own VPN if you want phone access.
- **No mobile terminal.** Mobile keeps thread / prompt / approval / plan /
  auto-mode flows. Shell is desktop only.
- **No automatic destructive action.** Approvals stay user-driven.
- **No private credentials in this repo.** Anything site-specific (API keys,
  custom system prompts, private allowlists) belongs in environment files
  outside the repo tree.

## Phase 2 — device pairing (planned, not built)

The piece worth adding next, modeled on the remodex bridge:

- One-time browser pairing via a short code shown in the Mac CLI.
- Mac stores `{ deviceId, publicKey, label, lastSeenAt }`.
- Browser stores its trusted gateway in `localStorage` keyed on origin.
- Gateway issues a session token after a successful pair, scoped by
  device id. Revoke is a single delete from the device table.
- All non-pairing routes gate on `Authorization: Bearer <token>` once a
  device is paired. The token never leaves the Mac except over the
  already-allowlisted origin.

This is **not implemented**. Until it lands, Tailscale ACL + CORS +
loopback default are the only boundary.

## Quick checklist for adding a new surface

When you add a new route, WS, or persisted state, work through:

1. Does the request mutate state on the Mac (run a command, edit a file,
   change config)? → Needs an approval projection and audit row.
2. Does it expose data the user did not put on screen? → Confirm the
   handler reads from the active thread's `cwd` and rejects out-of-scope
   paths.
3. Does it create a new socket? → Origin allowlist check at the upgrade
   point, audit `*.origin_denied`.
4. Is it gated by a feature flag? → Default to OFF in env config, document
   the flag here.
5. Is the failure mode observable? → Add a counter to
   `GET /api/gateway/status` if it is the kind of state an operator would
   ask about.
