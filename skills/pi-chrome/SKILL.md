---
name: pi-chrome
description: Operate the user's active local Chrome profile through 30 typed Pi Chrome tools.
---

# Pi Chrome

Use `chrome_status` first when connector availability is uncertain. Observe before acting:
start interactive page work with a snapshot, use returned uid values, and take a fresh
snapshot after navigation or material DOM changes. Never reuse a stale ref.

## Q&A — match the user's request to the right tool

### "Check if Chrome is connected"
`chrome_status` — no auth required, returns version, latency, auth state.

### "What's on this page?" / "Summarize this" / "Read what it says"
`chrome_read` — lightweight rendered text, no element uids. Use `chrome_snapshot` if you also need to click things.

### "Click the X button" / "Fill the form" / "Type Y into Z"
1. `chrome_snapshot` to get uids
2. `chrome_click` / `chrome_fill` / `chrome_type` with the uid
3. Pass `includeSnapshot: true` to verify in one round trip

### "Take a screenshot" / "Show me"
`chrome_screenshot`. Pass `format: "jpeg"` for smaller payload.

### "What does element X do?" / "What's around this button?"
`chrome_inspect` with uid from a prior snapshot.

### "Find the merge button" / "Where's the submit button?"
`chrome_find` with `query: "merge button"`. Ranked matches with uids and coordinates.

### "Open a tab" / "Close tab" / "Switch to the GitHub tab"
`chrome_tab` with `action: "new"`, `"close"`, or `"activate"`. Target existing tabs with `urlIncludes` or `titleIncludes`.

### "Go to URL" / "Navigate to..."
`chrome_navigate` with `url: "https://..."`. Supports `initScript` for MAIN-world injection at document_start.

### "Wait for the page to load" / "Wait for X to appear"
`chrome_wait_for` with `type: "selector"` or `type: "expression"`.

### "Check console for errors"
`chrome_list_console_messages` — filter `level: "error"`.

### "What API calls did this page make?"
`chrome_list_network_requests` to list, `chrome_get_network_request` to read a body.

### "Can you log in for me?"
No. The user is on their real Chrome profile with real auth. Ask them to log in manually, then operate the page.

### "Run this as mobile" / "Screenshot as iPhone"
1. `chrome_emulate` with `action: "device"`, `width: 390`, `height: 844`
2. `chrome_screenshot`
3. `chrome_emulate` with `action: "clear"` when done

### "Set my location" / "Pretend I'm in Tokyo"
`chrome_emulate` with `action: "geolocation"` (lat/long) or `action: "timezone"` with `timezoneId: "Asia/Tokyo"`.

### "Clear my cookies" / "Log out of everything"
`chrome_network` with `action: "clearCookies"`, or `chrome_cookies` with `action: "remove"` for specific domains.

### "Get/set a cookie"
`chrome_cookies` with `action: "get"` (filter by domain) or `action: "set"` (url, name, value).

### "Download this file"
`chrome_downloads` with `action: "download"`, `url`, optional `filename`.

### "Check my history" / "What did I browse recently?"
`chrome_history` with `action: "search"`, `text` (or empty for all).

### "I closed a tab by accident"
`chrome_sessions` to list restorable tabs/windows.

### "Get a Google token" / "Access my Drive"
`chrome_identity` with `scopes: ["https://www.googleapis.com/auth/drive.readonly"]`.

### "Run this JavaScript on the page"
`chrome_evaluate` with `expression: "..."`. MAIN world, bypasses CSP. Wrap with `JSON.stringify()` for clarity.

### "Upload a file"
`chrome_upload_file` with `paths: ["/workspace/file.png"]` and the file-input uid.

### "Scroll down"
`chrome_scroll` with `direction: "down"` and `amount` in pixels.

## Troubleshooting

### "Chrome control is locked"
Ask the user to run `/chrome authorize`. Default 15 minutes.

### "Chrome isn't responding" / "Tools keep timing out"
1. `chrome_status` to check bridge state
2. Not connected: ask user to reload "Pi Chrome Connector" at `chrome://extensions`
3. Version mismatch: same — reload the extension
4. Still failing: run `/chrome doctor`

### "It worked before but now it doesn't"
Stale snapshot uid after navigation or DOM change. Run `chrome_snapshot` again, then retry.

## Design engineer workflows

### "Audit this page's design system"
`chrome_audit` — extracts colors, backgrounds, fonts, font sizes, spacing scale, border radius, shadows, transitions, CSS variables, media queries, Web Vitals, z-index, DOM stats, heading outline, forms, links, contrast issues, and ARIA issues in one call.

### "What CSS does this element have?"
`chrome_inspect_css` with `uid` (from snapshot) or `selector`. Returns computed styles grouped by Layout, Box, Typography, Visual — like DevTools Computed tab.

### "Screenshot just this element"
`chrome_screenshot` with `uid` or `selector`. Captures only the element's bounding box via CDP clip.

### "Screenshot at multiple breakpoints"
`chrome_screenshot` with `breakpoints: [{ width: 390, name: "mobile" }, { width: 1920, name: "desktop" }]`. Saves each separately.

### "Check responsive on iPhone/iPad"
`chrome_emulate` with `action: "preset"` and `preset: "iphone-15"` (or `ipad`, `pixel-8`, `galaxy-s24`, `desktop-1080`, `desktop-1440`). Then `chrome_screenshot`.

## Rules

- If the connector is unavailable, report the extension directory from `chrome_status` and ask the user to open Chrome. Do not substitute a different profile or transport.
- `chrome_snapshot` before clicking/typing; pass `uid` over `selector`.
- By default chrome_* tools run in the background; pass `background=false` to watch Chrome work.
- After `chrome_emulate`, take a fresh `chrome_screenshot` to verify the viewport changed.
- `chrome_emulate` action `clear` resets all overrides (device, geolocation, timezone, CPU).
