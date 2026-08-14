# Dynatrace MCP Server — VS Code setup

This repo already includes `.vscode/mcp.json` that registers the official
**Dynatrace MCP Server** for VS Code. Once you supply a Platform Token (see
below) and reload VS Code, the AI assistant (Copilot Chat, Claude Code, etc.)
will get a set of tools for problems, metrics, logs, traces, entities, etc.

> ⚠️ The `dynatrace-oss/dynatrace-mcp` repo is now **deprecated** (final
> release `v2.1.2`, July 2025). It still works. Recommended alternatives:
>
> - **Local dev (this project)**: [Dynatrace-for-AI](https://github.com/Dynatrace/dynatrace-for-ai/) + [`dtctl`](https://github.com/Dynatrace/dynatrace-mcp)
> - **Remote (zero setup)**: [Dynatrace Remote MCP Server](https://www.dynatrace.com/hub/detail/dynatrace-mcp-server/)

This guide keeps using the deprecated package because it is the only one
that matches the **Node.js version on this machine (`v22.19.0`)** — the
latest `v2.x` requires Node 24+.

## What's installed

| Path              | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `.vscode/mcp.json`| VS Code MCP server registration (stdio, `npx -y …@1.8.7`)|
| `MCP_SETUP.md`    | This file                                                |

No `npm install` is needed — VS Code (via `npx -y …@1.8.7`) downloads the
package on first launch and caches it.

## 1. Get a Dynatrace Platform Token

The MCP server uses Dynatrace **Platform** APIs (`*.apps.dynatrace.com`),
not classic cluster APIs (`*.live.dynatrace.com`). It therefore needs a
**Bearer token** (Platform Token / OAuth client), NOT a classic Api-Token.

The token currently in `.env` (`dt0c01…`) is an **Api-Token** and will NOT
work — Dynatrace returns `401 Could not parse JWT`.

Create one of:

### Option A — Platform Token (recommended)

1. In Dynatrace: **Account Settings → Personal Information → Personal tokens**
   (or in SaaS: **Account → Identity & access → OAuth clients**).
2. Create a new token with **at least** these scopes:

   ```
   app-engine:apps:run          (mandatory)
   read:problems                (problems/details API)
   storage:logs:read            (logs DQL)
   storage:metrics:read         (metrics DQL)
   storage:spans:read           (traces/spans DQL)  ← needed for tracing questions
   storage:bizevents:read       (Davis, bizevents)
   storage:events:read
   storage:entities:read
   hub:catalog:read
   ```

   While testing you can grant `hub:admin` and narrow down later.

3. Copy the token (a long JWT starting with `eyJ…`).

### Option B — OAuth client credentials

1. Create an OAuth client (Account → Identity & access → OAuth clients).
2. Add `DT_CLIENT_ID`, `DT_CLIENT_SECRET`, `DT_RESOURCE` to the `env` in
## 2. Open the project in VS Code

```powershell
code C:\Users\User\Desktop\app\demo1\demo1-1
```

VS Code reads `.vscode/mcp.json` automatically. On first run the MCP server
is started in the background; because the config uses
`${input:dynatracePlatformToken}` you will be prompted for the token once
and VS Code remembers it in the OS keychain.

## 3. Verify

In VS Code:

1. **Command Palette → `MCP: List Servers`** — `dynatrace` should show
   status **Running** with `n` tools available.
2. Click on it → **Start** if not started.
3. In Copilot Chat (agent mode), ask:
   - *"List the open problems in this Dynatrace tenant."*
   - *"What was the slowest trace in the last hour?"*
   - *"Show me logs with `error` from service X."*

You should see MCP tool calls appear in the conversation
(`get-problems`, `get-traces`, `execute-dql`, …).

## 4. Manual smoke test (no VS Code)

```powershell
$env:DT_ENVIRONMENT      = "https://waa41263.apps.dynatrace.com"
$env:DT_PLATFORM_TOKEN   = "<paste token>"
$env:DT_MCP_DISABLE_TELEMETRY = "true"
npx -y @dynatrace-oss/dynatrace-mcp-server@1.8.7 --help
```

Expected startup banner:

```
Initializing Dynatrace MCP Server v1.8.7...
Dynatrace Telemetry initialization failed: Dynatrace Telemetry is disabled ...
Testing connection to Dynatrace environment: https://waa41263.apps.dynatrace.com...
Using Platform Token to authenticate API Calls to https://waa41263.apps.dynatrace.com
```

If authentication fails you'll see `401 Unauthorized` from
`/platform/management/v1/environment` — check the token scopes.

## 5. Troubleshooting

| Symptom                                                       | Fix                                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `401 Unsupported authorization scheme 'Api-Token'`            | You're using a classic Api-Token. Switch to a Platform Token (Bearer JWT).                                     |
| `401 Could not parse JWT`                                     | Token is malformed/expired.                                                                                    |
| `403 forbidden by administrative rules`                       | Tenant blocks storage APIs. Ask your admin to enable Grail access, or use Remote MCP.                         |
| `npm warn deprecated @dynatrace-oss/dynatrace-mcp-server@1.8.7` | Expected — see deprecation notice at top of file.                                                            |
| `EACCES` / `EPERM` on first run                                | VS Code's bundled Node may be sandboxed. Run the smoke test manually first to warm `npx` cache.                |
| Server won't start because Node 24 required                    | `v2.x` of this package requires Node 24. We pin `1.8.7` (Node ≥22.10) — confirm `node --version`.               |

## 6. Removing the integration

Just delete `.vscode/mcp.json` and reload VS Code. The downloaded package
in `~/.npm/_npx/` will be re-used by other projects but is harmless.
   `.vscode/mcp.json` and remove `DT_PLATFORM_TOKEN`.