---
name: pi-chrome-qa
description: Quick-decision guide for mapping user requests to the right Chrome tool.
---

# Pi Chrome — Q&A Quick Reference

When the user asks something Chrome-related, match their phrasing to the right tool below.
When in doubt, run `chrome_status` first.

## "Can you check if Chrome is connected?"

Use `chrome_status`. No auth required. Returns version, latency, auth state.

## "What's on this page?" / "Summarize this page" / "Read what it says"

Use `chrome_read`. Lightweight — returns rendered text without the element tree.
If you also need to click things, use `chrome_snapshot` instead (gives uids).

## "Click the X button" / "Fill in the form" / "Type Y into Z"

1. `chrome_snapshot` first (get uids for interactive elements)
2. `chrome_click` / `chrome_fill` / `chrome_type` with the uid
3. Pass `includeSnapshot: true` to verify the result in one round trip

## "Take a screenshot" / "Show me what it looks like"

`chrome_screenshot`. Optional `format: "jpeg"` for smaller payload.

## "What does element X do?" / "What's around this button?"

`chrome_inspect` with the uid from a prior snapshot. Returns nearby text, actions, form context.

## "Find the merge button" / "Where's the submit button?"

`chrome_find` with `query: "merge button"`. Returns ranked matches with uids and coordinates.

## "Open a new tab" / "Close the tab" / "Switch to the GitHub tab"

`chrome_tab` with `action: "new"`, `"close"`, or `"activate"`.
For targeting an existing tab, pass `urlIncludes: "github.com"` or `titleIncludes: "GitHub"`.

## "Go to URL" / "Navigate to..."

`chrome_navigate` with `url: "https://..."`.

## "Wait for the page to load" / "Wait for X to appear"

`chrome_wait_for` with `type: "selector"` and `selector: "..."`
or `type: "expression"` and `expression: "document.querySelector('.done')"`.

## "Check the console for errors"

`chrome_list_console_messages`. Filter by `level: "error"` for just errors.

## "What API calls did this page make?" / "Network requests"

`chrome_list_network_requests` to list them, `chrome_get_network_request` to read one body.

## "Can you log in for me?"

No. Ask the user to log in manually — they're using their real Chrome profile with real auth.
Once they're signed in, you can operate the page normally.

## "Run this as mobile" / "Screenshot as iPhone"

1. `chrome_emulate` with `action: "device"`, `width: 390`, `height: 844`
2. `chrome_screenshot` to capture the mobile viewport
3. `chrome_emulate` with `action: "clear"` when done

## "Set my location to..." / "Pretend I'm in Tokyo"

`chrome_emulate` with `action: "geolocation"` (lat/long) or `action: "timezone"` with `timezoneId: "Asia/Tokyo"`.

## "Clear my cookies" / "Log out of everything"

`chrome_network` with `action: "clearCookies"`. Or `chrome_cookies` with `action: "remove"` for specific domains.

## "Get the cookie for..." / "Set a cookie"

`chrome_cookies` with `action: "get"` (filter by domain) or `action: "set"` (url, name, value).

## "Download this file"

`chrome_downloads` with `action: "download"`, `url: "..."`, optional `filename`.

## "What did I browse recently?" / "Check my history"

`chrome_history` with `action: "search"`, `text: "query"` (or empty for all).

## "I closed a tab by accident" / "Recently closed tabs"

`chrome_sessions` to list restorable tabs/windows.

## "Get a Google token" / "Access my Drive"

`chrome_identity` with `scopes: ["https://www.googleapis.com/auth/drive.readonly"]`.
Requires `identity` permission in the manifest.

## "It says Chrome control is locked"

Ask the user to run `/chrome authorize` in Pi. Default timeout is 15 minutes.

## "Chrome isn't responding" / "Tools keep timing out"

1. Run `chrome_status` to check bridge state
2. If not connected: ask user to reload "Pi Chrome Connector" at `chrome://extensions`
3. If version mismatch: same — reload the extension
4. If still failing: run `/chrome doctor`

## "It worked before but now it doesn't"

The most common cause is a stale snapshot uid after navigation or DOM change.
Run `chrome_snapshot` again to get fresh uids, then retry the action.

## "Can you run this JavaScript on the page?"

`chrome_evaluate` with `expression: "..."`. Runs in MAIN world, bypasses page CSP.
Wrap with `JSON.stringify(...)` to see the result clearly.

## "Upload a file" / "Attach this file to the form"

`chrome_upload_file` with `paths: ["/workspace/file.png"]` and the file-input uid from a snapshot.

## "Scroll down" / "Scroll to the bottom"

`chrome_scroll` with optional `direction: "down"` and `amount` in pixels.
