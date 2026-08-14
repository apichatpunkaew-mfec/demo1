# Dynatrace MCP Server — VS Code setup

This repo ships `.vscode/mcp.json` registering the **Dynatrace MCP Server**
(`@dynatrace-oss/dynatrace-mcp-server@1.8.7`) for VS Code. After VS Code
reads the config and you paste the OAuth client secret at the first-launch
prompt, the AI assistant (Copilot Chat, Claude Code, etc.) gets a set of
tools for **traces, metrics, logs, entities, DQL**, etc.

> ⚠️ `dynatrace-oss/dynatrace-mcp` is in **maintenance mode** (final release
> `v2.1.2`, July 2025). Alternatives for new projects:
>
> - **Local dev (this project)**: [`Dynatrace-for-AI`](https://github.com/Dynatrace/dynatrace-for-ai/) + [`dtctl`](https://github.com/Dynatrace/dynatrace-mcp)
> - **Remote (zero setup)**: [Dynatrace Remote MCP Server](https://www.dynatrace.com/hub/detail/dynatrace-mcp-server/)
>
> We pin `v1.8.7` here because it needs Node ≥22.10 (this machine has
> `v22.19.0` ✅); `v2.x` requires Node 24+.

## What's installed

| Path              | Purpose                                                  |
| ----------------- | -------------------------------------------------------- |
| `.vscode/mcp.json`| VS Code MCP registration (stdio, `npx -y …@1.8.7`, **OAuth client-credentials**) |
| `MCP_SETUP.md`    | This file                                                |

No `npm install` is needed — VS Code pulls the package on first launch
via `npx -y`.

## 1. Authentication choice — OAuth Client Credentials

The MCP server hits Dynatrace **Platform APIs** (`*.apps.dynatrace.com`),
not classic cluster APIs (`*.live.dynatrace.com`). Two auth options:

| Method                  | What goes in mcp.json                                       | Notes                                                                 |
| ----------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------- |
| **Platform Token**      | `DT_PLATFORM_TOKEN=<long JWT starting with eyJ…>`           | Easiest, single static secret.                                        |
| **OAuth Client Creds** ✅| `OAUTH_CLIENT_ID=dt0s02.xxxxx` + `OAUTH_CLIENT_SECRET=…`    | Short-lived JWT auto-refreshed every 5 min; secret never expires.     |

This project uses **OAuth** because an OAuth client was already
provisioned (`OAUTH_CLIENT_ID=dt0s02.GANJVRPD`). The **secret** is stored
only in VS Code's keychain via the `promptString` input — it is **never
written to a tracked file**.

### Scopes granted to this OAuth client

Direct probe (`grant_type=client_credentials`, no scope requested) returns
**214 scopes** (admin-level). Key ones for MCP usage:

```
✅  app-engine:apps:run           (required for any MCP call)
✅  storage:spans:read            (TRACES — answers "which trace is slowest")
✅  storage:logs:read             (logs DQL)
✅  storage:metrics:read          (metrics DQL)
✅  storage:entities:read         (entities)
✅  storage:events:read
✅  storage:bizevents:read
✅  hub:catalog:read
✅  environment-api:problems:read
❌  read:problems                 (legacy problems scope — NOT granted)
```

> ⚠️ **Known limitation:** the MCP server's `get-problems` tool requests
> the legacy scope `read:problems`, which **this OAuth client does NOT
> have** (it only has `environment-api:problems:read`). That tool will
> fail with `400 Bad Request` until either the OAuth client's allowed
> scopes are updated, or the upstream MCP server is fixed.
>
> For everything else — **DQL against spans, logs, metrics, entities,
## 2. Open the project in VS Code

```powershell
code C:\Users\User\Desktop\app\demo1\demo1-1
```

VS Code reads `.vscode/mcp.json` automatically. On first run the MCP
server is started in the background; because the config uses
`${input:dynatraceOAuthClientSecret}`, **VS Code prompts for the secret
once** and stores it in the OS keychain.

The expected startup banner (verified locally):

```
Initializing Dynatrace MCP Server v1.8.7...
Dynatrace Telemetry initialization failed: Dynatrace Telemetry is disabled via DT_MCP_DISABLE_TELEMETRY=true
Testing connection to Dynatrace environment: https://waa41263.apps.dynatrace.com...
🔒 Client-Creds-Flow: Trying to authenticate API Calls ... via OAuthClientId dt0s02.GANJVRPD ...
Using SSO URL from DT_SSO_URL environment variable: https://sso.dynatrace.com
Successfully retrieved token from SSO! Token valid for 300s with scopes: app-engine:apps:run
✅ Successfully connected to the Dynatrace environment at https://waa41263.apps.dynatrace.com.
Dynatrace MCP Server running on stdio
```

## 3. Verify in Copilot Chat

In VS Code:

1. **Command Palette → `MCP: List Servers`** — `dynatrace` should show
   status **Running** with ~50 tools.
2. In **Copilot Chat** (agent mode), ask:
   - *"What was the slowest trace in the last hour?"*
     → MCP uses `execute-dql` to run
     `fetch spans, from:now()-1h | sort duration desc | limit 10`
   - *"Show me logs with `error` from service X."*
   - *"List the entities of type service."*

You should see MCP tool calls appear inline in the chat.

## 4. Manual smoke test (no VS Code)

```powershell
# Use full path to npx because node/npx are not in the system PATH by default:
$nodeDir = "C:\Users\User\AppData\Local\Temp\node\node-v22.19.0-win-x64"
$env:PATH = $nodeDir + ";" + $env:PATH

$env:DT_ENVIRONMENT      = "https://waa41263.apps.dynatrace.com"
$env:DT_SSO_URL          = "https://sso.dynatrace.com"
$env:OAUTH_CLIENT_ID     = "dt0s02.GANJVRPD"
$env:OAUTH_CLIENT_SECRET = "<paste secret>"
$env:DT_MCP_DISABLE_TELEMETRY = "true"

& "$nodeDir\npx.cmd" -y @dynatrace-oss/dynatrace-mcp-server@1.8.7 --help
```

Look for the `✅ Successfully connected` banner above.

## 5. Troubleshooting

| Symptom                                                       | Fix                                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `401 Unsupported authorization scheme 'Api-Token'`            | Classic Api-Token won't work. Use a Platform Token (Bearer JWT) **or** OAuth client credentials.                |
| `400 invalid_request` from `sso.dynatrace.com`                | OAuth client lacks one of the requested scopes. Run a no-scope token request and grep the returned scope list. |
| `400 Bad Request` from `get-problems`                         | This OAuth client lacks `read:problems`. See scope warning above.                                               |
| `403 forbidden by administrative rules`                       | Tenant blocks storage APIs. Ask admin to enable Grail access, or use Remote MCP.                               |
| `npm warn deprecated @dynatrace-oss/dynatrace-mcp-server@1.8.7` | Expected — see deprecation notice at top of file.                                                            |
| `"node" is not recognized`                                    | VS Code / shell PATH missing the node binary. This machine has it under `C:\Users\User\AppData\Local\Temp\node\node-v22.19.0-win-x64` — prefix the launch with `$env:PATH = $nodeDir + ";" + $env:PATH`. |
| Server won't start because Node 24 required                   | `v2.x` of this package requires Node 24. We pin `1.8.7` (Node ≥22.10) — confirm `node --version`.              |

## 6. Rotating the OAuth client secret

Because the OAuth client secret is currently **exposed in the chat history
and several test scripts on this machine**:

1. In Dynatrace → **Account → Identity & access → OAuth clients**,
   regenerate the secret for `dt0s02.GANJVRPD`.
2. VS Code will keep the old secret in its keychain. To re-prompt:
   - **Command Palette → `MCP: List Servers`** → click `dynatrace` →
     **Reset stored inputs** (or delete the entry from
     `Credential Manager` → `VSCode MCP Secrets`).
3. Restart VS Code. The MCP server will prompt again for the new secret.

## 7. Removing the integration

Just delete `.vscode/mcp.json` and reload VS Code. The downloaded package
in `~/.npm/_npx/` is harmless and will be reused by other projects.
> events** — works out of the box. This is exactly what's needed to
> answer the original "which trace is the slowest" question.