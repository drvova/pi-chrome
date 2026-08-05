# pi-chrome

> Let [Pi](https://pi.dev) use your existing signed-in Chrome profile through 30 tools — browser automation, emulation, cookies, downloads, history, and more.

**MIT · 0 runtime deps · loopback-only bridge · bridge-token authenticated · inspectable unpacked Chrome extension.**

```text
You:    "Find my open GitHub PR tab, summarize review state, and screenshot failing CI."
Agent:  chrome_tab(list) → chrome_snapshot(uid:…) → chrome_screenshot(...)
        ✓ 3 reviewers, 1 change requested, CI red on iOS. Saved → .pi/chrome-screenshots/ci.png
You:    [keeps coding — agent never asked you to log in]
```

`pi-chrome` runs through a small Chrome extension inside the Chrome profile **you already use** — including sites where you're already signed in. Agents can inspect or control Chrome only after you run `/chrome authorize` in the current Pi session.

---

## Install

```bash
pi install git:https://github.com/drvova/pi-chrome
```

In Pi:

```text
/chrome onboard
```

This opens `chrome://extensions` and copies the bundled extension path to your clipboard. In Chrome Extensions:

1. Turn on **Developer mode** (top-right toggle).
2. Click **Load unpacked**.
3. Paste the copied path.
4. Press Enter.

Reload Pi so the installed package loads:

```text
/reload
```

Check bridge health:

```text
/chrome doctor
```

You should see:

```text
✓ Chrome is connected (...)
```

Authorize the current session:

```text
/chrome authorize
/chrome doctor
```

Second doctor run should show all checks passing.

### WSL2

On WSL2, pi-chrome auto-detects the environment and binds `0.0.0.0` for Windows localhost forwarding. Onboard converts paths to Windows format via `wslpath`, opens Chrome/Explorer via `cmd.exe`, and copies the Windows path to clipboard. No extra setup needed — just run `/chrome onboard`.

---

## What it can do

30 tools across 7 categories:

**Page interaction** — Click, type, fill, scroll, drag, tap, upload files. Real Chrome input layer via CDP — satisfies user-activation gates and bypasses page CSP.

**Observation** — Snapshot the page with element uids, read rendered text, find elements by natural-language query, inspect element context, capture screenshots, evaluate JavaScript in MAIN world.

**Tab/window management** — List, open, close, activate, and group tabs without taking over the user's active window. Each Pi session gets its own dedicated automation target.

**Network and console** — Capture console messages and network requests/responses. Override user-agent, clear browser cache, clear cookies for the current tab.

**Emulation** — Override viewport (mobile device metrics), geolocation, timezone, and CPU throttle rate. Reset all overrides with a single call.

**Browser state** — Read, set, and remove cookies across all domains. Download files by URL. Search and delete browsing history. List recently closed tabs/windows.

**Identity** — Get Google OAuth2 access tokens using the user's Chrome identity for API access.

Tool parameters and gotchas are documented inline in Pi. A built-in skill (`/skill pi-chrome`) provides Q&A-style tool routing.

---

## Commands

```text
/chrome onboard             # guided setup
/chrome doctor              # full health check (connectivity, version, eval, WSL2 diagnostics)
/chrome status              # one-line connection + auth + background snapshot
/chrome authorize [duration] # unlock Chrome control (15m default, or 30m, indefinite)
/chrome revoke              # lock Chrome control again
/chrome background on       # default: run silently without stealing focus
/chrome background off      # foreground/watch mode
```

---

## Safety model

Chrome control is locked by default. Authorize per Pi session:

```text
/chrome authorize          # 15 minutes (default)
/chrome authorize 30m      # custom duration
/chrome authorize indefinite
/chrome revoke             # lock again
```

Safety properties:

- Extension runs in your real Chrome profile with broad permissions. Install only from trusted source.
- Bridge binds to loopback only (`127.0.0.1` on macOS/Linux, `0.0.0.0` on WSL2 for Windows forwarding). No network exposure.
- Bridge token authentication — every companion-extension request carries an HMAC token; forged requests are rejected.
- Browser-origin requests are rejected so ordinary web pages cannot drive Chrome through CORS.
- Each Pi session gets its own automation target; user tabs/windows are never closed by cleanup.
- `/chrome revoke` closes only the calling session's automation target.

Security details: [`SECURITY.md`](./SECURITY.md). Architecture details: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

---

## Tool reference

| Category | Tools |
|---|---|
| **Page** | `chrome_snapshot`, `chrome_read`, `chrome_find`, `chrome_inspect`, `chrome_navigate`, `chrome_evaluate`, `chrome_wait_for`, `chrome_screenshot` |
| **Input** | `chrome_click`, `chrome_type`, `chrome_fill`, `chrome_key`, `chrome_hover`, `chrome_drag`, `chrome_tap`, `chrome_scroll`, `chrome_upload_file` |
| **Tabs** | `chrome_tab`, `chrome_launch` |
| **Console/Net** | `chrome_list_console_messages`, `chrome_list_network_requests`, `chrome_get_network_request` |
| **Emulation** | `chrome_emulate` (device, geolocation, timezone, CPU, clear) |
| **Network** | `chrome_network` (user-agent, clear cache, clear cookies) |
| **Cookies** | `chrome_cookies` (get, set, remove) |
| **Browser** | `chrome_downloads`, `chrome_history`, `chrome_sessions` |
| **Auth** | `chrome_identity` (Google OAuth2) |
| **Diagnostics** | `chrome_status` (no auth required) |

---

## Limits

`pi-chrome` works best on web-page workflows exposed through DOM, screenshots, tabs, network, console, and Chrome input. It is not full OS automation.

Current limits include native Chrome/OS surfaces, print/save dialogs, permission bubbles, password-manager prompts, cross-origin iframe DOM access, CAPTCHA/bot challenges, passkeys/security keys/biometrics, rich multitouch/pinch/stylus gestures, and arbitrary desktop apps.

---

## Docs

- Architecture: [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md)
- Examples: [`docs/EXAMPLES.md`](./docs/EXAMPLES.md)
- FAQ: [`docs/FAQ.md`](./docs/FAQ.md)
- Comparison: [`docs/COMPARISON.md`](./docs/COMPARISON.md)
- Security: [`SECURITY.md`](./SECURITY.md)
- Changelog: [`CHANGELOG.md`](./CHANGELOG.md)
- Benchmark suite: [`test-suite/README.md`](./test-suite/README.md)

---

## License

MIT. See [LICENSE](./LICENSE).
