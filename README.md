# pi-chrome

> **Let [Pi](https://pi.dev) use your existing signed-in Chrome profile after explicit authorization.**

**MIT · 0 runtime deps · loopback-only bridge (`127.0.0.1:17318`) · inspect [`extensions/chrome-profile-bridge/browser-extension/`](./extensions/chrome-profile-bridge/browser-extension) before loading.** Verify connectivity in one command: `/chrome doctor`.

```text
You:    "Find my open GitHub PR tab, summarize review state, and screenshot the failing CI."
Agent:  chrome_tab(list) → chrome_snapshot(uid:…) → chrome_screenshot(...)
        ✓ 3 reviewers, 1 change requested, CI red on iOS. Saved → .pi/chrome-screenshots/ci.png
You:    [keeps coding — agent never asked you to log in]
```

`pi-chrome` is backed by a small MIT-licensed Chrome extension that runs inside the Chrome profile **you already use** — including every site you're already signed into. Agents can inspect or control Chrome only after you run `/chrome authorize` in the current Pi session.

---

## 60-second install instruction

To install pi-chrome, run the following command:

```bash
pi install npm:pi-chrome
```


Then in Pi, run the next command, which will:

1. Reveal the bundled browser-extension folder in Finder, and copy the folder path to your clipboard.
2. Pop open the chrome://extensions webpage in Chrome.

In the Chrome Extensions page it opened, **YOU WILL NEED TO**:

1. Turn on **developer mode** (top right).
2. Click the **load unpacked** button (top left).
3. Use **Cmd + Shift + G** (Mac) or **Ctrl + L** (Windows/Linux) to open the folder path field.
4. **Cmd + V** (Mac) or **Ctrl + V** (Windows/Linux) to paste the copied path and press Enter.
5. You're done with the chrome extensions page, and you can continue with the rest of the installation commands 

```text
/chrome onboard
```

Reload Pi so the newly installed package is actually loaded:

```text
/reload
```   
                                                    

Verify the chrome connection:

```text
/chrome doctor
```
In the output, you just need to make sure the following line is present (It's okay if the other ones are still not checked):

 ✓ Chrome is connected (companion extension v0.15.36, responded in 11ms). 

Lastly, authorize the current session by running:
```text
/chrome authorize
```

Run the following once more, and you should see all the lines checked:

```text
/chrome doctor
```
---

## Try this in 30 seconds after install

```text
Look at my GitHub notifications tab and triage which PRs
need my review today, sorted by staleness.
Don't click anything yet — just read and summarize.
```

You'll watch the agent jump to your GitHub tab and read the page — using **your** session, **your** filters, **your** orgs.

---

## Killer recipes (copy-paste into Pi)

Each recipe assumes the relevant tab is already open in the Chrome you control.

**PR triage**

```text
You:    "Look at my GitHub notifications tab and summarize the PRs needing my review today, sorted by staleness."
Agent:  chrome_tab(list) → chrome_snapshot(uid:el-notifications) → chrome_evaluate(...)
        ✓ 7 PRs waiting on you. 2 stale >3d (storage-rewrite, billing-v2).
          1 just turned CI-green (api-keys-prune). Full sorted list below.
You:    [pastes the list straight into Linear]
```

**Linear standup**

```text
You:    "Open my Linear current cycle and write a 5-bullet standup from it."
Agent:  chrome_tab(activate, urlIncludes:"linear.app") → chrome_snapshot(uid:el-cycle) → chrome_evaluate(...)
        ✓ 5 in-progress, 2 blocked. Standup draft:
          • Shipped: bridge auto-recover.   • In flight: input reliability path.
          • Blocked: vendor portal CSP (waiting on infra).
          • Next: benchmark v2.             • Risk: none today.
You:    [drops it into #standup]
```

**Bug repro with evidence**

```text
You:    "Reproduce the checkout 500 on staging. Save a screenshot at each step under ./repro/."
Agent:  chrome_navigate(staging) → chrome_click(uid:el-add-to-cart) → chrome_screenshot(./repro/01-cart.png)
        → chrome_click(uid:el-checkout) → chrome_list_network_requests() → chrome_screenshot(./repro/02-500.png)
        ✓ POST /api/checkout → 500. Response body saved → ./repro/checkout-500.json
          3 screenshots in ./repro/. Trigger: missing tax_id when cart contains digital goods.
You:    [files the ticket with the folder attached]
```

<details>
<summary><strong>More recipes</strong> (form auto-fill, admin cross-check, visual diff, auth-only data pull, network forensics, file upload)</summary>

**Form auto-fill (no submit)**
> Open the vendor portal, fill the new-vendor form from this JSON, stop before submit.

**Admin cross-check**
> Across my Stripe / Postmark / our admin tabs, find any user where state disagrees.

**Local dev visual diff**
> Snapshot `localhost:3000` and the staging URL of the same page; tell me what's visually different.

**Auth-only data pull**
> Open my analytics dashboard tab and pull today's KPIs from the page.

**Network forensics**
> Reproduce the checkout bug, find the failing API call, and dump its response body.

**File upload through React**
> Open the photo uploader, upload `./fixtures/sample.png`, confirm the preview renders.

</details>

---

## Verifiable actions

Input tools return structured details such as the coordinates used, target tag, uploaded paths, key pressed, or scroll distance. For click/type/fill/key calls, pass `includeSnapshot: true` to get a fresh page snapshot in the same result:

```text
chrome_click(uid:"el-3", includeSnapshot:true) →
  result: { input:"chrome", x:412, y:238, tag:"BUTTON" }
  snapshot: { title, url, text, elements:[...] }
```

Agents can verify page state immediately instead of blindly retrying.

---

## What an agent gets

**21 tools**, grouped by job. Every one runs against your already-open tabs.

| Category        | Tools                                                                                          |
| --------------- | ---------------------------------------------------------------------------------------------- |
| **Tabs**        | `chrome_tab` (list/new/activate/close/version), `chrome_launch`                                |
| **Inspect**     | `chrome_snapshot` (concise observation: layout, actions, forms, page map, query matches, diff + stable uids), `chrome_find` (query → ranked uids), `chrome_inspect` (deep single-element context), `chrome_screenshot`, `chrome_evaluate` |
| **Navigate**    | `chrome_navigate` (with optional `initScript` at `document_start`), `chrome_wait_for`          |
| **Interact**    | `chrome_click`, `chrome_type`, `chrome_fill`, `chrome_key`, `chrome_hover`                     |
| **Gesture**     | `chrome_drag` (Chrome pointer drag), `chrome_scroll` (wheel + momentum), `chrome_tap` (touch)  |
| **Files**       | `chrome_upload_file` (Chrome file-input control; no native picker)                             |
| **Observe**     | `chrome_list_console_messages`, `chrome_list_network_requests`, `chrome_get_network_request` (with response body) |

Each tool is documented inline in Pi — agents see the parameters and gotchas (Chrome input, CSP limits, file upload behavior) without trial-and-error.

### Tab/window isolation

pi-chrome never overwrites the tab you're currently looking at. The first time a chrome_* action runs without an explicit target, pi-chrome opens a **dedicated automation window** (falling back to a dedicated tab if a separate window can't be created) and reuses it for the rest of the session. Your existing tabs and windows are left untouched. To point pi-chrome at a specific tab you already have open, pass `targetId`/`urlIncludes`/`titleIncludes`.

Details:

- **Per session.** Each Pi session owns its *own* automation window, so concurrent sessions (which all share one companion extension) never fight over a tab.
- **Survives `/reload` and Chrome service-worker restarts.** Ownership is tracked by id and mirrored to `chrome.storage.session`, so the window is reused rather than orphaned.
- **Cleanup is safe.** The dedicated target is closed when you revoke Chrome control (`/chrome revoke`) and on real session end — never on `/reload`. Cleanup only ever closes the calling session's own automation window/tab; user tabs/windows and other sessions' targets are never closed. Cleanup is fire-and-forget so it never blocks `/quit`, `/reload`, or session end.
- **Management actions are guarded.** `chrome_tab` `activate`/`close`/`group`/`ungroup` with no explicit target act on the session's automation tab if it exists, otherwise they error instead of touching your active tab.

### Known limits vs. human Chrome use

pi-chrome is strongest on web-page workflows exposed through DOM, screenshots, tabs, and Chrome input. It is not a full human/OS substitute. Current limitations include native Chrome/OS surfaces (print/save dialogs, permission bubbles, password-manager prompts), cross-origin iframe DOM access, rich multitouch/pinch/stylus gestures, visual CAPTCHA/bot challenges, hardware-backed auth (passkeys/security keys/biometrics), and arbitrary OS app interaction. For strict-CSP pages, use screenshot + coordinate input when `chrome_snapshot`/`chrome_evaluate` are blocked.

---

## Click & input behavior

`pi-chrome` drives interactive controls through Chrome's real input layer: clicks, typing, fill, keys, hover, drag, scroll, and touch. Under the hood it uses `chrome.debugger` / CDP, so input satisfies normal user-activation gates. Chrome may show the *"Pi Chrome Connector started debugging this browser"* banner while attached.

### Authorization

Chrome control is locked by default. Before any agent can use `chrome_*` tools, explicitly authorize the current Pi session from the terminal with `/chrome authorize`.

```text
/chrome authorize          # default: authorize for 15 minutes
/chrome authorize 30m      # authorize for 30 minutes
/chrome authorize 45       # custom minutes
/chrome authorize indefinite # authorize until revoked or Pi exits
/chrome revoke             # lock again
/chrome status             # shows connection + auth + background
```

This protects your signed-in Chrome profile from accidental agent use. The loopback bridge also rejects browser-origin command requests so arbitrary web pages cannot call into `127.0.0.1:17318` through CORS.

### Run in background / watch modes

By default, every `chrome_*` call runs in the **background** — Chrome won't pop up or steal focus. Switch to foreground when you want to **watch the agent work** (demos, debugging, first-time confidence).

```text
/chrome background          # toggle for the whole session
/chrome background on       # run in background (default)
/chrome background off      # bring Chrome forward so you can watch
```

Per-call `background: false` wins over the session setting (and `background: true` forces background).

### Diagnostics

- `/chrome doctor` — single command: connectivity, extension version, bridge owner, version drift, MAIN-world helper injection, `chrome_evaluate("1+1") === 2`, fingerprint flags.
- `/chrome onboard` — guided first-time setup.
- `/chrome status` — current connection, authorization, and background state.
- `/chrome background status` — current watch/background setting.

If the loaded Chrome extension is older than `pi-chrome` on disk, `/chrome doctor` tells you to reload it from `chrome://extensions`.

---

## Architecture

```text
  +----------------------+                       +--------------------------+
  |  Pi agent (terminal) |  -- 127.0.0.1:17318 ->|  Chrome extension        |
  |  chrome_* tools      |                       |  (your real profile)     |
  +-----------+----------+                       +-------------+------------+
              |  same machine                                  |
              v                                                v
   Other Pi sessions                          Tabs you already have open
   share the same bridge                      (signed in to GitHub,
   automatically                               Linear, Stripe, etc.)
```

Multiple Pi sessions (planner / worker / audit) can all drive the same Chrome at once. The first session opens the local bridge; later sessions detect it and pipe their commands through.

---

## Built-in benchmark suite

[`test-suite/`](./test-suite) is a benchmark for **any** browser-control agent (not just pi-chrome). It includes **42 primitive challenges** plus **4 hermetic BrowserGym-style long-horizon tasks**.

Scoring tracks expected outcomes per challenge rather than raw PASS count, so tools are judged against their declared browser-control capability. Unit challenges are split into gate buckets:

- `core` — expected release blockers for normal trusted-mode browser control.
- `conditional` — capability/environment gated (clipboard, touch, dialogs, native UI, etc.).
- `quality` — adversarial humanization/fingerprint signals; report trends, don't block general release by default.

Each challenge exposes `window.__verdict` / `window.__reason` / `window.__events` and a manifest entry with expected results per mode.

```bash
cd test-suite && python3 -m http.server 8765
# open http://127.0.0.1:8765/ in the Chrome window pi-chrome controls
```

Categories include: `trusted-input`, `pointer-humanization`, `keyboard`, `focus-keyboard`, `activation-gates`, `scroll`, `drag-drop`, `clipboard`, `native-controls`, `frameworks`, `editing`, `dom-complexity`, `frames`, `files`, `observability`, `csp`, `lazy-loading`, `dialogs`, `popups`, `spa-routing`, `fingerprint`, and `agent-safety`.

If you build a competing tool, please open a PR with your scores. We benchmark in public.

---

## Security model & why unpacked

**Unpacked on purpose.** pi-chrome ships as an inspectable, MIT-licensed extension folder you load once with Developer Mode, so the local bridge and browser permissions are easy to audit and update without a Web Store release cycle. Every line is yours to read in [`extensions/chrome-profile-bridge/browser-extension/`](./extensions/chrome-profile-bridge/browser-extension). `/chrome doctor` reports the loaded extension version and warns when it drifts from your installed `pi-chrome`.

The companion extension runs in the Chrome profile where you install it and has broad tab/scripting permissions. Only install it from a package source you trust. Even after install, `chrome_*` tools stay locked until you run `/chrome authorize` in Pi. Use `/chrome revoke` to lock them again.

The Pi side listens on `127.0.0.1:17318` and rejects browser-origin command requests; ordinary web pages cannot use CORS to drive the bridge. The bundled Chrome extension currently polls that default port, so custom bridge ports are not supported without editing the extension source and reloading it.

There is no network exposure in the default configuration; the bridge binds to loopback only.

---

## Roadmap signals

`pi-chrome` is actively shipped. Things on the near roadmap:

- More observability tools (DOM mutation streams, performance traces)
- First-class cross-origin iframe + Shadow-DOM uid stability across snapshots
- Native-browser surface coverage where extension APIs allow it (downloads, permissions, context menus)
- Web Push & service worker introspection
- Recorder mode that emits agent prompts from your own clicks

If you want one of those next, open an issue.

---

## License

MIT. See [LICENSE](./LICENSE).
