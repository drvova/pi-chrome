---
name: pi-chrome
description: Operate the user's active local Chrome profile through typed Pi Chrome tools.
---

# Pi Chrome workflow

Use `chrome_status` first when connector availability is uncertain. Choose the smallest typed Chrome
tool that directly performs the next operation.

Observe before acting. Start interactive page work with a snapshot, use returned ActionRef values,
and take a fresh snapshot after navigation or material DOM changes. Never reuse a stale ref.

## Tool selection by intent

- **Read page content:** `chrome_read` (lightweight text, no element uids)
- **Find an element:** `chrome_snapshot` (full Action Graph with uids) or `chrome_find` (query search)
- **Click/type/fill:** Use uids from the latest snapshot. Pass `includeSnapshot=true` to verify.
- **Diagnose connectivity:** `chrome_status` (no auth required)
- **Mobile testing:** `chrome_emulate` with action `device` for viewport, `geolocation`, `timezone`, `cpu`
- **Cookie/session:** `chrome_cookies` to get/set/remove across all domains
- **Network control:** `chrome_network` to override user-agent, clear cache/cookies
- **File download:** `chrome_downloads` to download by URL or list recent downloads
- **Browsing history:** `chrome_history` to search or delete URLs
- **Recently closed:** `chrome_sessions` to list restorable tabs/windows
- **Google API access:** `chrome_identity` to get an OAuth2 token

## Rules

- If the connector is unavailable, report the extension directory returned by `chrome_status` and ask
  the user to open the target Chrome profile. Do not substitute a different browser profile or transport.
- If a chrome_* tool says Chrome control is locked, ask the user to run `/chrome authorize`.
- `chrome_snapshot` before clicking/typing; pass `uid` over `selector`.
- By default chrome_* tools run in the background; pass `background=false` to watch Chrome work.
- After `chrome_emulate`, take a fresh `chrome_screenshot` to verify the viewport changed.
- `chrome_emulate` action `clear` resets all overrides (device, geolocation, timezone, CPU).
