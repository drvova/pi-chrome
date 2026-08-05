# Security policy

## Reporting a vulnerability

Open a GitHub issue prefixed with `[security]` at https://github.com/drvova/pi-chrome/issues, or contact the maintainer directly if the issue is sensitive. Please do **not** include exploit details in a public issue without coordinating first.

## Threat model

`pi-chrome` is a developer tool you install knowingly. It is **not** designed to defend against:

- Hostile pages running in your Chrome trying to detect or escape automation. (Standard browser security boundaries still apply, but a hostile page that already runs in your tab can do anything that page can already do.)
- Other processes on your local machine. The bridge binds to loopback (`127.0.0.1:17318` on macOS/Linux, `0.0.0.0:17318` on WSL2 for Windows localhost forwarding), requires a per-process bridge token from the companion extension, and chrome_* tools require `/chrome authorize` inside Pi. If your threat model includes hostile local processes running as your user, run pi-chrome on a separate user account.

`pi-chrome` **is** designed to:

- Never exfiltrate page state to the network. All communication is loopback.
- Surface every action with an honest result envelope so the agent can't silently do the wrong thing.
- Keep Chrome control locked until the user explicitly runs `/chrome authorize` in the current Pi session.
- Reject browser-origin command requests to the loopback bridge so ordinary web pages cannot use CORS to drive Chrome.
- Authenticate every companion-extension result post with a bridge-specific HMAC token. The bridge generates a random `crypto.randomUUID()` token at startup and serves it in the `x-pi-chrome-token` response header on every `/next` poll. The companion extension stores it and includes it on every `/result` post. A 403 response triggers a token refresh and retry.

## The companion extension

The Chrome extension under `extensions/chrome-profile-bridge/browser-extension/` runs with broad permissions: `tabs`, `tabGroups`, `scripting`, `storage`, `activeTab`, `alarms`, `webNavigation`, `debugger`, `cookies`, `identity`, `downloads`, `history`, `sessions`. **Only install it from a package source you trust.** Read the source before loading. Pin a known-good commit if you're security-sensitive.

## Defaults

- Loopback bridge only (macOS/Linux: `127.0.0.1`; WSL2: `0.0.0.0` for Windows localhost forwarding — WSL2 NAT does not expose the port to the LAN without explicit `netsh portproxy` setup). No remote port. No telemetry.
- Bridge token authentication on every companion-extension request.
- Chrome real input layer for interactive controls.
- Chrome control locked by default; `/chrome authorize` unlocks current Pi session after terminal confirmation, `/chrome revoke` locks it again.
- Run-in-background optional; tab/window focus is observable by default (the user can see Pi acting).

## Custom ports

Override the bridge host/port via `PI_CHROME_BRIDGE_HOST` and `PI_CHROME_BRIDGE_PORT` environment variables before starting Pi. The bundled Chrome extension polls `127.0.0.1:17318` by default; if you change the port you must edit `BRIDGE_URL` in the extension's `service_worker.js` and reload it.

## WSL2

On WSL2, the bridge auto-detects the environment via `/proc/version` and binds `0.0.0.0` instead of `127.0.0.1`. This is necessary because WSL2's NAT-mode `127.0.0.1` is the Linux VM's loopback, unreachable from Windows Chrome. The `0.0.0.0` bind is safe: WSL2 NAT does not forward ports to the host network without explicit `netsh interface portproxy` configuration, and the bridge token blocks forged requests.

## Supported versions

The latest minor is supported. Security patches will be released as soon as practical.
