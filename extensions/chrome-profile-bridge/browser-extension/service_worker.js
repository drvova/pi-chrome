const BRIDGE_URL = "http://127.0.0.1:17318";
const CLIENT_NAME = `Pi Chrome Connector ${chrome.runtime.id}`;
const POLL_ERROR_BACKOFF_MS = 2000;
const DEFAULT_GROUP_COLOR = "blue";
const PI_GROUP_RE = /^Pi(\b|\s*-)/i;
const VALID_GROUP_COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
const COMMAND_TIMEOUT_MS = 25_000;
const CDP_COMMAND_TIMEOUT_MS = 5_000;
const SCRIPTING_TIMEOUT_MS = 8_000;
const ATTACH_TIMEOUT_MS = 3_000;
let polling = false;
let bridgeToken = null;

// =================== pi-chrome automation target ownership ===================
// pi-chrome must never hijack the user's active tab. When a page/navigation action runs without
// an explicit target (targetId/urlIncludes/titleIncludes), we route it to a dedicated automation
// target that pi-chrome created and owns. We prefer a separate Chrome window so the user's
// windows are left untouched; if the windows API is unavailable we fall back to a dedicated tab.
//
// Ownership is SESSION-SCOPED, keyed by the calling Pi session's `sessionKey` (forwarded on the
// wire). One Chrome extension / service worker brokers commands for *all* Pi sessions (see the
// client/server bridge in index.ts), so a single global target would make concurrent sessions
// fight over one window. A per-session map gives each session its own isolated window and lets
// cleanup close exactly that session's target — never another session's, never a user's.
//
// State is mirrored to chrome.storage.session so a service-worker restart (MV3 can suspend the
// worker at any time) re-hydrates ownership instead of orphaning the window it already created.
// storage.session is cleared on browser restart; any window restored by Chrome's session-restore
// is then untracked and simply left alone (we only ever close ids we still recognize as ours).
const automationTargets = new Map(); // sessionKey -> { windowId?: number, tabId: number }
const DEFAULT_SESSION_KEY = "__default__";
const AUTOMATION_STORAGE_KEY = "piChromeAutomationTargets";
let automationHydrated = false;

function sessionKeyOf(params) {
  return params && typeof params.sessionKey === "string" && params.sessionKey
    ? params.sessionKey
    : DEFAULT_SESSION_KEY;
}

// Re-hydrate the in-memory ownership map from storage.session once per worker lifetime. Best
// effort: storage may be unavailable on old Chrome, and a failure just means we may create a
// fresh window (a harmless orphan) rather than reusing one.
async function hydrateAutomationTargets() {
  if (automationHydrated) return;
  automationHydrated = true;
  try {
    const stored = await chrome.storage?.session?.get?.(AUTOMATION_STORAGE_KEY);
    const saved = stored && stored[AUTOMATION_STORAGE_KEY];
    if (saved && typeof saved === "object") {
      for (const [key, value] of Object.entries(saved)) {
        if (value && typeof value.tabId === "number") {
          automationTargets.set(key, {
            windowId: typeof value.windowId === "number" ? value.windowId : undefined,
            tabId: value.tabId,
          });
        }
      }
    }
  } catch {
    // Ignore: treat as "no persisted state".
  }
}

let persistPending = false;
function persistAutomationTargets() {
  // Debounce: multiple rapid mutations (create window + create tab + group) coalesce into one write.
  // Without this, each step triggers a separate chrome.storage.session.set call.
  persistPending = true;
  Promise.resolve().then(async () => {
    persistPending = false;
    try {
      const obj = {};
      for (const [key, value] of automationTargets) {
        obj[key] = { windowId: typeof value.windowId === "number" ? value.windowId : null, tabId: value.tabId };
      }
      await chrome.storage?.session?.set?.({ [AUTOMATION_STORAGE_KEY]: obj });
    } catch {
      // Ignore: persistence is an optimization, not a correctness requirement.
    }
  });
}

// True if `tabId` is a pi-chrome-owned automation tab. Pass `sessionKey` to check a specific
// session; omit it to check ownership across *any* session (used as a safety predicate so we
// never operate on a user-created tab). Never infers ownership from "active".
function isPiChromeOwnedTarget(tabId, sessionKey) {
  if (typeof tabId !== "number") return false;
  if (sessionKey !== undefined) {
    const t = automationTargets.get(sessionKey);
    return !!t && t.tabId === tabId;
  }
  for (const t of automationTargets.values()) if (t.tabId === tabId) return true;
  return false;
}

// Create a fresh automation target for `sessionKey`. If this session already has a tab group,
// create the tab inside that group's window so one Pi session keeps one Chrome tab group (Chrome
// groups cannot span windows). If no group exists yet, prefer an isolated window; fall back to a
// tab. When the tab is created in a pre-existing group window, leave windowId unset so cleanup only
// closes our tab, never that whole window.
async function createAutomationTarget(sessionKey, groupTitle) {
  const existingGroup = groupTitle ? await findGroupRecordByTitle(groupTitle) : null;
  if (existingGroup && typeof existingGroup.windowId === "number") {
    const tab = await chrome.tabs.create({ url: "about:blank", active: false, windowId: existingGroup.windowId });
    automationTargets.set(sessionKey, { windowId: undefined, tabId: typeof tab.id === "number" ? tab.id : undefined });
    await persistAutomationTargets();
    return tab;
  }
  if (chrome.windows && typeof chrome.windows.create === "function") {
    try {
      const win = await chrome.windows.create({ url: "about:blank", focused: false });
      const created = win && Array.isArray(win.tabs) ? win.tabs[0] : undefined;
      if (created && typeof created.id === "number") {
        automationTargets.set(sessionKey, { windowId: typeof win.id === "number" ? win.id : undefined, tabId: created.id });
        await persistAutomationTargets();
        return created;
      }
    } catch {
      // Window creation can fail (policy, headless, etc.); fall back to a dedicated tab below.
    }
  }
  // Tab fallback: the tab lives in a pre-existing (user/shared) window we did NOT create, so we
  // must leave windowId unset — cleanup then closes only our tab, never the user's window.
  const tab = await chrome.tabs.create({ url: "about:blank", active: false });
  automationTargets.set(sessionKey, { windowId: undefined, tabId: typeof tab.id === "number" ? tab.id : undefined });
  await persistAutomationTargets();
  return tab;
}

// Return the session's owned automation target if it still exists, else null. Robust to the user
// (or Chrome) having closed it: a stale entry is forgotten so callers can recreate cleanly.
async function resolveOwnedAutomationTarget(sessionKey) {
  await hydrateAutomationTargets();
  const t = automationTargets.get(sessionKey);
  if (!t || typeof t.tabId !== "number") return null;
  const existing = await chrome.tabs.get(t.tabId).catch(() => null);
  if (existing && typeof existing.id === "number") return existing;
  automationTargets.delete(sessionKey);
  await persistAutomationTargets();
  return null;
}

// Return the session's dedicated automation target, creating it on first use (or after the user
// closed it). Used by page/navigation actions that need a live surface to drive.
async function getOrCreateAutomationTarget(sessionKey, groupTitle) {
  return (await resolveOwnedAutomationTarget(sessionKey)) || createAutomationTarget(sessionKey, groupTitle);
}

// Close only the session's pi-chrome-owned window/tab, and only if it still exists. Never touches
// user tabs/windows or other sessions' targets. Safe to call repeatedly and when nothing exists.
async function cleanupAutomationTarget(sessionKey) {
  await hydrateAutomationTargets();
  const t = automationTargets.get(sessionKey);
  automationTargets.delete(sessionKey);
  await persistAutomationTargets();
  if (!t) return { closedWindowId: null, closedTabId: null };
  const { windowId, tabId } = t;
  if (typeof windowId === "number" && chrome.windows && typeof chrome.windows.remove === "function") {
    const win = await chrome.windows.get(windowId).catch(() => null);
    if (win) {
      await chrome.windows.remove(windowId).catch(() => {});
      return { closedWindowId: windowId, closedTabId: typeof tabId === "number" ? tabId : null };
    }
  }
  if (typeof tabId === "number") {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab) {
      await chrome.tabs.remove(tabId).catch(() => {});
      return { closedWindowId: null, closedTabId: tabId };
    }
  }
  return { closedWindowId: null, closedTabId: null };
}

function withTimeout(promise, ms, label, onTimeout) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(async () => {
        try { await onTimeout?.(); } catch (error) { console.warn(`[pi-chrome] ${label} timeout cleanup failed:`, error?.message); }
        reject(new Error(`${label} timed out after ${ms}ms`));
      }, ms);
    }),
  ]);
}

// =================== Chrome input (CDP) layer ===================
// Tracks which tabs we have attached chrome.debugger to.
const attachedTabs = new Map(); // tabId -> { detachAt: number, pointer: {x,y} }
const INPUT_IDLE_DETACH_MS = 15_000;
const CDP_VERSION = "1.3";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function rng(min, max) { return min + Math.random() * (max - min); }

function inputStatus() {
  return {
    attachedTabs: Array.from(attachedTabs.keys()),
    permissionGranted: typeof chrome !== "undefined" && !!chrome.debugger,
  };
}

// Last few attach failures, kept for diagnostics.
const attachDebugLog = [];
function recordAttachEvent(entry) {
  attachDebugLog.push({ ...entry, t: Date.now() });
  if (attachDebugLog.length > 20) attachDebugLog.shift();
}

function normalPageTarget(target, tabId) {
  const url = String(target?.url || "");
  return target?.tabId === tabId && target?.type === "page" && !url.startsWith("chrome://") && !url.startsWith("chrome-extension://") && !url.startsWith("devtools://");
}

async function pageDebuggeeForTab(tabId) {
  const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))).catch(() => []);
  const target = targets.find((t) => normalPageTarget(t, tabId));
  return target?.id ? { targetId: target.id } : { tabId };
}

async function debuggerAttachRaw(tabId, preferredDebuggee) {
  const debuggee = preferredDebuggee || { tabId };
  await withTimeout(
    chrome.debugger.attach(debuggee, CDP_VERSION),
    ATTACH_TIMEOUT_MS,
    `Chrome debugger attach to tab ${tabId}`,
    async () => {
      attachedTabs.delete(tabId);
      try { await chrome.debugger.detach(debuggee); } catch {}
    },
  );
  return debuggee;
}

async function attachDebugger(tabId) {
  if (!chrome.debugger) throw new Error("chrome.debugger API unavailable; reload the extension to grant the new permission");
  if (attachedTabs.has(tabId)) {
    const entry = attachedTabs.get(tabId);
    entry.detachAt = Date.now() + INPUT_IDLE_DETACH_MS;
    return entry;
  }
  // Serialize concurrent attach attempts for the same tab. Two commands hitting the same
  // tab simultaneously both pass the has() check above, both try chrome.debugger.attach,
  // and one gets "Another debugger is already attached". The pending map ensures only
  // one attach runs at a time per tab; the second caller awaits and reuses the result.
  const pending = attachPending.get(tabId);
  if (pending) return pending;
  const attachPromise = attachDebuggerInner(tabId).finally(() => attachPending.delete(tabId));
  attachPending.set(tabId, attachPromise);
  return attachPromise;
}

const attachPending = new Map();

async function attachDebuggerInner(tabId) {
  // Before each attach, force-detach any stale CDP target this extension owns on the tab.
  // Chrome sometimes keeps a half-dead session around (extension reload mid-attach, etc.) and
  // surfaces it as "Cannot access a chrome-extension://" on the next attach attempt.
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    for (const tgt of targets) {
      if (tgt.tabId === tabId && tgt.attached) {
        recordAttachEvent({ kind: "stale-target-found", tabId, target: { id: tgt.id, type: tgt.type, url: tgt.url, extensionId: tgt.extensionId } });
        try { await chrome.debugger.detach({ tabId }); } catch {}
        await sleep(80);
        break;
      }
    }
  } catch {}
  let attachedDebuggee = null;
  const attemptAttach = async (debuggee) => {
    try {
      attachedDebuggee = await debuggerAttachRaw(tabId, debuggee);
      return null;
    } catch (error) {
      return error;
    }
  };
  const retryPageTargetIfExtensionBlocked = async (err, kind) => {
    if (!/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(String(err?.message || err))) return err;
    const pageDebuggee = await pageDebuggeeForTab(tabId);
    recordAttachEvent({ kind, tabId, debuggee: pageDebuggee });
    return attemptAttach(pageDebuggee);
  };
  let err = await attemptAttach();
  if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry");
  if (err) {
    const msg = String(err?.message || err);
    const transient = /Cannot access a chrome-extension|Cannot access contents of|No tab with id|Debugger is not attached|Another debugger|Target closed/i.test(msg);
    const tabSnapshot = await chrome.tabs.get(tabId).catch(() => null);
    recordAttachEvent({ kind: "attach-failed", tabId, message: msg, tabUrl: tabSnapshot?.url, transient });
    if (!transient) throw err;
    if (!tabSnapshot || (tabSnapshot.url || "").startsWith("chrome://") || (tabSnapshot.url || "").startsWith("chrome-extension://")) {
      throw new Error(`Chrome can't attach the debugger to this tab (${tabSnapshot?.url ?? "unknown"}). Open a normal http(s) tab and try again.`);
    }
    await sleep(180);
    err = await attemptAttach();
    if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry2");
    if (err) {
      recordAttachEvent({ kind: "attach-retry-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
      // One more try after a longer settle. Some Chrome builds need ~500ms after a navigation
      // for content-script registration on the tab to drain before chrome.debugger.attach
      // will accept the target.
      await sleep(500);
      err = await attemptAttach();
      if (err) err = await retryPageTargetIfExtensionBlocked(err, "attach-page-target-retry3");
      if (err) {
        recordAttachEvent({ kind: "attach-retry2-failed", tabId, message: String(err.message || err), tabUrl: tabSnapshot?.url });
        const meta = await describeInputTarget(tabId);
        throw new Error(`Chrome debugger attach failed for tab ${tabId}: ${String(err.message || err)}${targetMetaSuffix(meta)}`);
      }
    }
  }
  recordAttachEvent({ kind: "attached", tabId, debuggee: attachedDebuggee });
  // Seed pointer in a plausible "just left the address bar" location.
  const entry = { detachAt: Date.now() + INPUT_IDLE_DETACH_MS, pointer: { x: 120 + Math.random() * 200, y: 80 + Math.random() * 120 }, debuggee: attachedDebuggee || { tabId } };
  attachedTabs.set(tabId, entry);
  return entry;
}

async function describeInputTarget(tabId) {
  const tab = await chrome.tabs.get(Number(tabId)).catch(() => null);
  const active = (await chrome.tabs.query({ active: true, lastFocusedWindow: true }).catch(() => []))[0] || null;
  let targets = [];
  try { targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || []))); } catch {}
  return {
    resolvedTab: tab ? { id: tab.id, windowId: tab.windowId, url: tab.url, status: tab.status, title: tab.title, active: tab.active } : null,
    activeTab: active ? { id: active.id, windowId: active.windowId, url: active.url, status: active.status, title: active.title, active: active.active } : null,
    attachedTabs: Array.from(attachedTabs.keys()),
    cdpTargets: targets.map((t) => ({ id: t.id, tabId: t.tabId, type: t.type, url: t.url, attached: t.attached, extensionId: t.extensionId })),
  };
}

function targetMetaSuffix(meta) {
  return `\nTarget metadata: ${JSON.stringify(meta).slice(0, 4000)}`;
}

async function inputDebug(params) {
  const requested = params?.targetId ? await describeInputTarget(Number(params.targetId)) : await describeInputTarget(-1);
  return {
    extensionVersion: chrome.runtime.getManifest().version,
    extensionId: chrome.runtime.id,
    ...requested,
    recentAttachEvents: attachDebugLog.slice(),
  };
}

async function detachDebugger(tabId) {
  const entry = attachedTabs.get(tabId);
  if (!entry) return;
  attachedTabs.delete(tabId);
  try { await chrome.debugger.detach(entry.debuggee || { tabId }); } catch {}
}

async function detachAll() {
  const ids = Array.from(attachedTabs.keys());
  await Promise.all(ids.map(detachDebugger));
}

if (chrome.debugger && chrome.debugger.onDetach) {
  chrome.debugger.onDetach.addListener(({ tabId }, reason) => {
    if (tabId !== undefined) attachedTabs.delete(tabId);
    console.warn(`[pi-chrome] debugger detached from tab ${tabId}: ${reason}`);
  });
}

// Idle-detach: clean up debugger sessions past their detachAt. Runs as a chrome.alarm (MV3-safe)
// since setInterval dies when the worker suspends. See armKeepaliveAlarm for registration.
function cleanupIdleDebuggers() {
  const now = Date.now();
  for (const [tabId, entry] of attachedTabs) {
    if (entry.detachAt && entry.detachAt < now) {
      void detachDebugger(tabId);
    }
  }
}

// Release any stuck mouse buttons and keyboard modifiers after a mid-sequence input failure.
// If mousePressed succeeded but mouseReleased failed (or vice versa), the button stays logically
// pressed and every subsequent mouse move becomes a drag. Same for Shift/Ctrl/Alt modifiers.
async function releaseStuckInput(tabId) {
  try {
    await cdpRaw(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    await cdpRaw(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "right", buttons: 0, clickCount: 1, pointerType: "mouse" });
    await cdpRaw(tabId, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 0, y: 0, button: "middle", buttons: 0, clickCount: 1, pointerType: "mouse" });
    for (const code of ["ShiftLeft", "ControlLeft", "AltLeft", "MetaLeft"]) {
      await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: code.replace("Left", ""), code, windowsVirtualKeyCode: 0 });
    }
  } catch {}
}

function cdpRaw(tabId, method, params) {
  const debuggee = attachedTabs.get(tabId)?.debuggee || { tabId };
  return withTimeout(new Promise((resolve, reject) => {
    chrome.debugger.sendCommand(debuggee, method, params || {}, (result) => {
      if (chrome.runtime.lastError) reject(new Error(`${method}: ${chrome.runtime.lastError.message}`));
      else resolve(result);
    });
  }), CDP_COMMAND_TIMEOUT_MS, `CDP ${method}`, async () => {
    attachedTabs.delete(tabId);
    try { await chrome.debugger.detach(debuggee); } catch {}
  });
}

function executeScriptTimed(options, label) {
  return withTimeout(chrome.scripting.executeScript(options), SCRIPTING_TIMEOUT_MS, label || "chrome.scripting.executeScript");
}

// Wraps cdpRaw with one auto-recover on detached/closed sessions:
// chrome.debugger.attach can stay cached in attachedTabs even after Chrome killed
// the session (tab nav, devtools opened/closed, etc). Recover by detaching the
// stale entry and re-attaching, then retry the command once.
// Find foreign chrome-extension targets currently anchored to the tab. Password managers,
// autofill helpers, and other input-attached extensions create type:"other" CDP targets
// whose URL is chrome-extension://<otherId>/...  When that target is in focus, CDP refuses
// our Input.dispatchMouseEvent calls with "Cannot access a chrome-extension:// URL of
// different extension" — surfacing a cryptic error to the user.
async function findForeignExtensionTargets() {
  try {
    const targets = await new Promise((resolve) => chrome.debugger.getTargets((t) => resolve(t || [])));
    return targets.filter((t) => {
      const url = String(t.url || "");
      if (!url.startsWith("chrome-extension://")) return false;
      if (t.extensionId === chrome.runtime.id) return false;
      return true;
    });
  } catch {
    return [];
  }
}

function extractForeignExtId(targets) {
  for (const t of targets) {
    if (t.extensionId && t.extensionId !== chrome.runtime.id) return t.extensionId;
    const m = String(t.url || "").match(/chrome-extension:\/\/([a-p]+)\//);
    if (m && m[1] !== chrome.runtime.id) return m[1];
  }
  return null;
}

async function dismissOverlayViaEscape(tabId) {
  // Esc routes through key dispatcher (target-by-focus), not by mouse coordinates, so it
  // works even when a foreign chrome-extension popup is intercepting pointer events.
  try {
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await cdpRaw(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await sleep(120);
  } catch {}
}

async function cdp(tabId, method, params) {
  try {
    return await cdpRaw(tabId, method, params);
  } catch (error) {
    const msg = String(error?.message || error);
    const isStale = /Debugger is not attached|Detached while|Target closed|No tab with id/i.test(msg);
    const isForeignExtBlock = /Cannot access a chrome-extension:\/\/ URL of different extension/i.test(msg);
    if (isForeignExtBlock && /Input\./.test(method)) {
      // Foreign chrome-extension popup (autofill, password manager) is hijacking input.
      // Try once: dismiss via Esc, then retry.
      const before = await findForeignExtensionTargets();
      recordAttachEvent({ kind: "foreign-ext-detected", tabId, method, foreignExtId: extractForeignExtId(before), targetCount: before.length });
      await dismissOverlayViaEscape(tabId);
      try {
        return await cdpRaw(tabId, method, params);
      } catch (retryErr) {
        const retryMsg = String(retryErr?.message || retryErr);
        if (/Cannot access a chrome-extension:\/\/ URL of different extension/i.test(retryMsg)) {
          const after = await findForeignExtensionTargets();
          const id = extractForeignExtId(after) || extractForeignExtId(before) || "unknown";
          throw new Error(
            `Another Chrome extension (${id}) has an input overlay on this page (e.g. a password manager / autofill popup). \n` +
            `pi-chrome tried to dismiss it with Escape but it reappeared. Disable that extension on this page, close its popup, or focus the field via Tab instead of clicking.`,
          );
        }
        throw retryErr;
      }
    }
    if (!isStale) throw error;
    // Input commands: retry ONCE after re-attach, then give up.
    // A single CDP sendCommand that fails with 'Detached while handling command' did
    // NOT fire its event — Chrome's callback returns lastError when sendCommand
    // doesn't complete. So one retry after re-attach is safe (no double-fire risk
    // for a single atomic event). But we don't retry indefinitely: if re-attach
    // fails, or the retry also fails, we release stuck input and throw clearly.
    if (/Input\./.test(method)) {
      attachedTabs.delete(tabId);
      const reattached = await attachDebugger(tabId).catch(() => null);
      if (!reattached) {
        await releaseStuckInput(tabId).catch(() => undefined);
        throw new Error(
          `${method} failed: the Chrome debugger detached and could not be re-attached to tab ${tabId}. ` +
          `The page may have navigated, DevTools was opened, or the tab crashed. ` +
          `Take a fresh chrome_snapshot and retry the action.`,
        );
      }
      try {
        return await cdpRaw(tabId, method, params);
      } catch (retryError) {
        // Retry also failed — release stuck input and surface a clear error.
        await releaseStuckInput(tabId).catch(() => undefined);
        throw new Error(
          `${method} failed after re-attach attempt: ${String(retryError?.message || retryError)}. ` +
          `Take a fresh chrome_snapshot and retry the action.`,
        );
      }
    }
    // Non-input commands (DOM, Runtime, Page, Network, Emulation) are safe to retry
    // because they are read-only or idempotent setup operations.
    attachedTabs.delete(tabId);
    const reattached = await attachDebugger(tabId).catch(() => null);
    if (!reattached) {
      throw new Error(
        `${method} failed: the Chrome debugger detached and could not be re-attached to tab ${tabId}. ` +
        `The tab may have been closed or navigated to a protected URL (chrome://, devtools://).`,
      );
    }
    return cdpRaw(tabId, method, params);
  }
}

// cdpEval: evaluate a JavaScript expression string in the page's MAIN world via CDP
// Runtime.evaluate. Runtime.evaluate is a DevTools protocol command and is NOT subject to
// the page's Content-Security-Policy, so it works on pages that ship `script-src 'self'`
// without `'unsafe-eval'` (which blocks `eval`/`new Function`). Ensures the debugger is
// attached first. Returns the raw CDP result ({ result, exceptionDetails }).
async function cdpEval(tabId, expression, opts) {
  await attachDebugger(tabId);
  return cdp(tabId, "Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    userGesture: true,
    ...(opts || {}),
  });
}

function cdpExceptionText(details) {
  if (!details) return "";
  return String(
    details.exception?.description ||
      details.exception?.value ||
      details.text ||
      "",
  );
}

function cdpIsSyntaxError(details) {
  if (!details) return false;
  const className = String(details.exception?.className || "");
  return className === "SyntaxError" || /SyntaxError/.test(cdpExceptionText(details));
}

// Resolve target -> {x, y, rect} in viewport coords by running tiny script in tab.
async function resolveTargetInTab(tabId, params) {
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid, x, y) => {
      const state = window.__PI_CHROME_STATE__;
      let el = null;
      if (uid) {
        el = state && state.elements ? state.elements[uid] : null;
        if (!el || !el.isConnected) return { found: false, staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      } else if (selector) {
        el = document.querySelector(selector);
      }
      if (el) {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, rect: { left: r.left, top: r.top, width: r.width, height: r.height }, tag: el.tagName, found: true };
      }
      if (typeof x === "number" && typeof y === "number") return { x, y, rect: null, tag: null, found: true };
      return { found: false };
    },
    args: [params.selector ?? null, params.uid ?? null, params.x ?? null, params.y ?? null],
  }, `resolve input target in tab ${tabId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  if (!v || !v.found) throw new Error("Could not resolve target element for Chrome input");
  return v;
}

function pickInsideRect(rect) {
  if (!rect) return null;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + rng(-insetX, insetX),
    y: rect.top + rect.height / 2 + rng(-insetY, insetY),
  };
}

async function cdpMoveTo(tabId, x, y) {
  const entry = attachedTabs.get(tabId);
  const startX = entry?.pointer?.x ?? Math.max(20, Math.min(400, x - 200));
  const startY = entry?.pointer?.y ?? Math.max(20, Math.min(400, y - 200));
  const n = Math.max(18, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + rng(-wobble, wobble);
    const py = startY + (y - startY) * ease + rng(-wobble, wobble);
    await cdp(tabId, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: px, y: py, button: "none", buttons: 0, pointerType: "mouse",
    });
    await sleep(rng(5, 16));
  }
  if (entry) entry.pointer = { x, y };
}

function cdpModifiersFor(mods) {
  let m = 0;
  if (mods?.altKey) m |= 1;
  if (mods?.ctrlKey) m |= 2;
  if (mods?.metaKey) m |= 4;
  if (mods?.shiftKey) m |= 8;
  return m;
}

// Resolve a single printable character to { code, keyCode, needShift } on a US layout.
// Self-contained (maps defined inline) so it can be serialized into the page via
// HELPER_FUNCS for the DOM-event fallback as well as used by the CDP path.
// Using charCodeAt() for punctuation is wrong: e.g. "." is charCode 46 which collides
// with VK_DELETE, "-" is 45 (VK_INSERT), so app keydown handlers misfire and drop input.
function usKeyLayoutForChar(ch) {
  const PUNCT = {
    "`": { code: "Backquote", keyCode: 192 }, "~": { code: "Backquote", keyCode: 192, shift: true },
    "-": { code: "Minus", keyCode: 189 }, "_": { code: "Minus", keyCode: 189, shift: true },
    "=": { code: "Equal", keyCode: 187 }, "+": { code: "Equal", keyCode: 187, shift: true },
    "[": { code: "BracketLeft", keyCode: 219 }, "{": { code: "BracketLeft", keyCode: 219, shift: true },
    "]": { code: "BracketRight", keyCode: 221 }, "}": { code: "BracketRight", keyCode: 221, shift: true },
    "\\": { code: "Backslash", keyCode: 220 }, "|": { code: "Backslash", keyCode: 220, shift: true },
    ";": { code: "Semicolon", keyCode: 186 }, ":": { code: "Semicolon", keyCode: 186, shift: true },
    "'": { code: "Quote", keyCode: 222 }, "\"": { code: "Quote", keyCode: 222, shift: true },
    ",": { code: "Comma", keyCode: 188 }, "<": { code: "Comma", keyCode: 188, shift: true },
    ".": { code: "Period", keyCode: 190 }, ">": { code: "Period", keyCode: 190, shift: true },
    "/": { code: "Slash", keyCode: 191 }, "?": { code: "Slash", keyCode: 191, shift: true },
    " ": { code: "Space", keyCode: 32 },
  };
  // Shifted digit symbols share the digit's physical code + keyCode.
  const SHIFT_DIGIT = { ")": "0", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8", "(": "9" };
  if (/^[a-z]$/.test(ch)) return { code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), needShift: false };
  if (/^[A-Z]$/.test(ch)) return { code: `Key${ch}`, keyCode: ch.charCodeAt(0), needShift: true };
  if (/^[0-9]$/.test(ch)) return { code: `Digit${ch}`, keyCode: ch.charCodeAt(0), needShift: false };
  if (SHIFT_DIGIT[ch]) { const d = SHIFT_DIGIT[ch]; return { code: `Digit${d}`, keyCode: d.charCodeAt(0), needShift: true }; }
  const p = PUNCT[ch];
  if (p) return { code: p.code, keyCode: p.keyCode, needShift: !!p.shift };
  // Unknown char (e.g. unicode): keep text-driven insertion, avoid bogus keyCode collisions.
  return { code: ch, keyCode: 0, needShift: false };
}

function cdpKeyInfo(key, shifted) {
  // Map common keys to CDP key event init fields. Returns { code, key, windowsVirtualKeyCode, text }.
  const SPECIAL = {
    Enter: { code: "Enter", windowsVirtualKeyCode: 13, text: "\r" },
    Tab: { code: "Tab", windowsVirtualKeyCode: 9, text: "\t" },
    Backspace: { code: "Backspace", windowsVirtualKeyCode: 8, text: "" },
    Delete: { code: "Delete", windowsVirtualKeyCode: 46, text: "" },
    Escape: { code: "Escape", windowsVirtualKeyCode: 27, text: "" },
    ArrowLeft: { code: "ArrowLeft", windowsVirtualKeyCode: 37, text: "" },
    ArrowUp: { code: "ArrowUp", windowsVirtualKeyCode: 38, text: "" },
    ArrowRight: { code: "ArrowRight", windowsVirtualKeyCode: 39, text: "" },
    ArrowDown: { code: "ArrowDown", windowsVirtualKeyCode: 40, text: "" },
    Shift: { code: "ShiftLeft", windowsVirtualKeyCode: 16, text: "" },
    Control: { code: "ControlLeft", windowsVirtualKeyCode: 17, text: "" },
    Alt: { code: "AltLeft", windowsVirtualKeyCode: 18, text: "" },
    Meta: { code: "MetaLeft", windowsVirtualKeyCode: 91, text: "" },
    " ": { code: "Space", windowsVirtualKeyCode: 32, text: " " },
  };
  if (SPECIAL[key]) return { key, ...SPECIAL[key] };
  if (key.length === 1) {
    const ch = key;
    const layout = usKeyLayoutForChar(ch);
    return { key: ch, code: layout.code, windowsVirtualKeyCode: layout.keyCode, text: ch };
  }
  return { key, code: key, windowsVirtualKeyCode: 0, text: "" };
}

async function cdpTypeChar(tabId, ch) {
  const needShift = /^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch);
  let modifiers = 0;
  if (needShift) {
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyDown", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 8 });
    modifiers = 8;
    await sleep(rng(8, 22));
  }
  const info = cdpKeyInfo(ch);
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyDown", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: info.text, unmodifiedText: info.text, modifiers,
  });
  await sleep(rng(25, 90));
  await cdp(tabId, "Input.dispatchKeyEvent", {
    type: "keyUp", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers,
  });
  if (needShift) {
    await sleep(rng(5, 18));
    await cdp(tabId, "Input.dispatchKeyEvent", { type: "keyUp", key: "Shift", code: "ShiftLeft", windowsVirtualKeyCode: 16, modifiers: 0 });
  }
  await sleep(rng(35, 130));
}

async function domClickFallback(tabId, params, cause) {
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: (selector, uid, x, y) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (uid && (!el || !el.isConnected)) return { staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      if (!el && selector) el = document.querySelector(selector);
      if (!el && typeof x === "number" && typeof y === "number") el = document.elementFromPoint(x, y);
      if (!el) throw new Error(`DOM fallback target not found: ${uid || selector || `${x},${y}`}`);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const rect = el.getBoundingClientRect();
      const eventInit = { bubbles: true, cancelable: true, view: window, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 0, buttons: 1 };
      el.dispatchEvent(new PointerEvent("pointerdown", { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true }));
      el.dispatchEvent(new MouseEvent("mousedown", eventInit));
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      el.dispatchEvent(new PointerEvent("pointerup", { ...eventInit, pointerId: 1, pointerType: "mouse", isPrimary: true, buttons: 0 }));
      el.dispatchEvent(new MouseEvent("mouseup", { ...eventInit, buttons: 0 }));
      el.click();
      return { tag: el.tagName, url: location.href };
    },
    args: [params.selector ?? null, params.uid ?? null, params.x ?? null, params.y ?? null],
  }, `DOM click fallback in tab ${tabId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  return { input: "dom-fallback", reason: String(cause?.message || cause).slice(0, 500), tag: v?.tag };
}

async function chromeInputClick(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  try {
    await attachDebugger(tab.id);
    const resolved = await resolveTargetInTab(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
    await sleep(rng(45, 140));
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    // Reset :focus-visible if the click landed on a focusable element. CDP-driven pointer
    // focus can leave :focus-visible=true in Chromium, which trips heuristics that expect
    // Reset focus styling after pointer click when possible.
    if (params.selector || params.uid) {
      await executeScriptTimed({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: (sel, uid) => {
          const state = window.__PI_CHROME_STATE__;
          let el = null;
          if (uid && state && state.elements && state.elements[uid]) el = state.elements[uid];
          else if (sel) el = document.querySelector(sel);
          if (el && typeof el.focus === "function" && el === document.activeElement) {
            try { el.blur(); el.focus({ preventScroll: true, focusVisible: false }); } catch {}
          }
        },
        args: [params.selector ?? null, params.uid ?? null],
      }, `reset focus style in tab ${tab.id}`).catch(() => undefined);
    }
    return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
  } catch (error) {
    if (params.domFallback === false) throw error;
    return domClickFallback(tab.id, params, error);
  }
}

async function chromeInputHover(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved = await resolveTargetInTab(tab.id, params);
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  await cdpMoveTo(tab.id, point.x, point.y);
  await sleep(rng(80, 220));
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputKey(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const key = String(params.key || "");
  if (!key) throw new Error("chrome.key: missing key");
  const mods = params.modifiers || {};
  const modBits = cdpModifiersFor(mods);
  // Press modifiers in standard order, then key, then release in reverse.
  const modOrder = [];
  if (mods.metaKey) modOrder.push({ key: "Meta", code: "MetaLeft", vk: 91 });
  if (mods.ctrlKey) modOrder.push({ key: "Control", code: "ControlLeft", vk: 17 });
  if (mods.altKey) modOrder.push({ key: "Alt", code: "AltLeft", vk: 18 });
  if (mods.shiftKey) modOrder.push({ key: "Shift", code: "ShiftLeft", vk: 16 });
  for (const m of modOrder) {
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: modBits });
    await sleep(rng(6, 18));
  }
  const info = cdpKeyInfo(key);
  // When modifiers are active, browsers usually emit "rawKeyDown" (no text) so chords like Cmd+V don't insert the literal char.
  const downType = modBits ? "rawKeyDown" : "keyDown";
  await cdp(tab.id, "Input.dispatchKeyEvent", {
    type: downType, key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, nativeVirtualKeyCode: info.windowsVirtualKeyCode,
    text: modBits ? "" : info.text, unmodifiedText: modBits ? "" : info.text, modifiers: modBits,
  });
  await sleep(rng(25, 90));
  await cdp(tab.id, "Input.dispatchKeyEvent", {
    type: "keyUp", key: info.key, code: info.code,
    windowsVirtualKeyCode: info.windowsVirtualKeyCode, modifiers: modBits,
  });
  for (const m of modOrder.reverse()) {
    await sleep(rng(5, 18));
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: m.key, code: m.code, windowsVirtualKeyCode: m.vk, modifiers: 0 });
  }
  return { input: "chrome", key: info.key, modifiers: mods };
}

async function chromeInputType(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  if (params.selector || params.uid) {
    // Focus target by clicking it first.
    const resolved = await resolveTargetInTab(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
    await sleep(rng(45, 110));
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
    await sleep(rng(50, 120));
  }
  const text = String(params.text || "");
  for (const ch of Array.from(text)) await cdpTypeChar(tab.id, ch);
  if (params.pressEnter) {
    await cdpTypeChar(tab.id, "\r").catch(() => undefined);
    await chromeInputKey({ ...params, key: "Enter" });
  }
  return { input: "chrome", length: text.length };
}

async function domFillFallback(tabId, params, cause) {
  if (!(params.selector || params.uid)) throw cause;
  const results = await executeScriptTimed({
    target: { tabId, frameIds: [0] },
    world: "MAIN",
    func: async (selector, uid, text, submit) => {
      const state = window.__PI_CHROME_STATE__;
      let el = uid && state && state.elements ? state.elements[uid] : null;
      if (uid && (!el || !el.isConnected)) return { staleUid: true, reason: `snapshot uid ${uid} is stale; refresh chrome_snapshot`, url: location.href };
      if (!el && selector) el = document.querySelector(selector);
      if (!el) throw new Error(`DOM fallback target not found: ${uid || selector}`);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      if (typeof el.focus === "function") el.focus({ preventScroll: true });
      const value = String(text ?? "");
      if ("value" in el) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(el, value);
        else el.value = value;
      } else if (el.isContentEditable) {
        el.textContent = value;
      } else {
        throw new Error(`DOM fallback target is not fillable: <${el.tagName.toLowerCase()}>`);
      }
      el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      if (submit) {
        const form = el.closest("form");
        if (form) form.requestSubmit ? form.requestSubmit() : form.submit();
        else document.querySelector("button,[type=submit]")?.click();
      }
      return { valueMatches: "value" in el ? el.value === value : el.textContent === value, tag: el.tagName, url: location.href };
    },
    args: [params.selector ?? null, params.uid ?? null, params.text ?? "", params.submit === true],
  }, `DOM fill fallback in tab ${tabId}`);
  const v = results?.[0]?.result;
  if (v?.staleUid) throw new Error(v.reason || "snapshot uid is stale; refresh chrome_snapshot");
  return { input: "dom-fallback", length: String(params.text || "").length, valueMatches: v?.valueMatches, reason: String(cause?.message || cause).slice(0, 500), tag: v?.tag };
}

async function chromeInputFill(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  try {
    await attachDebugger(tab.id);
    if (!(params.selector || params.uid)) throw new Error("chrome.fill: selector or uid required");
    const resolved = await resolveTargetInTab(tab.id, params);
    const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
    await cdpMoveTo(tab.id, point.x, point.y);
    // Triple-click selects all in input fields.
    for (let i = 1; i <= 3; i++) {
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: i, pointerType: "mouse", force: 0.5 });
      await sleep(rng(20, 60));
      await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: i, pointerType: "mouse" });
      await sleep(rng(20, 60));
    }
    // Delete selection.
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyDown", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await cdp(tab.id, "Input.dispatchKeyEvent", { type: "keyUp", key: "Delete", code: "Delete", windowsVirtualKeyCode: 46 });
    await sleep(rng(20, 60));
    const text = String(params.text || "");
    for (const ch of Array.from(text)) await cdpTypeChar(tab.id, ch);
    if (params.submit) await chromeInputKey({ ...params, key: "Enter" });
    return { input: "chrome", length: text.length };
  } catch (error) {
    if (params.domFallback === false) throw error;
    return domFillFallback(tab.id, params, error);
  }
}

async function chromeInputScroll(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);

  // scrollIntoView: skip the wheel-event simulation entirely and just call
  // el.scrollIntoView({ block: 'center' }). Works even when CDP is flaky.
  if ((params.selector || params.uid) && params.scrollIntoView !== false) {
    try {
      await executeScriptTimed({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: (sel, uid) => {
          const state = window.__PI_CHROME_STATE__;
          const el = uid && state && state.elements && state.elements[uid] ? state.elements[uid] : (sel ? document.querySelector(sel) : null);
          if (el) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        },
        args: [params.selector ?? null, params.uid ?? null],
      }, `scrollIntoView in tab ${tab.id}`);
    } catch {}
  }

  const totalY = params.deltaY || 0, totalX = params.deltaX || 0;
  if (totalY === 0 && totalX === 0) {
    return { input: "chrome", deltaY: 0, deltaX: 0, steps: 0 };
  }

  // Cap the number of wheel events so large scrolls don't timeout.
  const MAX_WHEEL_EVENTS = 40;
  try {
    await attachDebugger(tab.id);
    const resolved = (params.selector || params.uid) ? await resolveTargetInTab(tab.id, params) : { x: 100, y: 100, rect: null };
    const x = resolved.rect ? resolved.rect.left + Math.min(resolved.rect.width, 800) / 2 : resolved.x;
    const y = resolved.rect ? resolved.rect.top + Math.min(resolved.rect.height, 600) / 2 : resolved.y;

    const peak = Math.max(Math.abs(totalY), Math.abs(totalX), 1);
    const PEAK_TARGET = 22;
    const w = [];
    function build(n) {
      const arr = [];
      const peakIdx = Math.max(1, Math.floor(n * 0.15));
      for (let i = 0; i < n; i++) {
        if (i <= peakIdx) arr.push(0.5 + 0.5 * (i / peakIdx));
        else arr.push(Math.pow(0.88, i - peakIdx));
      }
      return arr;
    }
    let n = Math.max(12, params.steps || 24);
    for (let attempt = 0; attempt < 8; attempt++) {
      const arr = build(n);
      const s = arr.reduce((a, b) => a + b, 0);
      const peakStep = peak * (Math.max(...arr) / s);
      if (peakStep <= PEAK_TARGET || n >= MAX_WHEEL_EVENTS) {
        w.length = 0;
        w.push(...arr);
        break;
      }
      n = Math.ceil(n * 1.4);
    }
    if (w.length === 0) w.push(...build(n));

    const eventsToFire = Math.min(n, MAX_WHEEL_EVENTS);
    const sumW = w.reduce((a, b) => a + b, 0);
    let wheelY = 0, wheelX = 0;
    for (let i = 0; i < eventsToFire; i++) {
      const dy = totalY * (w[i] / sumW), dx = totalX * (w[i] / sumW);
      wheelY += dy; wheelX += dx;
      await cdp(tab.id, "Input.dispatchMouseEvent", {
        type: "mouseWheel", x, y, deltaX: dx, deltaY: dy, pointerType: "mouse",
      }).catch(() => undefined);
      await sleep(rng(22, 48));
    }

    // Cover any remaining distance via direct scrollBy so the final position is exact.
    const remainingY = Math.round(totalY - wheelY);
    const remainingX = Math.round(totalX - wheelX);
    if (Math.abs(remainingY) > 1 || Math.abs(remainingX) > 1) {
      await executeScriptTimed({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: (dy, dx) => window.scrollBy(dx, dy),
        args: [remainingY, remainingX],
      }, `scrollBy remainder in tab ${tab.id}`).catch(() => undefined);
    }

    return { input: "chrome", deltaY: totalY, deltaX: totalX, wheelEvents: eventsToFire, remainderApplied: { y: remainingY, x: remainingX } };
  } catch (error) {
    // DOM fallback: if the debugger is flaky or detached, use window.scrollBy directly.
    await executeScriptTimed({
      target: { tabId: tab.id, frameIds: [0] },
      world: "MAIN",
      func: (dy, dx) => window.scrollBy(dx, dy),
      args: [totalY, totalX],
    }, `DOM fallback scroll in tab ${tab.id}`).catch(() => {
      throw new Error(`Chrome scroll failed via both CDP and DOM: ${error?.message}`);
    });
    return { input: "dom-fallback", deltaY: totalY, deltaX: totalX, reason: error?.message };
  }
}

async function chromeInputTap(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const resolved = (params.selector || params.uid || (typeof params.x === "number" && typeof params.y === "number"))
    ? await resolveTargetInTab(tab.id, params)
    : null;
  if (!resolved || !resolved.found) throw new Error("chrome.tap: target not found");
  const point = resolved.rect ? pickInsideRect(resolved.rect) : { x: resolved.x, y: resolved.y };
  const tp = { x: point.x, y: point.y, radiusX: 8, radiusY: 8, rotationAngle: 0, force: 0.5, id: 1 };
  await cdp(tab.id, "Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [tp] });
  await sleep(rng(40, 110));
  await cdp(tab.id, "Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return { input: "chrome", x: point.x, y: point.y, tag: resolved.tag };
}

async function chromeInputDrag(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  const from = await resolveTargetInTab(tab.id, { selector: params.fromSelector ?? null, uid: params.fromUid ?? null, x: params.fromX ?? null, y: params.fromY ?? null });
  const to = await resolveTargetInTab(tab.id, { selector: params.toSelector ?? null, uid: params.toUid ?? null, x: params.toX ?? null, y: params.toY ?? null });
  const fp = from.rect ? pickInsideRect(from.rect) : { x: from.x, y: from.y };
  const tp = to.rect ? pickInsideRect(to.rect) : { x: to.x, y: to.y };
  await cdpMoveTo(tab.id, fp.x, fp.y);
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mousePressed", x: fp.x, y: fp.y, button: "left", buttons: 1, clickCount: 1, pointerType: "mouse", force: 0.5 });
  await sleep(rng(60, 140));
  const steps = params.steps || 20;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 6;
    const x = fp.x + (tp.x - fp.x) * ease + rng(-wobble, wobble);
    const y = fp.y + (tp.y - fp.y) * ease + rng(-wobble, wobble);
    await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "left", buttons: 1, pointerType: "mouse" });
    await sleep(rng(10, 26));
  }
  await cdp(tab.id, "Input.dispatchMouseEvent", { type: "mouseReleased", x: tp.x, y: tp.y, button: "left", buttons: 0, clickCount: 1, pointerType: "mouse" });
  return { input: "chrome", from: fp, to: tp, steps };
}

async function chromeInputUpload(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  await attachDebugger(tab.id);
  if (!(params.selector || params.uid)) throw new Error("chrome.upload: selector or uid required");
  const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
  if (!paths.length) throw new Error("chrome.upload: no file paths provided");
  const expression = `(() => {
    const selector = ${JSON.stringify(params.selector ?? null)};
    const uid = ${JSON.stringify(params.uid ?? null)};
    const state = window.__PI_CHROME_STATE__;
    const el = uid && state && state.elements ? state.elements[uid] : (selector ? document.querySelector(selector) : null);
    if (!el || el.tagName !== "INPUT" || el.type !== "file") throw new Error("Target must be <input type=file>");
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return el;
  })()`;
  const evaluated = await cdp(tab.id, "Runtime.evaluate", { expression, objectGroup: "pi-chrome-upload", includeCommandLineAPI: false, returnByValue: false });
  if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || "Could not resolve file input");
  const objectId = evaluated.result?.objectId;
  if (!objectId) throw new Error("Could not resolve file input object");
  await cdp(tab.id, "DOM.enable", {}).catch(() => undefined);
  const requested = await cdp(tab.id, "DOM.requestNode", { objectId });
  if (!requested.nodeId) throw new Error("Could not resolve file input node");
  await cdp(tab.id, "DOM.setFileInputFiles", { nodeId: requested.nodeId, files: paths });
  await cdp(tab.id, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: `function() { this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return this.files ? this.files.length : 0; }`,
    returnByValue: true,
  }).catch(() => undefined);
  await cdp(tab.id, "Runtime.releaseObject", { objectId }).catch(() => undefined);
  return { input: "chrome", uploaded: paths.map((path) => ({ path })) };
}
// ===============================================================


function armKeepaliveAlarm() {
  chrome.alarms.create("pi-bridge-keepalive", { periodInMinutes: 0.5 });
  chrome.alarms.create("pi-debugger-cleanup", { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.action.setBadgeText({ text: "pi" });
  chrome.action.setBadgeBackgroundColor({ color: "#4f46e5" });
  armKeepaliveAlarm();
  void pollLoop();
});

chrome.runtime.onStartup.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

// Clean up all per-tab state when a tab closes. Without this, initScriptIds and attachedTabs
// leak entries for every tab Pi ever touched, and the idle-detach alarm wastes cycles trying
// to detach the debugger from dead tabs.
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    attachedTabs.delete(tabId);
    initScriptIds.delete(tabId);
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "pi-bridge-keepalive") void pollLoop();
  else if (alarm.name === "pi-debugger-cleanup") cleanupIdleDebuggers();
});

chrome.action.onClicked.addListener(() => {
  armKeepaliveAlarm();
  void pollLoop();
});

armKeepaliveAlarm();
async function pollLoop() {
  if (polling) return;
  polling = true;
  try {
    while (true) {
      const response = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error(`bridge /next HTTP ${response.status}`);
      const expected = response.headers.get("x-pi-chrome-version");
      const ours = chrome.runtime.getManifest().version;
      if (expected && expected !== ours && isVersionOlder(ours, expected)) {
        console.warn(`[pi-chrome] extension v${ours} behind pi-chrome v${expected}; reloading extension`);
        try { chrome.runtime.reload(); } catch {}
        return;
      }
      const token = response.headers.get("x-pi-chrome-token");
      if (token) bridgeToken = token;
      const payload = await response.json();
      if (payload.type === "command") await handleCommand(payload.command);
    }
  } catch (error) {
    console.warn("[pi-chrome] poll loop error:", error?.message);
    await sleep(POLL_ERROR_BACKOFF_MS);
  } finally {
    polling = false;
  }
}

async function handleCommand(command) {
  try {
    const result = await withTimeout(
      dispatch(command.action, command.params ?? {}),
      COMMAND_TIMEOUT_MS,
      command.action || "Chrome command",
      () => detachAll(),
    );
    await postResult({ id: command.id, ok: true, result });
  } catch (error) {
    await postResult({ id: command.id, ok: false, error: error?.message ?? String(error) });
  }
}

async function postResult(result) {
  const posted = await postResultRaw(result);
  if (posted) return;
  // 403 = bridge restarted (new token). Poll /next to get the fresh token, then retry once.
  // Without this, a mid-flight command result is lost on every /reload.
  try {
    const response = await fetch(`${BRIDGE_URL}/next?name=${encodeURIComponent(CLIENT_NAME)}`, { cache: "no-store" });
    const token = response.headers.get("x-pi-chrome-token");
    if (token) bridgeToken = token;
    await postResultRaw(result);
  } catch (error) {
    console.warn("[pi-chrome] result post failed after token refresh:", error?.message);
  }
}

async function postResultRaw(result) {
  const headers = { "content-type": "application/json" };
  if (bridgeToken) headers["x-pi-chrome-token"] = bridgeToken;
  const response = await fetch(`${BRIDGE_URL}/result`, {
    method: "POST",
    headers,
    body: JSON.stringify(result),
  });
  if (!response.ok && response.status !== 404) {
    console.warn(`[pi-chrome] result post HTTP ${response.status}`);
    return false;
  }
  return true;
}

function isVersionOlder(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (x < y) return true;
    if (x > y) return false;
  }
  return false;
}

function cleanGroupTitle(value) {
  const text = String(value || "Pi").replace(/\s+/g, " ").trim().slice(0, 80);
  return text || "Pi";
}

function cleanGroupColor(value) {
  const color = String(value || DEFAULT_GROUP_COLOR).toLowerCase();
  return VALID_GROUP_COLORS.has(color) ? color : DEFAULT_GROUP_COLOR;
}

async function groupRecord(groupId) {
  if (typeof groupId !== "number" || groupId < 0 || !chrome.tabGroups) return null;
  const group = await chrome.tabGroups.get(groupId).catch(() => null);
  if (!group) return null;
  return {
    id: group.id,
    title: group.title || "",
    color: group.color || "",
    collapsed: Boolean(group.collapsed),
    windowId: group.windowId,
    piGroup: Boolean(group.title && PI_GROUP_RE.test(group.title)),
  };
}

// Find existing tab groups whose title matches `title` (case-insensitive).
// Same-window lookup is used when grouping an already-created tab. Any-window lookup is used before
// creating a new Pi tab so one Pi session keeps one tab group and new tabs are created in that
// group's window (Chrome tab groups cannot span windows).
async function findGroupByTitle(windowId, title) {
  if (!chrome.tabGroups) return null;
  const wanted = cleanGroupTitle(title).toLowerCase();
  const groups = await chrome.tabGroups.query({ windowId }).catch(() => []);
  const match = groups.find((g) => (g.title || "").trim().toLowerCase() === wanted);
  return match ? match.id : null;
}

async function findGroupRecordByTitle(title) {
  if (!chrome.tabGroups) return null;
  const wanted = cleanGroupTitle(title).toLowerCase();
  const groups = await chrome.tabGroups.query({}).catch(() => []);
  return groups.find((g) => (g.title || "").trim().toLowerCase() === wanted) || null;
}

// Add `tab` to a tab group, then set title/color. If the tab is ungrouped, reuse an
// existing same-title group in its window when present, otherwise create a new group.
async function groupTab(tab, title, color) {
  if (!chrome.tabGroups) throw new Error("chrome.tabGroups API unavailable; reload the extension after granting the tabGroups permission");
  if (!tab || typeof tab.id !== "number") throw new Error("No tab to group");
  const groupTitle = cleanGroupTitle(title);
  let groupId = tab.groupId;
  if (typeof groupId !== "number" || groupId < 0) {
    const existing = await findGroupByTitle(tab.windowId, groupTitle);
    groupId = existing !== null
      ? await chrome.tabs.group({ groupId: existing, tabIds: [tab.id] })
      : await chrome.tabs.group({ tabIds: [tab.id] });
  }
  await chrome.tabGroups.update(groupId, { title: groupTitle, color: cleanGroupColor(color), collapsed: false });
  const grouped = await chrome.tabs.get(tab.id);
  return { tab: await formatTab(grouped), group: await groupRecord(groupId) };
}

async function dispatch(action, params) {
  switch (action) {
    case "tab.version":
      return {
        extensionId: chrome.runtime.id,
        extensionVersion: chrome.runtime.getManifest().version,
        bridgeUrl: BRIDGE_URL,
        userAgent: navigator.userAgent,
      };
    case "tab.list": {
      const tabs = await chrome.tabs.query({});
      return Promise.all(tabs.map(formatTab));
    }
    case "tab.new": {
      // Every Pi-opened tab must join a tab group. There is intentionally no opt-out: an ungrouped
      // Pi-created tab is easy to lose among user tabs. If grouping fails after creation, close the
      // tab best-effort before surfacing the error so tab.new never leaves an ungrouped Pi tab.
      const groupTitle = params.groupTitle || "Pi";
      const existingGroup = await findGroupRecordByTitle(groupTitle);
      const createParams = { url: params.url || "about:blank", active: true };
      if (existingGroup && typeof existingGroup.windowId === "number") createParams.windowId = existingGroup.windowId;
      const tab = await chrome.tabs.create(createParams);
      try {
        return await groupTab(tab, groupTitle, params.groupColor);
      } catch (error) {
        if (typeof tab.id === "number") await chrome.tabs.remove(tab.id).catch(() => {});
        throw error;
      }
    }
    case "tab.activate": {
      // Management actions never auto-create an automation target (createOwnedTarget:false): with
      // no explicit target they act on an owned target if one exists, else error — they must never
      // fall back to (or spawn a tab just to touch) the user's active tab.
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      await chrome.windows.update(tab.windowId, { focused: true });
      return formatTab(await chrome.tabs.update(tab.id, { active: true }));
    }
    case "tab.group": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      return groupTab(tab, params.groupTitle || "Pi", params.groupColor);
    }
    case "tab.ungroup": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      if (typeof tab.groupId === "number" && tab.groupId >= 0) await chrome.tabs.ungroup(tab.id);
      return formatTab(await chrome.tabs.get(tab.id));
    }
    case "tab.close": {
      const tab = await getTabByParams(params, { createOwnedTarget: false });
      await chrome.tabs.remove(tab.id);
      return { closed: tab.id };
    }
    case "page.snapshot":
      return snapshotInTab(params);
    case "page.inspect":
      return inspectInTab(params);
    case "page.evaluate":
      return evaluateInTab(params);
    case "page.click":
      return withOptionalSnapshot(params, chromeInputClick);
    case "page.hover":
      return chromeInputHover(params);
    case "page.drag":
      return chromeInputDrag(params);
    case "page.upload":
      return chromeInputUpload(params);
    case "page.type":
      return withOptionalSnapshot(params, chromeInputType);
    case "page.fill":
      return withOptionalSnapshot(params, chromeInputFill);
    case "page.key":
      return withOptionalSnapshot(params, chromeInputKey);
    case "page.scroll":
      return chromeInputScroll(params);
    case "page.tap":
      return chromeInputTap(params);
    case "input.status":
      return inputStatus();
    case "input.debug":
      return inputDebug(params);
    case "page.console.list":
      return executeInTab(params, listConsoleMessages, [params.clear === true]);
    case "page.network.list":
      return executeInTab(params, listNetworkRequests, [params.includePreservedRequests === true, params.clear === true]);
    case "page.network.get":
      return executeInTab(params, getNetworkRequest, [params.requestId]);
    case "page.waitFor": {
      // Poll from the service worker via CDP (bypasses CSP). The old approach ran the polling
      // loop in-page with new Function() for expression checks, which fails under strict CSP.
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      const timeoutMs = params.timeoutMs || 10000;
      const intervalMs = params.intervalMs || 250;
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        let ok = false;
        try {
          const expr = params.kind === "selector"
            ? `!!document.querySelector(${JSON.stringify(params.value)})`
            : params.value;
          ok = Boolean(await evaluateInTab({ ...params, expression: expr, foreground: false }));
        } catch {
          ok = false;
        }
        if (ok) return { elapsedMs: Date.now() - started };
        await sleep(intervalMs);
      }
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${params.kind}: ${params.value}`);
    }
    case "page.probe":
      // Lightweight capability probe for /chrome-doctor. Runs in MAIN world.
      return executeInTab(params, probePage, []);
    case "page.navigate": {
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      if (params.initScript) {
        // Register a one-shot document_start content script. We register, navigate, wait, then unregister.
        await registerInitScript(tab.id, params.initScript);
      }
      const wait = params.waitUntilLoad !== false ? waitForTabComplete(tab.id, params.timeoutMs || 15000) : Promise.resolve(undefined);
      const updated = await chrome.tabs.update(tab.id, { url: params.url });
      try {
        await wait;
      } finally {
        if (params.initScript) await unregisterInitScript(tab.id).catch(() => undefined);
      }
      // Navigation destroys the page's execution context. Clear stale snapshot state
      // so the next snapshot doesn't try to resolve uids from the old page.
      await cdp(tab.id, "Runtime.evaluate", { expression: "delete window.__PI_CHROME_STATE__", returnByValue: true }).catch(() => undefined);
      return await formatTab(await chrome.tabs.get(updated.id));
    }
    case "page.reload": {
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      const wait = waitForTabComplete(tab.id, params.timeoutMs || 15000);
      await chrome.tabs.reload(tab.id, { bypassCache: params.bypassCache === true });
      await wait;
      await cdp(tab.id, "Runtime.evaluate", { expression: "delete window.__PI_CHROME_STATE__", returnByValue: true }).catch(() => undefined);
      return await formatTab(await chrome.tabs.get(tab.id));
    }
    case "page.audit": {
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      // Extract design tokens: colors, fonts, spacing, images, contrast issues.
      // Runs as a single executeScript in the page's MAIN world — no debugger needed.
      const results = await executeScriptTimed({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: () => {
          const all = [];
          const els = document.querySelectorAll("*");
          const colorSet = new Set();
          const bgSet = new Set();
          const fontSet = new Map();
          const sizeSet = new Set();
          const imgSet = new Set();
          let contrastIssues = 0;
          for (const el of els) {
            const s = getComputedStyle(el);
            if (s.color && s.color !== "rgba(0, 0, 0, 0)") colorSet.add(s.color);
            if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") bgSet.add(s.backgroundColor);
            if (s.fontFamily) { const f = s.fontFamily.split(",")[0].trim().replace(/["']/g, ""); if (f) { fontSet.set(f, (fontSet.get(f) || 0) + 1); } }
            if (s.fontSize) sizeSet.add(s.fontSize);
            if (el.tagName === "IMG" && el.src) imgSet.add(el.src);
          }
          function toHex(color) {
            const m = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (!m) return color;
            return "#" + [1, 2, 3].map(i => parseInt(m[i]).toString(16).padStart(2, "0")).join("");
          }
          function contrastRatio(fg, bg) {
            const m1 = fg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            const m2 = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (!m1 || !m2) return 999;
            function lum(r, g, b) {
              [r, g, b] = [r, g, b].map(c => { c /= 255; return c <= 0.039 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
              return 0.2126 * r + 0.7152 * g + 0.0722 * b;
            }
            const l1 = lum(+m1[1], +m1[2], +m1[3]);
            const l2 = lum(+m2[1], +m2[2], +m2[3]);
            return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          }
          // Check text contrast on first 200 elements
          let checked = 0;
          for (const el of els) {
            if (checked++ > 200) break;
            const s = getComputedStyle(el);
            if (el.textContent && el.textContent.trim() && s.fontSize) {
              const r = contrastRatio(s.color, s.backgroundColor === "rgba(0, 0, 0, 0)" ? "rgb(255,255,255)" : s.backgroundColor);
              if (r < 4.5) contrastIssues++;
            }
          }
          return {
            colors: [...colorSet].slice(0, 30).map(toHex),
            backgrounds: [...bgSet].slice(0, 20).map(toHex),
            fonts: [...fontSet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f, c]) => ({ family: f, count: c })),
            fontSizes: [...sizeSet].slice(0, 15),
            imageCount: imgSet.size,
            images: [...imgSet].slice(0, 10),
            contrastIssues: contrastIssues,
            totalElements: els.length,
            headings: [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].slice(0, 30).map(h => ({ level: parseInt(h.tagName[1]), text: (h.textContent || "").trim().slice(0, 80) })),
            forms: [...document.querySelectorAll("input,textarea,select,button")].slice(0, 30).map(el => ({ tag: el.tagName, type: el.type, label: el.labels?.[0]?.textContent?.trim().slice(0, 40) || el.getAttribute("aria-label") || "", placeholder: el.placeholder, required: el.required, invalid: el.getAttribute("aria-invalid") === "true" || el.validity?.valid === false })),
            links: [...document.querySelectorAll("a[href]")].slice(0, 50).map(a => ({ text: (a.textContent || "").trim().slice(0, 50), href: a.href.slice(0, 100) })),
            cssVars: (() => { const vars = {}; const sheets = document.styleSheets; for (const sheet of sheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText === ":root" || rule.selectorText === "html") { for (let i = 0; i < rule.style.length; i++) { const p = rule.style[i]; if (p.startsWith("--")) vars[p] = rule.style.getPropertyValue(p).trim(); } } } } catch {} } return Object.entries(vars).slice(0, 50).map(([k, v]) => ({ name: k, value: v })); })(),
            webVitals: (() => { const entries = performance.getEntriesByType("navigation"); const nav = entries[0] || {}; const paint = performance.getEntriesByType("paint"); const fcp = paint.find(p => p.name === "first-contentful-paint"); const lcp = performance.getEntriesByType("largest-contentful-paint"); const lastLcp = lcp[lcp.length - 1]; const cls = performance.getEntriesByType("layout-shift").reduce((s, e) => s + (e.value || 0), 0); return { ttfb: Math.round(nav.responseStart || 0), domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0), loadComplete: Math.round(nav.loadEventEnd || 0), fcp: fcp ? Math.round(fcp.startTime) : null, lcp: lastLcp ? Math.round(lastLcp.startTime) : null, cls: Math.round(cls * 10000) / 10000 }; })(),
            zindex: [...document.querySelectorAll("*")].filter(el => { const z = getComputedStyle(el).zIndex; return z !== "auto" && z !== "0"; }).slice(0, 30).map(el => { const s = getComputedStyle(el); return { tag: el.tagName, zIndex: s.zIndex, position: s.position, id: el.id || undefined, class: el.className?.toString?.()?.slice?.(0, 40) || undefined }; }),
            spacing: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); for (const p of ["margin-top","margin-right","margin-bottom","margin-left","padding-top","padding-right","padding-bottom","padding-left","gap"]) { const v = s.getPropertyValue(p); if (v && v !== "0px" && v !== "0" && v !== "auto") m.set(v, (m.get(v) || 0) + 1); } } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).map(([value, count]) => ({ value, count })); })(),
            borderRadius: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const v = getComputedStyle(el).borderRadius; if (v && v !== "0px" && v !== "0" && v !== "none") m.set(v, (m.get(v) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, count]) => ({ value, count })); })(),
            shadows: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const v = getComputedStyle(el).boxShadow; if (v && v !== "none") m.set(v, (m.get(v) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, count]) => ({ value, count })); })(),
            transitions: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const v = getComputedStyle(el).transition; if (v && v !== "all 0s ease 0s" && v !== "none") m.set(v, (m.get(v) || 0) + 1); } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count })); })(),
            mediaQueries: (() => { const mqs = new Set(); for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media) mqs.add(rule.cssText.split("{")[0].trim()); } } catch {} } return [...mqs].slice(0, 20); })(),
            ariaIssues: (() => { const issues = []; for (const el of document.querySelectorAll("[role],button,a,input,select,textarea,img,svg,[aria-label],[aria-labelledby],[aria-describedby]")) { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || el.getAttribute("aria-hidden") === "true") continue; const tag = el.tagName; const role = el.getAttribute("role"); if (tag === "IMG" && !el.alt && !el.getAttribute("aria-label")) issues.push({ tag, role, issue: "missing alt text" }); if (tag === "BUTTON" && !el.textContent?.trim() && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby")) issues.push({ tag, role, issue: "button with no accessible name" }); if (tag === "A" && !el.textContent?.trim() && !el.getAttribute("aria-label") && el.querySelector("img") && !el.querySelector("img")?.alt) issues.push({ tag, role, issue: "link with image but no text/alt" }); if (el.getAttribute("aria-label") === "") issues.push({ tag, id: el.id, role, issue: "empty aria-label" }); if (role === "checkbox" || role === "radio" || role === "switch") { if (!el.getAttribute("aria-checked")) issues.push({ tag, id: el.id, role, issue: "missing aria-checked" }); } } return issues.slice(0, 30); })(),
            tapTargets: (() => { const targets = []; for (const el of document.querySelectorAll("button,a[href],input,select,textarea,[role=button],[role=link],[role=checkbox],[role=radio],[tabindex]")) { const s = getComputedStyle(el); if (s.display === "none" || s.visibility === "hidden" || s.pointerEvents === "none") continue; const r = el.getBoundingClientRect(); if (r.width === 0 || r.height === 0) continue; const minSize = 44; const tooSmall = r.width < minSize || r.height < minSize; targets.push({ tag: el.tagName, type: el.type || undefined, text: (el.textContent || "").trim().slice(0, 30) || el.getAttribute("aria-label") || "", width: Math.round(r.width), height: Math.round(r.height), tooSmall, suggestion: tooSmall ? `expand to at least ${minSize}x${minSize}px` : undefined }); } return targets.filter(t => t.tooSmall).slice(0, 20); })(),
            gradients: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); for (const p of ["backgroundImage","background"]) { const v = s.getPropertyValue(p); if (v && v.includes("gradient")) { const g = v.match(/(linear|radial|conic)-gradient\([^)]+\)/g); if (g) for (const grad of g) m.set(grad, (m.get(grad) || 0) + 1); } } } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([value, count]) => ({ value, count })); })(),
            fontWeights: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const w = getComputedStyle(el).fontWeight; if (w && w !== "400" && w !== "normal") m.set(w, (m.get(w) || 0) + 1); } m.set("400", (m.get("400") || 0) + 1); return [...m.entries()].sort((a, b) => parseInt(a[0]) - parseInt(b[0])).map(([weight, count]) => ({ weight, count })); })(),
            focusOrder: (() => { const focusable = document.querySelectorAll("a[href],button,input,select,textarea,[tabindex]:not([tabindex=\"-1\"]),[contenteditable]"); return [...focusable].filter(el => { const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && !el.disabled; }).slice(0, 40).map((el, i) => ({ order: i + 1, tag: el.tagName, text: (el.textContent || "").trim().slice(0, 30) || el.getAttribute("aria-label") || el.placeholder || "", type: el.type || undefined, tabindex: el.tabIndex > 0 ? el.tabIndex : undefined })); })(),
            animations: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const anim = s.animation; const dur = s.animationDuration; if (anim && anim !== "none" && dur && dur !== "0s") { const key = anim.split(",")[0].trim().slice(0, 60); m.set(key, (m.get(key) || 0) + 1); } } return [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count })); })(),
            imageAudit: (() => { const imgs = [...document.querySelectorAll("img")]; return { total: imgs.length, missingDimensions: imgs.filter(i => !i.width || !i.height).length, missingAlt: imgs.filter(i => !i.alt).length, lazyLoaded: imgs.filter(i => i.loading === "lazy").length, withoutExplicitSize: imgs.filter(i => !i.getAttribute("width") || !i.getAttribute("height")).length, large: imgs.filter(i => { const r = i.getBoundingClientRect(); return r.width > 2000 || r.height > 2000; }).map(i => ({ src: i.src.slice(0, 80), w: Math.round(i.getBoundingClientRect().width), h: Math.round(i.getBoundingClientRect().height) })).slice(0, 5) }; })(),
            semanticAudit: (() => { const issues = []; if (!document.querySelector("main, [role=main]")) issues.push("missing <main> or role=main"); if (!document.querySelector("header, [role=banner]")) issues.push("missing <header> or role=banner"); if (!document.querySelector("footer, [role=contentinfo]")) issues.push("missing <footer> or role=contentinfo"); if (!document.querySelector("nav, [role=navigation]")) issues.push("missing <nav> or role=navigation"); if (!document.querySelector("h1")) issues.push("missing <h1>"); if (document.querySelectorAll("h1").length > 1) issues.push("multiple <h1> elements"); if (!document.querySelector("main, [role=main]")?.querySelector("h2, h3")) issues.push("no headings inside <main>"); const divsAsButtons = document.querySelectorAll("div[onclick], span[onclick]").length; if (divsAsButtons > 0) issues.push(`${divsAsButtons} div/span with onclick — use <button> instead`); const inputsNoLabel = [...document.querySelectorAll("input,select,textarea")].filter(el => !el.labels?.[0] && !el.getAttribute("aria-label") && !el.getAttribute("aria-labelledby") && el.type !== "hidden").length; if (inputsNoLabel > 0) issues.push(`${inputsNoLabel} form fields without labels`); return issues; })(),
            metaTags: (() => { const get = (sel, attr) => document.querySelector(sel)?.getAttribute(attr) || document.querySelector(sel)?.textContent?.trim() || null; return { title: document.title, description: get("meta[name=description]", "content"), viewport: get("meta[name=viewport]", "content"), charset: get("meta[charset]", "charset"), ogTitle: get("meta[property='og:title']", "content"), ogDescription: get("meta[property='og:description']", "content"), ogImage: get("meta[property='og:image']", "content"), twitterCard: get("meta[name=twitter:card]", "content"), twitterTitle: get("meta[name=twitter:title]", "content"), twitterImage: get("meta[name=twitter:image]", "content"), canonical: get("link[rel=canonical]", "href"), themeColor: get("meta[name='theme-color']", "content"), favicon: get("link[rel~=icon]", "href") }; })(),
            tables: (() => { const tables = [...document.querySelectorAll("table")]; return tables.slice(0, 10).map(t => { const hasCaption = !!t.querySelector("caption"); const hasThead = !!t.querySelector("thead"); const hasScope = !!t.querySelector("[scope]"); const rows = t.querySelectorAll("tr").length; const cols = t.querySelector("tr")?.querySelectorAll("th,td").length || 0; return { rows, cols, hasCaption, hasThead, hasScope, issue: !hasCaption && !hasThead ? "missing caption and thead" : !hasScope && hasThead ? "th elements missing scope attribute" : undefined }; }); })(),
            layoutAudit: (() => { const m = { flex: 0, grid: 0, block: 0, inline: 0, inlineBlock: 0, none: 0, table: 0, contents: 0, other: 0 }; for (const el of document.querySelectorAll("*")) { const d = getComputedStyle(el).display; if (d.startsWith("flex")) m.flex++; else if (d.startsWith("grid")) m.grid++; else if (d === "block") m.block++; else if (d === "inline") m.inline++; else if (d === "inline-block") m.inlineBlock++; else if (d === "none") m.none++; else if (d.startsWith("table")) m.table++; else if (d === "contents") m.contents++; else m.other++; } return m; })(),
            positionAudit: (() => { const m = { static: 0, relative: 0, absolute: 0, fixed: 0, sticky: 0 }; for (const el of document.querySelectorAll("*")) { const p = getComputedStyle(el).position; if (m[p] !== undefined) m[p]++; } return m; })(),
            darkMode: (() => { const mqs = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media && /prefers-color-scheme/.test(rule.media.mediaText)) mqs.push(rule.media.mediaText.trim()); } } catch {} } const darkVars = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText && /dark|\.dark|\[data-theme.*dark/i.test(rule.selectorText)) { const props = []; for (let i = 0; i < rule.style.length; i++) { const p = rule.style[i]; if (p.startsWith("--")) props.push(`${p}: ${rule.style.getPropertyValue(p).trim()}`); } if (props.length) darkVars.push({ selector: rule.selectorText, vars: props.slice(0, 10) }); } } } catch {} } return { hasMediaQuery: mqs.length > 0, mediaQueries: mqs, hasDarkVars: darkVars.length > 0, darkVarCount: darkVars.reduce((s, d) => s + d.vars.length, 0), darkSelectors: darkVars.slice(0, 5).map(d => d.selector) }; })(),
            typographyDetails: (() => { const lh = new Map(); const ls = new Map(); const wt = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (el.textContent?.trim()) { const l = s.lineHeight; if (l && l !== "normal") lh.set(l, (lh.get(l) || 0) + 1); const sp = s.letterSpacing; if (sp && sp !== "normal" && sp !== "0px") ls.set(sp, (ls.get(sp) || 0) + 1); const ws = s.wordSpacing; if (ws && ws !== "normal" && ws !== "0px") ls.set(`word:${ws}`, (ls.get(`word:${ws}`) || 0) + 1); } } return { lineHeights: [...lh.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count })), letterSpacing: [...ls.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([value, count]) => ({ value, count })) }; })(),
            colorFormats: (() => { const m = { hex: 0, rgb: 0, rgba: 0, hsl: 0, hsla: 0, named: 0, other: 0 }; const all = [...colorSet, ...bgSet]; for (const c of all) { if (/^#/.test(c)) m.hex++; else if (/^rgba\(/.test(c)) m.rgba++; else if (/^rgb\(/.test(c)) m.rgb++; else if (/^hsla\(/.test(c)) m.hsla++; else if (/^hsl\(/.test(c)) m.hsl++; else if (c) m.named++; } return m; })(),
            breakpoints: (() => { const bps = new Set(); for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media) { const m = rule.media.mediaText.match(/\(\s*(?:min|max)-(?:width|height)\s*:\s*(\d+)px\s*\)/g); if (m) for (const match of m) bps.add(match.replace(/\s/g, "")); } } } catch {} } return [...bps].sort((a, b) => parseInt(a.match(/(\d+)px/)?.[1] || 0) - parseInt(b.match(/(\d+)px/)?.[1] || 0)); })(),
            flexGridAudit: (() => { const flex = []; const grid = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.display.startsWith("flex") && el.children.length > 1) { flex.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 40) || undefined, direction: s.flexDirection, justify: s.justifyContent, align: s.alignItems, gap: s.gap, wrap: s.flexWrap, children: el.children.length }); if (flex.length >= 15) break; } if (s.display.startsWith("grid") && el.children.length > 1) { grid.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 40) || undefined, columns: s.gridTemplateColumns?.slice(0, 60), rows: s.gridTemplateRows?.slice(0, 60), gap: s.gap, children: el.children.length }); if (grid.length >= 15) break; } } return { flexContainers: flex, gridContainers: grid }; })(),
            hiddenContent: (() => { const hidden = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if ((s.display === "none" || s.visibility === "hidden" || s.clipPath === "inset(50%)" || (parseInt(s.width) === 0 && parseInt(s.height) === 0 && s.overflow === "hidden")) && el.textContent?.trim()) { hidden.push({ tag: el.tagName, id: el.id || undefined, class: el.className?.toString?.()?.slice?.(0, 40) || undefined, method: s.display === "none" ? "display:none" : s.visibility === "hidden" ? "visibility:hidden" : "clip/size:0", textPreview: el.textContent.trim().slice(0, 40) }); if (hidden.length >= 20) break; } } return hidden; })(),
            viewportIssues: (() => { const issues = []; const vw = window.innerWidth; const vh = window.innerHeight; const scrollX = window.scrollX; const scrollY = window.scrollY; const scrollWidth = document.documentElement.scrollWidth; const scrollHeight = document.documentElement.scrollHeight; if (scrollWidth > vw + 5) issues.push({ issue: "horizontal scroll", scrollWidth, viewportWidth: vw, overflow: scrollWidth - vw }); if (document.documentElement.scrollWidth > document.body.scrollWidth + 5) issues.push({ issue: "possible width overflow on html element" }); const fixedElements = [...document.querySelectorAll("*")].filter(el => getComputedStyle(el).position === "fixed"); if (fixedElements.length > 5) issues.push({ issue: `${fixedElements.length} fixed-position elements (potential mobile overlap)` }); const oversizedImgs = [...document.querySelectorAll("img")].filter(img => { const r = img.getBoundingClientRect(); return r.width > vw; }); if (oversizedImgs.length) issues.push({ issue: `${oversizedImgs.length} images wider than viewport`, images: oversizedImgs.slice(0, 3).map(i => i.src.slice(0, 60)) }); return { viewportWidth: vw, viewportHeight: vh, issues }; })(),
            inputModes: (() => { return [...document.querySelectorAll("input")].slice(0, 30).map(el => { const type = el.type; const expected = { email: "email", tel: "tel", url: "url", number: "numeric", search: "search" }[type]; const hasPattern = !!el.getAttribute("pattern"); const hasAutoComplete = el.getAttribute("autocomplete"); return { type, name: el.name || undefined, label: el.labels?.[0]?.textContent?.trim().slice(0, 30) || el.getAttribute("aria-label") || undefined, inputMode: el.getAttribute("inputmode"), autocomplete: hasAutoComplete || undefined, missingInputMode: expected && el.getAttribute("inputmode") === null, missingAutocomplete: !hasAutoComplete }; }).filter(i => i.missingInputMode || i.missingAutocomplete); })(),
            scriptAudit: (() => { const scripts = [...document.querySelectorAll("script")]; return { total: scripts.length, external: scripts.filter(s => s.src).length, inline: scripts.filter(s => !s.src).length, async: scripts.filter(s => s.async).length, defer: scripts.filter(s => s.defer).length, module: scripts.filter(s => s.type === "module").length, inlineSize: scripts.filter(s => !s.src).reduce((sum, s) => sum + (s.textContent?.length || 0), 0), sources: scripts.filter(s => s.src).slice(0, 10).map(s => ({ src: s.src.slice(0, 80), async: s.async || undefined, defer: s.defer || undefined, type: s.type || undefined })) }; })(),
            iframeAudit: (() => { const iframes = [...document.querySelectorAll("iframe")]; return { total: iframes.length, sandboxed: iframes.filter(f => f.hasAttribute("sandbox")).length, crossOrigin: iframes.filter(f => { try { return f.src && new URL(f.src).origin !== location.origin; } catch { return false; } }).length, missingTitle: iframes.filter(f => !f.title).length, list: iframes.slice(0, 10).map(f => ({ src: (f.src || "").slice(0, 60), sandbox: f.getAttribute("sandbox") || undefined, title: f.title || undefined, width: f.width || undefined, height: f.height || undefined })) }; })(),
            deprecatedHtml: (() => { const tags = ["font","center","marquee","blink","strike","tt","big","small","frame","frameset","nobr","dir","listing","plaintext","xmp","acronym","applet","basefont","isindex","keygen","spacer"]; const found = []; for (const tag of tags) { const els = document.querySelectorAll(tag); if (els.length) found.push({ tag, count: els.length }); } return found; })(),
            csp: (() => { const meta = document.querySelector("meta[http-equiv='Content-Security-Policy']"); return { hasCspMeta: !!meta, policy: meta?.getAttribute("content")?.slice(0, 200) || null, hasXFrameOptions: !!document.querySelector("meta[http-equiv='X-Frame-Options']"), hasReferrerPolicy: !!document.querySelector("meta[name='referrer']") }; })(),
            classPatterns: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const cls = el.className?.toString?.(); if (cls && cls.trim()) { for (const c of cls.trim().split(/\s+/)) { if (c.length > 2) m.set(c, (m.get(c) || 0) + 1); } } } return [...m.entries()].filter(([_, c]) => c > 2).sort((a, b) => b[1] - a[1]).slice(0, 25).map(([cls, count]) => ({ class: cls, count })); })(),
            fontLoading: (() => { const faces = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("@font-face")) { const family = rule.style.getPropertyValue("font-family")?.trim().replace(/["']/g, ""); const src = rule.style.getPropertyValue("src")?.slice(0, 60); const display = rule.style.getPropertyValue("font-display"); faces.push({ family, src, display: display || "auto" }); } } } catch {} } return { totalFaces: faces.length, missingFontDisplay: faces.filter(f => f.display === "auto" || !f.display).length, faces: faces.slice(0, 10) }; })(),
            importantAudit: (() => { let count = 0; const rules = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (text.includes("!important")) { count += (text.match(/!important/g) || []).length; if (rules.length < 5) rules.push(rule.selectorText?.slice(0, 60)); } } } catch {} } return { count, topSelectors: rules }; })(),
            negativeMargins: (() => { const found = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const props = ["margin-top","margin-right","margin-bottom","margin-left"]; for (const p of props) { const v = s.getPropertyValue(p); if (v && v.startsWith("-") && !v.startsWith("-0")) { found.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, property: p, value: v }); if (found.length >= 15) return found; break; } } } return found; })(),
            inlineStyles: (() => { const els = [...document.querySelectorAll("[style]")]; return { count: els.length, samples: els.slice(0, 8).map(el => ({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, style: el.getAttribute("style")?.slice(0, 80) })) }; })(),
            pseudoElements: (() => { let before = 0, after = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText?.includes("::before") || rule.selectorText?.includes(":before")) before++; if (rule.selectorText?.includes("::after") || rule.selectorText?.includes(":after")) after++; } } catch {} } return { beforeCount: before, afterCount: after, total: before + after }; })(),
            scrollContainers: (() => { const containers = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const ov = s.overflow + " " + s.overflowY + " " + s.overflowX; if (/scroll|auto/.test(ov) && el.scrollHeight > el.clientHeight + 5) { containers.push({ tag: el.tagName, id: el.id || undefined, class: el.className?.toString?.()?.slice?.(0, 40) || undefined, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, overflowY: s.overflowY, canScroll: el.scrollHeight > el.clientHeight }); if (containers.length >= 15) break; } } return containers; })(),
            aspectRatioCheck: (() => { const issues = []; for (const el of document.querySelectorAll("img,video,embed,object")) { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); const hasExplicitRatio = s.aspectRatio && s.aspectRatio !== "auto"; const hasWidthAttr = el.getAttribute("width"); const hasHeightAttr = el.getAttribute("height"); if (!hasExplicitRatio && !hasWidthAttr && !hasHeightAttr && r.width > 50) { issues.push({ tag: el.tagName, src: (el.src || el.data || "").slice(0, 60), width: Math.round(r.width), height: Math.round(r.height), risk: "no aspect-ratio or explicit dimensions — CLS risk" }); if (issues.length >= 15) break; } } return issues; })(),
            colorPalette: (() => { const m = new Map(); for (const c of [...colorSet, ...bgSet]) { let hex = c; const mt = c.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (mt) hex = "#" + [1,2,3].map(i => parseInt(mt[i]).toString(16).padStart(2,"0")).join(""); if (/^#/.test(hex)) { const key = hex.toLowerCase().slice(0, 7); m.set(key, (m.get(key) || 0) + 1); } } const sorted = [...m.entries()].sort((a,b) => b[1]-a[1]); const groups = { grays: [], blues: [], greens: [], reds: [], yellows: [], purples: [], oranges: [], others: [] }; for (const [hex, count] of sorted) { const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16); const max = Math.max(r,g,b), min = Math.min(r,g,b); const isGray = max - min < 20; if (isGray) groups.grays.push({hex,count}); else if (b > r && b > g) groups.blues.push({hex,count}); else if (g > r && g > b) groups.greens.push({hex,count}); else if (r > g && r > b && g > 100) groups.oranges.push({hex,count}); else if (r > g && r > b) groups.reds.push({hex,count}); else if (r > 150 && g > 150 && b < 100) groups.yellows.push({hex,count}); else if (r > 100 && b > 100 && g < 100) groups.purples.push({hex,count}); else groups.others.push({hex,count}); } return { total: sorted.length, groups }; })(),
            eventHandlers: (() => { let inline = 0; const attrs = ["onclick","onload","onerror","onmouseover","onmouseout","onsubmit","onchange","oninput","onkeydown","onkeyup","onfocus","onblur"]; for (const el of document.querySelectorAll("*")) for (const a of attrs) if (el.hasAttribute(a)) inline++; return { inlineCount: inline, attributes: attrs.filter(a => document.querySelector(`[${a}]`)) }; })(),
            cssSize: (() => { let total = 0; let ruleCount = 0; const files = []; for (const sheet of document.styleSheets) { try { let size = 0; for (const rule of sheet.cssRules) { size += (rule.cssText || "").length; ruleCount++; } total += size; if (sheet.href) files.push({ href: sheet.href.slice(0, 80), size }); } catch { if (sheet.href) files.push({ href: sheet.href.slice(0, 80), blocked: true }); } } return { totalRules: ruleCount, estimatedSizeChars: total, files: files.slice(0, 10) }; })(),
            buttonStyles: (() => { const btns = [...document.querySelectorAll("button, [role=button], input[type=submit], input[type=button], a.btn, a.button, .btn, .button")]; return btns.slice(0, 15).map(el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { tag: el.tagName, text: (el.textContent || el.value || "").trim().slice(0, 20) || el.getAttribute("aria-label") || "", bg: s.backgroundColor, color: s.color, borderRadius: s.borderRadius, padding: s.padding, fontSize: s.fontSize, fontWeight: s.fontWeight, cursor: s.cursor, width: Math.round(r.width), height: Math.round(r.height) }; }); })(),
            linkStyles: (() => { const links = [...document.querySelectorAll("a[href]")]; const styles = new Map(); for (const a of links) { const s = getComputedStyle(a); const key = `${s.color}|${s.textDecoration}|${s.fontWeight}`; styles.set(key, (styles.get(key) || 0) + 1); } return [...styles.entries()].sort((a,b) => b[1]-a[1]).slice(0, 8).map(([key, count]) => { const [color, decoration, weight] = key.split("|"); return { color, textDecoration: decoration, fontWeight: weight, count }; }); })(),
            nestingDepth: (() => { const deep = []; const walk = (el, depth, path) => { if (depth > 8 && el.children.length) { const tags = path.split(" > ").slice(-4).join(" > "); deep.push({ depth, tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, path: tags }); if (deep.length >= 10) return; } for (const c of el.children) walk(c, depth + 1, path + " > " + c.tagName); }; walk(document.body, 0, document.body.tagName); return deep.sort((a,b) => b.depth - a.depth).slice(0, 10); })(),
            headingHierarchy: (() => { const hs = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]; const issues = []; let prevLevel = 0; for (const h of hs) { const level = parseInt(h.tagName[1]); if (prevLevel && level > prevLevel + 1) issues.push({ issue: `skipped from h${prevLevel} to h${level}`, text: (h.textContent || "").trim().slice(0, 40) }); if (prevLevel && level === prevLevel && level === 1) issues.push({ issue: "multiple h1", text: (h.textContent || "").trim().slice(0, 40) }); prevLevel = level; } return { total: hs.length, issues }; })(),
            overflowAudit: (() => { const issues = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.overflow === "hidden" || s.overflowX === "hidden" || s.overflowY === "hidden") { const r = el.getBoundingClientRect(); if (r.width < 20 || r.height < 20) continue; const sw = el.scrollWidth, sh = el.scrollHeight; if (sw > el.clientWidth + 2 || sh > el.clientHeight + 2) { issues.push({ tag: el.tagName, id: el.id || undefined, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, clipped: `${el.clientWidth}x${el.clientHeight}`, content: `${sw}x${sh}`, direction: sw > el.clientWidth ? "horizontal" : "vertical" }); if (issues.length >= 15) break; } } } return issues; })(),
            unusedClasses: (() => { const defined = new Set(); for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText) { const matches = rule.selectorText.match(/\.([a-zA-Z_-][\w-]*)/g); if (matches) for (const m of matches) defined.add(m.slice(1)); } } } catch {} } const used = new Set(); for (const el of document.querySelectorAll("*")) { const cls = el.className?.toString?.(); if (cls) for (const c of cls.trim().split(/\s+/)) used.add(c); } const unused = [...defined].filter(c => !used.has(c) && c.length > 2); return { defined: defined.size, used: used.size, unusedCount: unused.length, unused: unused.slice(0, 20) }; })(),
            formLayout: (() => { const forms = [...document.querySelectorAll("form")]; return forms.slice(0, 10).map(f => { const inputs = [...f.querySelectorAll("input,select,textarea")]; const labels = [...f.querySelectorAll("label")]; const hasFieldset = !!f.querySelector("fieldset"); const hasLegend = !!f.querySelector("legend"); const display = getComputedStyle(f).display; const layout = [...inputs].map(i => { const s = getComputedStyle(i.closest("label,div,p,li") || i); return s.display; }); return { fields: inputs.length, labels: labels.length, hasFieldset, hasLegend, formDisplay: display, inputWrappers: [...new Set(layout)] }; }); })(),
            pointerEvents: (() => { const issues = []; for (const el of document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link]")) { const s = getComputedStyle(el); if (s.pointerEvents === "none") issues.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30), issue: "pointer-events:none on interactive element" }); } return issues; })(),
            borderAudit: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const w = s.borderWidth; const st = s.borderStyle; const c = s.borderColor; if (st !== "none" && st !== "initial" && parseFloat(w) > 0) { const key = `${w} ${st} ${c}`; m.set(key, (m.get(key) || 0) + 1); } } return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, 15).map(([value, count]) => ({ value, count })); })(),
            opacityTransform: (() => { const op = []; const tr = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const o = parseFloat(s.opacity); if (o < 1 && o > 0) op.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, opacity: o }); if (s.transform && s.transform !== "none") tr.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, transform: s.transform.slice(0, 60) }); if (op.length >= 15 && tr.length >= 15) break; } return { opacityElements: op.slice(0, 15), transformElements: tr.slice(0, 15) }; })(),
            responsiveImages: (() => { const imgs = [...document.querySelectorAll("img")]; return { total: imgs.length, withSrcset: imgs.filter(i => i.srcset).length, withSizes: imgs.filter(i => i.sizes).length, inPicture: imgs.filter(i => i.closest("picture")).length, missingSrcset: imgs.filter(i => !i.srcset && i.width > 400).length, missingSizes: imgs.filter(i => i.srcset && !i.sizes).length }; })(),
            containerQueries: (() => { let count = 0; const containers = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("@container")) { count++; if (containers.length < 5) containers.push(rule.cssText.slice(0, 60)); } if (rule.containerType || rule.cssText?.includes("container-type")) { if (containers.length < 5) containers.push(rule.selectorText?.slice(0, 40) || "unknown"); } } } catch {} } return { count, samples: containers }; })(),
            printStyles: (() => { let hasPrint = false; let rules = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media && /print/.test(rule.media.mediaText)) { hasPrint = true; rules += rule.cssRules?.length || 0; } } } catch {} } return { hasPrintStyles: hasPrint, estimatedRules: rules }; })(),
            willChange: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const wc = s.willChange; if (wc && wc !== "auto") items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, willChange: wc.slice(0, 40) }); if (items.length >= 15) break; } return items; })(),
            focusStyles: (() => { const focusable = [...document.querySelectorAll("a,button,input,select,textarea,[tabindex]:not([tabindex=\"-1\"]),[contenteditable]")].filter(el => { const s = getComputedStyle(el); return s.display !== "none" && s.visibility !== "hidden" && !el.disabled; }); let hasOutline = 0, hasOutlineNone = 0, hasBoxShadow = 0, noFocusIndicator = 0; for (const el of focusable.slice(0, 50)) { const s = getComputedStyle(el); if (s.outlineStyle !== "none" && parseInt(s.outlineWidth) > 0) hasOutline++; else if (s.outlineStyle === "none") { if (/focus/.test(s.boxShadow)) hasBoxShadow++; else noFocusIndicator++; } } return { focusableCount: focusable.length, withOutline: hasOutline, withBoxShadowFocus: hasBoxShadow, noIndicator: noFocusIndicator }; })(),
            hoverStates: (() => { let count = 0; const samples = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText && /:hover/.test(rule.selectorText) && !/:focus/.test(rule.selectorText)) { count++; if (samples.length < 8) samples.push(rule.selectorText.slice(0, 50)); } } } catch {} } return { hoverRules: count, hasFocusVisible: (() => { for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText && /:focus-visible/.test(rule.selectorText)) return true; } } catch {} } return false; })(), samples }; })(),
            reducedMotion: (() => { let hasRule = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media && /prefers-reduced-motion/.test(rule.media.mediaText)) { hasRule = true; break; } } } catch {} } return { hasReducedMotion: hasRule }; })(),
            readingWidth: (() => { const text = [...document.querySelectorAll("p,article,section,.content,.prose,[role=main]")].filter(el => { const r = el.getBoundingClientRect(); return r.width > 100 && el.textContent?.trim().length > 50; }).slice(0, 10); return text.map(el => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); const fontSize = parseFloat(s.fontSize); const charWidth = fontSize * 0.5; const charsPerLine = Math.round(r.width / charWidth); const optimal = charsPerLine >= 45 && charsPerLine <= 75; return { tag: el.tagName, width: Math.round(r.width), fontSize: s.fontSize, estCharsPerLine: charsPerLine, optimal: optimal, issue: !optimal ? (charsPerLine < 45 ? "too narrow (under 45 cpl)" : "too wide (over 75 cpl)") : undefined }; }).filter(t => !t.optimal); })(),
            brokenImages: (() => { const broken = []; for (const img of [...document.querySelectorAll("img")]) { if (img.complete && img.naturalWidth === 0 && img.src) broken.push({ src: img.src.slice(0, 80), alt: img.alt || undefined }); } return broken; })(),
            specificity: (() => { const top = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (!rule.selectorText) continue; const sels = rule.selectorText.split(","); for (const sel of sels) { const ids = (sel.match(/#/g) || []).length; const classes = (sel.match(/\./g) || []).length; const attrs = (sel.match(/\[/g) || []).length; const score = ids * 100 + (classes + attrs) * 10; if (score >= 100 || sel.split(">").length > 4) { top.push({ selector: sel.trim().slice(0, 50), specificity: score, depth: sel.split(">").length }); if (top.length >= 15) break; } } } } catch {} } return top.sort((a,b) => b.specificity - a.specificity).slice(0, 10); })(),
            mixedContent: (() => { const issues = []; const isHttps = location.protocol === "https:"; if (!isHttps) return { secure: false, issues: [{ issue: "page is not served over HTTPS" }] }; for (const el of document.querySelectorAll("img[src],script[src],link[href],iframe[src],video[src],audio[src],source[src]")) { const src = el.src || el.href; if (src && src.startsWith("http://")) issues.push({ tag: el.tagName, src: src.slice(0, 80), issue: "mixed content (HTTP resource on HTTPS page)" }); } return { secure: true, issues }; })(),
            resourceHints: (() => { const hints = []; for (const el of document.querySelectorAll("link[rel]")) { const rel = el.getAttribute("rel"); if (/^(preload|prefetch|preconnect|dns-prefetch|modulepreload)$/.test(rel)) hints.push({ rel, href: (el.href || el.getAttribute("href") || "").slice(0, 60), as: el.getAttribute("as") || undefined, crossorigin: el.hasAttribute("crossorigin") }); } return { total: hints.length, hints }; })(),
            textOverflow: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.overflow === "hidden" || s.overflow === "scroll" || s.textOverflow !== "clip") { const key = `${s.textOverflow}|${s.overflow}|${s.whiteSpace}`; m.set(key, (m.get(key) || 0) + 1); } } return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, 8).map(([key, count]) => { const [to, ov, ws] = key.split("|"); return { textOverflow: to, overflow: ov, whiteSpace: ws, count }; }); })(),
            userSelect: (() => { const issues = []; for (const el of document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,span,a,li,td,th,label,blockquote,pre,code")) { const s = getComputedStyle(el); if (s.userSelect === "none" && el.textContent?.trim().length > 20) { issues.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, textPreview: el.textContent.trim().slice(0, 40) }); if (issues.length >= 15) break; } } return issues; })(),
            svgAudit: (() => { const svgs = [...document.querySelectorAll("svg")]; const imgs = [...document.querySelectorAll("img[src$='.svg']")]; return { inline: svgs.length, external: imgs.length, withAriaLabel: svgs.filter(s => s.getAttribute("aria-label")).length, withRole: svgs.filter(s => s.getAttribute("role")).length, withTitle: svgs.filter(s => s.querySelector("title")).length, withoutAccess: svgs.filter(s => !s.getAttribute("aria-label") && !s.getAttribute("aria-hidden") && !s.querySelector("title")).length }; })(),
            scrollSnap: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.scrollSnapType && s.scrollSnapType !== "none") items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, snapType: s.scrollSnapType }); if (items.length >= 10) break; } return items; })(),
            touchAction: (() => { const issues = []; for (const el of document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link],.btn,.button")) { const s = getComputedStyle(el); if (s.touchAction === "none" && !el.dataset.expectedNoTouch) issues.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, touchAction: s.touchAction }); if (issues.length >= 10) break; } return issues; })(),
            modernCss: (() => { let backdropFilter = 0, clipPath = 0, cssContain = 0, logicalProps = 0, aspectRatio = 0, contentVisibility = 0, colorMix = 0, layers = 0, viewTransitions = 0, oklch = 0; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.backdropFilter && s.backdropFilter !== "none") backdropFilter++; if (s.clipPath && s.clipPath !== "none") clipPath++; if (s.contain && s.contain !== "none") cssContain++; if (s.aspectRatio && s.aspectRatio !== "auto") aspectRatio++; if (s.contentVisibility === "auto") contentVisibility++; for (const p of ["margin-inline","margin-block","padding-inline","padding-block","inset-inline","inset-block"]) { if (s.getPropertyValue(p) !== "") { logicalProps++; break; } } } for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (text.includes("color-mix(")) colorMix++; if (text.includes("oklch(") || text.includes("lab(") || text.includes("lch(")) oklch++; if (text.includes("view-transition-name")) viewTransitions++; if (rule.cssText?.includes("@layer")) layers++; } } catch {} } return { backdropFilter, clipPath, cssContain, logicalProps, aspectRatio, contentVisibility, colorMix, oklch, layers, viewTransitions }; })(),
            filterEffects: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const f = s.filter; if (f && f !== "none") { const key = f.slice(0, 50); m.set(key, (m.get(key) || 0) + 1); } } return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10).map(([value, count]) => ({ value, count })); })(),
            objectFit: (() => { const items = []; for (const el of document.querySelectorAll("img,video,embed,object")) { const s = getComputedStyle(el); if (s.objectFit && s.objectFit !== "fill") items.push({ tag: el.tagName, objectFit: s.objectFit, objectPosition: s.objectPosition || undefined, src: (el.src || el.data || "").slice(0, 50) }); if (items.length >= 15) break; } return items; })(),
            scrollbarGutter: (() => { let hasGutter = 0, stable = 0, usingBoth = 0; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const sg = s.scrollbarGutter; if (sg && sg !== "auto") { hasGutter++; if (sg === "stable") stable++; } } return { hasGutter, stable }; })(),
            cascadeLayers: (() => { const layers = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.startsWith("@layer")) { const name = rule.cssText.match(/@layer\s+([\w-]+)/)?.[1] || "anonymous"; if (!layers.includes(name)) layers.push(name); } } } catch {} } return { count: layers.length, names: layers }; })(),
            minMaxConstraints: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const minW = s.minWidth !== "auto" ? s.minWidth : null; const maxW = s.maxWidth !== "none" ? s.maxWidth : null; if (minW || maxW) { const key = `min:${minW || "auto"} max:${maxW || "none"}`; m.set(key, (m.get(key) || 0) + 1); } } return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10).map(([value, count]) => ({ value, count })); })(),
            gapAudit: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const g = s.gap; if (g && g !== "normal" && g !== "0px" && parseFloat(g) > 0) { m.set(g, (m.get(g) || 0) + 1); } } return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, 15).map(([value, count]) => ({ value, count })); })(),
            stickyElements: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.position === "sticky") { const r = el.getBoundingClientRect(); items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, top: s.top, bottom: s.bottom !== "auto" ? s.bottom : undefined, zIndex: s.zIndex !== "auto" ? s.zIndex : undefined, width: Math.round(r.width), height: Math.round(r.height) }); if (items.length >= 15) break; } } return items; })(),
            contrastRatios: (() => { const ratios = []; for (const el of document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,span,a,td,th,label,button,li,strong,em,b")) { const s = getComputedStyle(el); if (!el.textContent?.trim()) continue; const fg = s.color; const bg = s.backgroundColor === "rgba(0, 0, 0, 0)" ? "rgb(255,255,255)" : s.backgroundColor; const m1 = fg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); const m2 = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (!m1 || !m2) continue; const lum = (r,g,b) => { [r,g,b] = [r,g,b].map(c => { c/=255; return c<=0.039?c/12.92:Math.pow((c+0.055)/1.055,2.4); }); return 0.2126*r+0.7152*g+0.0722*b; }; const l1 = lum(+m1[1],+m1[2],+m1[3]); const l2 = lum(+m2[1],+m2[2],+m2[3]); const ratio = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); if (ratio < 7) ratios.push({ tag: el.tagName, text: el.textContent.trim().slice(0, 25), fg: fg.slice(0,30), ratio: Math.round(ratio*100)/100, level: ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA Large" : "Fail" }); if (ratios.length >= 25) break; } return ratios.sort((a,b) => a.ratio - b.ratio); })(),
            customPropUsage: (() => { let total = 0; const props = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); for (let i = 0; i < s.length; i++) { const p = s[i]; const v = s.getPropertyValue(p); if (v.includes("var(")) { total++; const m = v.match(/var\(--([\w-]+)/); if (m) props.set(m[1], (props.get(m[1]) || 0) + 1); } } } return { totalUsages: total, topProps: [...props.entries()].sort((a,b) => b[1]-a[1]).slice(0, 15).map(([name, count]) => ({ name: "--"+name, count })) }; })(),
            fontSubsetting: (() => { const faces = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("@font-face")) { const family = rule.style.getPropertyValue("font-family")?.trim().replace(/["']/g, ""); const weight = rule.style.getPropertyValue("font-weight") || "400"; const style = rule.style.getPropertyValue("font-style") || "normal"; const unicodeRange = rule.style.getPropertyValue("unicode-range")?.slice(0, 60); const src = rule.style.getPropertyValue("src")?.slice(0, 50); faces.push({ family, weight, style, hasUnicodeRange: !!unicodeRange, unicodeRange, src }); } } } catch {} } return { totalFaces: faces.length, uniqueFamilies: [...new Set(faces.map(f => f.family))].length, hasSubsetting: faces.filter(f => f.hasUnicodeRange).length, faces: faces.slice(0, 12) }; })(),
            ariaRoles: (() => { const roles = new Map(); for (const el of document.querySelectorAll("[role]")) { const r = el.getAttribute("role"); roles.set(r, (roles.get(r) || 0) + 1); } return [...roles.entries()].sort((a,b) => b[1]-a[1]).map(([role, count]) => ({ role, count })); })(),
            viewportUnits: (() => { const m = { vw: 0, vh: 0, svh: 0, dvh: 0, lvh: 0, svw: 0, dvw: 0, lvw: 0, vmin: 0, vmax: 0, cqw: 0, cqh: 0, cqmin: 0, cqmax: 0, cqem: 0, percent: 0 }; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); for (const p of ["width","height","font-size","top","bottom","left","right","padding","gap","margin-top","margin-bottom"]) { const v = s.getPropertyValue(p); if (/vw/.test(v)) m.vw++; if (/vh/.test(v) && !/svh|dvh|lvh/.test(v)) m.vh++; if (/svh/.test(v)) m.svh++; if (/dvh/.test(v)) m.dvh++; if (/lvh/.test(v)) m.lvh++; if (/vmin/.test(v)) m.vmin++; if (/vmax/.test(v)) m.vmax++; if (/cqw/.test(v)) m.cqw++; if (/cqh/.test(v)) m.cqh++; if (/%/.test(v)) m.percent++; } } return m; })(),
            gridAreas: (() => { const areas = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const ta = s.gridTemplateAreas; if (ta && ta !== "none") { const r = el.getBoundingClientRect(); areas.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, areas: ta.slice(0, 80), columns: s.gridTemplateColumns?.slice(0, 60), rows: s.gridTemplateRows?.slice(0, 60), children: el.children.length, width: Math.round(r.width) }); if (areas.length >= 10) break; } } return areas; })(),
            cursorAudit: (() => { const m = new Map(); for (const el of document.querySelectorAll("a,button,input,select,textarea,[role=button],[role=link],.btn,.button,[onclick]")) { const s = getComputedStyle(el); const c = s.cursor; if (c && c !== "auto") m.set(c, (m.get(c) || 0) + 1); } const unusual = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.cursor === "pointer" && !el.matches("a,button,input,select,textarea,[role=button],[role=link],.btn,.button,[onclick]")) { unusual.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined }); if (unusual.length >= 10) break; } } return { interactiveCursors: [...m.entries()].map(([cursor, count]) => ({ cursor, count })), nonInteractivePointer: unusual }; })(),
            textTransform: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const t = s.textTransform; if (t && t !== "none" && el.textContent?.trim()) { m.set(t, (m.get(t) || 0) + 1); } } return [...m.entries()].sort((a,b) => b[1]-a[1]).map(([transform, count]) => ({ transform, count })); })(),
            customScrollbars: (() => { let webkitScrollbar = false, firefox = false; const rules = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText && /::-webkit-scrollbar/.test(rule.selectorText)) { webkitScrollbar = true; if (rules.length < 5) rules.push(rule.selectorText.slice(0, 50)); } if (rule.selectorText && /scrollbar-width/.test(rule.cssText)) firefox = true; } } catch {} } return { hasCustomScrollbar: webkitScrollbar || firefox, webkit: webkitScrollbar, firefox, rules }; })(),
            selectionStyling: (() => { let hasSelection = false; let hasMozSelection = false; let rules = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText && /::selection/.test(rule.selectorText)) { hasSelection = true; if (rules.length < 3) rules.push({ selector: rule.selectorText.slice(0, 40), bg: rule.style.backgroundColor, color: rule.style.color }); } } } catch {} } return { hasSelectionStyling: hasSelection, rules }; })(),
            stackingIsolation: (() => { let isolation = 0, backfaceHidden = 0, willChangeStack = 0; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.isolation === "isolate") isolation++; if (s.backfaceVisibility === "hidden") backfaceHidden++; } return { isolation, backfaceHidden }; })(),
            textFlow: (() => { const m = { nowrap: 0, pre: 0, preWrap: 0, preLine: 0, breakSpaces: 0, breakWord: 0, anywhere: 0, hyphensAuto: 0, hyphensNone: 0, writingModeVertical: 0, textOrientationUpright: 0, directionRtl: 0 }; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.whiteSpace === "nowrap") m.nowrap++; if (s.whiteSpace === "pre") m.pre++; if (s.whiteSpace === "pre-wrap") m.preWrap++; if (s.whiteSpace === "pre-line") m.preLine++; if (s.whiteSpace === "break-spaces") m.breakSpaces++; if (s.overflowWrap === "break-word") m.breakWord++; if (s.overflowWrap === "anywhere") m.anywhere++; if (s.hyphens === "auto") m.hyphensAuto++; if (s.writingMode && s.writingMode !== "horizontal-tb") m.writingModeVertical++; if (s.direction === "rtl") m.directionRtl++; } return m; })(),
            listStyles: (() => { const uls = [...document.querySelectorAll("ul")]; const ols = [...document.querySelectorAll("ol")]; const dls = [...document.querySelectorAll("dl")]; const none = uls.filter(u => getComputedStyle(u).listStyleType === "none").length; return { ulCount: uls.length, olCount: ols.length, dlCount: dls.length, ulWithoutMarker: none, olTypes: [...new Set(ols.map(o => getComputedStyle(o).listStyleType))], positioned: [...uls, ...ols].filter(l => getComputedStyle(l).listStylePosition === "inside").length }; })(),
            placeholderStyling: (() => { let hasPlaceholder = false; const rules = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText && /::placeholder/.test(rule.selectorText)) { hasPlaceholder = true; if (rules.length < 5) rules.push({ selector: rule.selectorText.slice(0, 40), color: rule.style.color, opacity: rule.style.opacity }); } } } catch {} } return { hasPlaceholderStyling: hasPlaceholder, rules }; })(),
            tableStrategy: (() => { const tables = [...document.querySelectorAll("table")]; return tables.slice(0, 10).map(t => { const s = getComputedStyle(t); return { layout: s.tableLayout, width: s.width, borderCollapse: s.borderCollapse, borderSpacing: s.borderSpacing, emptyCells: s.emptyCells }; }); })(),
            textRendering: (() => { const m = new Map(); for (const el of document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,span,a,td,th,label,button,li,strong,em,b,small,caption,blockquote,pre,code,dt,dd")) { const s = getComputedStyle(el); const r = s.textRendering; if (r && r !== "auto") m.set(r, (m.get(r) || 0) + 1); } const fontSmooth = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.webkitFontSmoothing && s.webkitFontSmoothing !== "auto") fontSmooth.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, smoothing: s.webkitFontSmoothing }); if (fontSmooth.length >= 10) break; } return { textRendering: [...m.entries()].map(([value, count]) => ({ value, count })), fontSmoothing: fontSmooth }; })(),
            dataAttributes: (() => { const attrs = new Map(); for (const el of document.querySelectorAll("*[data-]") ) {} for (const el of document.querySelectorAll("*")) { for (const a of el.attributes) { if (a.name.startsWith("data-")) { const key = a.name.split("-")[1]; attrs.set(key, (attrs.get(key) || 0) + 1); } } } return [...attrs.entries()].sort((a,b) => b[1]-a[1]).slice(0, 15).map(([prefix, count]) => ({ prefix: "data-" + prefix, count })); })(),
            resolutionAudit: (() => { let hasDppx = false; let hasDpi = false; let hasMinResolution = false; const queries = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media) { const t = rule.media.mediaText; if (/dppx/.test(t)) hasDppx = true; if (/dpi/.test(t)) hasDpi = true; if (/min-resolution/.test(t)) { hasMinResolution = true; if (queries.length < 5) queries.push(t.slice(0, 60)); } if (/(-webkit-)?min-device-pixel-ratio/.test(t)) { hasMinResolution = true; if (queries.length < 5) queries.push(t.slice(0, 60)); } } } } catch {} } return { hasDppx, hasDpi, hasMinResolution, queries }; })(),
            backgroundAudit: (() => { const m = { color: 0, image: 0, gradient: 0, none: 0, clip: 0 }; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const bg = s.background; const clip = s.backgroundClip; if (clip && clip !== "border-box") m.clip++; const img = s.backgroundImage; if (img && img !== "none") { if (/gradient/.test(img)) m.gradient++; else m.image++; } else if (s.backgroundColor && s.backgroundColor !== "rgba(0, 0, 0, 0)") m.color++; else m.none++; } return { ...m, backgroundClip: m.clip }; })(),
            cssFunctions: (() => { const m = { calc: 0, clamp: 0, min: 0, max: 0, var: 0, env: 0, attr: 0, abs: 0, round: 0, rem: 0, mod: 0, sin: 0, cos: 0, tan: 0, pow: 0, sqrt: 0, sign: 0 }; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; for (const fn of Object.keys(m)) { const re = new RegExp(`\\b${fn}\\(`, "g"); const c = (text.match(re) || []).length; if (c) m[fn] += c; } } } catch {} } return Object.entries(m).filter(([_, c]) => c > 0).sort((a,b) => b[1]-a[1]).map(([fn, count]) => ({ fn, count })); })(),
            preflightReset: (() => { let hasBoxSizing = false, hasMarginZero = false, hasBorderZero = false; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.boxSizing === "border-box") hasBoxSizing = true; } for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText === "*" || rule.selectorText === "*,::before,::after") { if (rule.cssText?.includes("margin: 0") || rule.cssText?.includes("margin:0")) hasMarginZero = true; if (rule.cssText?.includes("border: 0") || rule.cssText?.includes("border:0")) hasBorderZero = true; } } } catch {} } return { hasBoxSizing, hasMarginZero, hasBorderZero, likelyReset: hasBoxSizing && (hasMarginZero || hasBorderZero) }; })(),
            accordionDisclosure: (() => { const details = [...document.querySelectorAll("details")]; const dialogs = [...document.querySelectorAll("dialog")]; const popovers = [...document.querySelectorAll("[popover]")]; return { detailsCount: details.length, openDetails: details.filter(d => d.open).length, dialogCount: dialogs.length, openDialogs: dialogs.filter(d => d.open).length, popoverCount: popovers.length, hasNativeAccordion: details.length > 0, hasNativeDialog: dialogs.length > 0, hasPopoverApi: popovers.length > 0 }; })(),
            imageFormat: (() => { const m = { webp: 0, avif: 0, jpg: 0, png: 0, gif: 0, svg: 0, ico: 0, bmp: 0, other: 0 }; for (const el of document.querySelectorAll("img,source[srcset]")) { const src = el.src || el.srcset || ""; if (/\.webp/i.test(src)) m.webp++; else if (/\.avif/i.test(src)) m.avif++; else if (/\.jpe?g/i.test(src)) m.jpg++; else if (/\.png/i.test(src)) m.png++; else if (/\.gif/i.test(src)) m.gif++; else if (/\.svg/i.test(src)) m.svg++; else if (/\.ico/i.test(src)) m.ico++; else if (/\.bmp/i.test(src)) m.bmp++; else if (src) m.other++; } return m; })(),
            counterContent: (() => { let hasCounter = false; const rules = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText && (rule.cssText.includes("counter(") || rule.cssText.includes("counters("))) { hasCounter = true; if (rules.length < 5) rules.push(rule.selectorText?.slice(0, 50) || "unknown"); } } } catch {} } return { hasCounter, rules }; })(),
            whitespaceHandling: (() => { const m = { cssGap: 0, htmlSpace: 0, nbsp: 0, brTags: 0, hrTags: 0 }; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const gap = parseFloat(s.gap); if (gap > 0) m.cssGap++; } m.brTags = document.querySelectorAll("br").length; m.hrTags = document.querySelectorAll("hr").length; for (const el of document.querySelectorAll("*")) { if (el.innerHTML?.includes("&nbsp;")) { m.nbsp++; break; } } return m; })(),
            performanceBudget: (() => { const entries = performance.getEntriesByType("resource"); const byType = {}; let totalSize = 0; for (const e of entries) { const type = e.initiatorType || e.name.split(".").pop() || "other"; if (!byType[type]) byType[type] = { count: 0, size: 0 }; byType[type].count++; byType[type].size += e.transferSize || e.encodedBodySize || 0; totalSize += e.transferSize || e.encodedBodySize || 0; } const slow = entries.filter(e => e.duration > 500).sort((a,b) => b.duration - a.duration).slice(0, 5).map(e => ({ name: e.name.slice(0, 60), duration: Math.round(e.duration), size: e.transferSize || e.encodedBodySize })); return { totalResources: entries.length, totalSizeKB: Math.round(totalSize / 1024), byType, slowestRequests: slow }; })(),
            colorSchemes: (() => { const schemes = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media && /prefers-color-scheme/.test(rule.media.mediaText)) { for (const inner of (rule.cssRules || [])) { if (inner.selectorText && /--/.test(inner.cssText)) { const vars = []; for (let i = 0; i < inner.style.length; i++) { const p = inner.style[i]; if (p.startsWith("--")) vars.push(`${p}: ${inner.style.getPropertyValue(p).trim()}`); } if (vars.length) schemes.push({ selector: inner.selectorText.slice(0, 40), varCount: vars.length, vars: vars.slice(0, 5) }); } } } } } catch {} } return { count: schemes.length, schemes }; })(),
            scrollbarWidth: (() => { const outer = document.createElement("div"); outer.style.cssText = "width:100px;height:100px;overflow:scroll;position:absolute;visibility:hidden"; document.body.appendChild(outer); const inner = document.createElement("div"); inner.style.cssText = "width:100%"; outer.appendChild(inner); const width = outer.offsetWidth - inner.offsetWidth; document.body.removeChild(outer); return { scrollbarWidth: width, isOverlay: width === 0 }; })(),
            textColumns: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const cols = s.columnCount; const width = s.columnWidth; const gap = s.columnGap; const rule = s.columnRule; if ((cols !== "auto" && cols !== "1") || (width !== "auto" && parseFloat(width) > 0)) { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, columns: cols, columnWidth: width, gap, hasRule: rule !== "none" }); if (items.length >= 10) break; } } return items; })(),
            outlineOffset: (() => { let hasOffset = 0, noOffset = 0; for (const el of document.querySelectorAll("a,button,input,select,textarea,[tabindex]")) { const s = getComputedStyle(el); if (s.outlineStyle !== "none" && parseInt(s.outlineWidth) > 0) { if (s.outlineOffset !== "0px" && s.outlineOffset !== "0") hasOffset++; else noOffset++; } } return { withOffset: hasOffset, withoutOffset: noOffset, recommendation: noOffset > hasOffset ? "add outline-offset for better visibility against element borders" : undefined }; })(),
            cssCustomSelect: (() => { const selects = [...document.querySelectorAll("select")]; const custom = selects.filter(s => { const cs = getComputedStyle(s); return cs.appearance === "none" || cs.webkitAppearance === "none"; }); return { total: selects.length, customStyled: custom.length, native: selects.length - custom.length }; })(),
            subgridUsage: (() => { let count = 0; const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.gridTemplateColumns === "subgrid" || s.gridTemplateRows === "subgrid") { count++; if (items.length < 5) items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined }); } } return { count, items }; })(),
            langAndDir: (() => { const html = document.documentElement; const lang = html.getAttribute("lang"); const dir = html.getAttribute("dir") || getComputedStyle(html).direction; const hasLang = !!lang; return { lang, dir, hasLang, isRtl: dir === "rtl", issue: !hasLang ? "missing lang attribute on <html>" : undefined }; })(),
            inputWidths: (() => { return [...document.querySelectorAll("input,textarea")].slice(0, 30).map(el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { type: el.type || el.tagName, name: el.name || undefined, width: Math.round(r.width), cols: el.cols || undefined, rows: el.rows || undefined, maxWidth: s.maxWidth !== "none" ? s.maxWidth : undefined, hasExplicitWidth: s.width !== "auto", tooWide: r.width > 600, tooNarrow: r.width < 80 && el.type !== "checkbox" && el.type !== "radio" }; }).filter(i => i.tooWide || i.tooNarrow); })(),
            contentEditable: (() => { const els = [...document.querySelectorAll("[contenteditable]")]; return { count: els.length, withAriaRole: els.filter(e => e.getAttribute("role")).length, withAriaLabel: els.filter(e => e.getAttribute("aria-label") || e.getAttribute("aria-labelledby")).length, withoutLabel: els.filter(e => !e.getAttribute("aria-label") && !e.getAttribute("aria-labelledby") && !e.textContent?.trim()).length }; })(),
            prefersContrast: (() => { let hasContrast = false, hasForcedColors = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media && /prefers-contrast/.test(rule.media.mediaText)) hasContrast = true; if (rule.media && /forced-colors/.test(rule.media.mediaText)) hasForcedColors = true; } } catch {} } return { hasPrefersContrast: hasContrast, hasForcedColors: hasForcedColors }; })(),
            shapeOutside: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const shape = s.shapeOutside; if (shape && shape !== "none") { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, shape: shape.slice(0, 50), float: s.float }); if (items.length >= 10) break; } } return items; })(),
            cssNesting: (() => { let count = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText && /&/.test(rule.cssText) && /\{[^}]*&/.test(rule.cssText)) count++; } } catch {} } return { hasNesting: count > 0, nestedRules: count }; })(),
            fieldsetLegend: (() => { const fieldsets = [...document.querySelectorAll("fieldset")]; const groups = [...document.querySelectorAll("[role=group],[role=radiogroup]")]; return { fieldsetCount: fieldsets.length, withLegend: fieldsets.filter(f => f.querySelector("legend")).length, withoutLegend: fieldsets.filter(f => !f.querySelector("legend")).length, ariaGroups: groups.length, ariaGroupsWithLabel: groups.filter(g => g.getAttribute("aria-label") || g.getAttribute("aria-labelledby")).length }; })(),
            audioVideo: (() => { const videos = [...document.querySelectorAll("video")]; const audios = [...document.querySelectorAll("audio")]; return { videos: videos.length, audios: audios.length, videosWithControls: videos.filter(v => v.controls).length, videosWithoutControls: videos.filter(v => !v.controls).length, videosWithCaptions: videos.filter(v => v.querySelector("track[kind='captions']")).length, audiosWithControls: audios.filter(a => a.controls).length, videosAutoplay: videos.filter(v => v.autoplay).length, videosMuted: videos.filter(v => v.muted).length }; })(),
            skipLinks: (() => { const links = [...document.querySelectorAll("a[href^='#']")].filter(a => { const id = a.getAttribute("href").slice(1); const target = document.getElementById(id); return target && (id === "main" || id === "content" || target.tagName === "MAIN" || target.getAttribute("role") === "main"); }); const visible = links.filter(a => { const s = getComputedStyle(a); return s.display !== "none" && s.visibility !== "hidden"; }); return { total: links.length, alwaysVisible: visible.length, hiddenUntilFocus: links.length - visible.length, hasSkipLink: links.length > 0 }; })(),
            dupIds: (() => { const ids = {}; const dups = []; for (const el of document.querySelectorAll("[id]")) { const id = el.id; if (ids[id]) { if (!dups.includes(id)) dups.push(id); } ids[id] = true; } return dups; })(),
            emptyLinks: (() => { return [...document.querySelectorAll("a")].filter(a => { const s = getComputedStyle(a); return s.display !== "none" && !a.textContent?.trim() && !a.getAttribute("aria-label") && !a.getAttribute("aria-labelledby") && !a.querySelector("img[alt]"); }).map(a => ({ href: (a.href || "").slice(0, 60), class: a.className?.toString?.()?.slice?.(0, 30) || undefined })); })(),
            liveRegions: (() => { const m = { polite: 0, assertive: 0, off: 0, other: 0 }; const items = []; for (const el of document.querySelectorAll("[aria-live]") ) { const p = el.getAttribute("aria-live"); if (p === "polite") m.polite++; else if (p === "assertive") m.assertive++; else if (p === "off") m.off++; else m.other++; if (items.length < 10) items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, live: p, atomic: el.getAttribute("aria-atomic") || undefined, relevant: el.getAttribute("aria-relevant") || undefined }); } return { ...m, total: m.polite + m.assertive + m.off + m.other, items }; })(),
            mathFunctions: (() => { const m = new Map(); for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; for (const fn of ["abs", "sign", "round", "rem", "mod", "sin", "cos", "tan", "asin", "acos", "atan", "atan2", "pow", "sqrt", "hypot", "log", "exp", "min", "max", "clamp", "calc"]) { const re = new RegExp(`\\b${fn}\\(`, "g"); const c = (text.match(re) || []).length; if (c) m.set(fn, (m.get(fn) || 0) + c); } } } catch {} } return [...m.entries()].sort((a,b) => b[1]-a[1]).map(([fn, count]) => ({ fn, count })); })(),
            anchorScrolling: (() => { let hasScrollSmooth = false, hasScrollAuto = false; const html = getComputedStyle(document.documentElement); if (html.scrollBehavior === "smooth") hasScrollSmooth = true; if (html.scrollBehavior === "auto") hasScrollAuto = true; return { scrollBehavior: html.scrollBehavior, isSmooth: hasScrollSmooth, hasScrollPaddingTop: (() => { const s = getComputedStyle(document.documentElement); return s.scrollPaddingTop !== "0px" ? s.scrollPaddingTop : undefined; })() }; })(),
            breadcrumbAudit: (() => { const nav = document.querySelector("nav[aria-label=breadcrumb], nav.breadcrumb, .breadcrumb, [aria-label=breadcrumb]"); const schema = document.querySelector("script[type='application/ld+json']"); const hasSchemaBreadcrumb = schema && /breadcrumb/i.test(schema.textContent || ""); return { hasBreadcrumbNav: !!nav, hasStructuredData: hasSchemaBreadcrumb, items: nav ? [...nav.querySelectorAll("a,span,li")].slice(0, 10).map(el => el.textContent?.trim().slice(0, 30)).filter(Boolean) : [] }; })(),
            titleHierarchy: (() => { const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]; const docTitle = document.title; const firstH1 = document.querySelector("h1")?.textContent?.trim().slice(0, 60); return { docTitle: docTitle?.slice(0, 80), firstH1: firstH1, titleMatchesH1: docTitle && firstH1 ? docTitle.includes(firstH1) || firstH1.includes(docTitle) : undefined, headingCount: headings.length, issue: !firstH1 ? "no h1 found" : docTitle && !docTitle.includes(firstH1) && !firstH1.includes(docTitle) ? "h1 and <title> don't match" : undefined }; })(),
            duplicateTracking: (() => { const analytics = []; for (const el of document.querySelectorAll("script")) { const src = el.src || ""; const text = el.textContent || ""; if (/google-analytics|gtag|googletagmanager|gtm/.test(src + text)) analytics.push({ type: "GA/GTM", src: src.slice(0, 60) }); if (/facebook|fbq|pixel/.test(src + text)) analytics.push({ type: "Facebook Pixel", src: src.slice(0, 60) }); if (/hotjar|hj/.test(src + text)) analytics.push({ type: "Hotjar", src: src.slice(0, 60) }); if (/segment|analytics\.js/.test(src + text)) analytics.push({ type: "Segment", src: src.slice(0, 60) }); if (/plausible/.test(src + text)) analytics.push({ type: "Plausible", src: src.slice(0, 60) }); if (/matomo|piwik/.test(src + text)) analytics.push({ type: "Matomo", src: src.slice(0, 60) }); } return { total: analytics.length, services: [...new Set(analytics.map(a => a.type))], scripts: analytics }; })(),
            fontSwap: (() => { let hasFout = false, hasFoIT = false, hasSizeAdjust = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("@font-face")) { if (rule.style.getPropertyValue("font-display") === "swap") hasFout = true; if (rule.style.getPropertyValue("font-display") === "block") hasFoIT = true; if (rule.style.getPropertyValue("size-adjust")) hasSizeAdjust = true; } } } catch {} } return { hasFout, hasFoIT, hasSizeAdjust, recommendation: hasFoIT ? "font-display:block causes invisible text (FOIT) — use swap for faster FCP" : undefined }; })(),
            cssCustomPropsFallback: (() => { let hasFallback = 0, noFallback = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; const varMatches = text.match(/var\(--[^)]+\)/g) || []; const fallbackMatches = text.match(/var\(--[^,]+,[^)]+\)/g) || []; noFallback += varMatches.length - fallbackMatches.length; hasFallback += fallbackMatches.length; } } catch {} } return { withFallback: hasFallback, withoutFallback: noFallback, recommendation: noFallback > hasFallback ? `${noFallback} var() calls without fallback — older browsers get no value` : undefined }; })(),
            inputWidthCols: (() => { return [...document.querySelectorAll("input,textarea")].slice(0, 30).filter(el => el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio" && el.type !== "submit" && el.type !== "button").map(el => { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); return { type: el.type || el.tagName.toLowerCase(), label: el.labels?.[0]?.textContent?.trim().slice(0, 25) || el.getAttribute("aria-label") || el.name || "", width: Math.round(r.width), height: Math.round(r.height), padding: s.padding, border: s.borderWidth !== "0px" ? `${s.borderWidth} ${s.borderStyle}` : undefined, borderRadius: s.borderRadius !== "0px" ? s.borderRadius : undefined }; }); })(),
            headingDensity: (() => { const headings = [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")]; if (!headings.length) return { count: 0 }; const body = document.body; const bodyHeight = body.scrollHeight; const sectionSize = 2000; const sections = Math.ceil(bodyHeight / sectionSize); const ratio = (headings.length / sections).toFixed(1); return { total: headings.length, pageHeight: bodyHeight, estimatedScreens: sections, headingsPerScreen: parseFloat(ratio), issue: parseFloat(ratio) > 5 ? "too many headings per screen — structure is complex" : parseFloat(ratio) < 0.5 && sections > 3 ? "too few headings for a long page — missing structural guidance" : undefined }; })(),
            listSemantics: (() => { const uls = [...document.querySelectorAll("ul")]; const ols = [...document.querySelectorAll("ol")]; const divsAsList = [...document.querySelectorAll("div")].filter(d => { const s = getComputedStyle(d); return (s.display === "flex" || s.display === "grid") && d.children.length > 2 && [...d.children].every(c => /^(DIV|SPAN|A|BUTTON)$/.test(c.tagName)) && d.querySelector("li") === null; }); return { semanticLists: uls.length + ols.length, divAsList: divsAsList.length, issue: divsAsList.length > uls.length ? `${divsAsList.length} flex/grid containers look like lists but use divs instead of ul/li — screen readers won't announce list semantics` : undefined }; })(),
            buttonVsLink: (() => { const linksAsButtons = [...document.querySelectorAll("a[href='#'], a[href='javascript:void(0)'], a[onclick]")].filter(a => !a.href || a.getAttribute("href") === "#" || a.getAttribute("href").startsWith("javascript:")); const buttonsAsNav = [...document.querySelectorAll("button")].filter(b => b.querySelector("a") || b.getAttribute("onclick")?.includes("location") || b.getAttribute("onclick")?.includes("href")); return { linksAsButtons: linksAsButtons.length, buttonsAsNav: buttonsAsNav.length, issue: linksAsButtons.length ? `${linksAsButtons.length} <a> used as button (href=# or javascript:) — use <button> for actions` : undefined }; })(),
            fileInputAudit: (() => { const inputs = [...document.querySelectorAll("input[type=file]")]; return inputs.map(el => { const s = getComputedStyle(el); return { accept: el.accept || undefined, multiple: el.multiple, capture: el.capture || undefined, hasAriaLabel: !!(el.getAttribute("aria-label") || el.labels?.[0]), width: Math.round(el.getBoundingClientRect().width) }; }); })(),
            regionLandmarks: (() => { const landmarks = []; const map = { header: "banner", nav: "navigation", main: "main", footer: "contentinfo", aside: "complementary", section: "region", article: "article", form: "form", search: "search" }; for (const [tag, role] of Object.entries(map)) { const els = document.querySelectorAll(tag + "[role=" + role + "], " + tag + ":not([role])"); const visible = [...els].filter(el => getComputedStyle(el).display !== "none"); if (visible.length) landmarks.push({ tag, role, count: visible.length }); } for (const el of document.querySelectorAll("[role=banner],[role=navigation],[role=main],[role=contentinfo],[role=complementary],[role=region],[role=search],[role=form]")) { const role = el.getAttribute("role"); const exists = landmarks.find(l => l.role === role && l.tag === el.tagName.toLowerCase()); if (!exists) landmarks.push({ tag: el.tagName.toLowerCase(), role, count: 1 }); } return landmarks; })(),
            colorScheme: (() => { const html = getComputedStyle(document.documentElement); const meta = document.querySelector("meta[name=color-scheme]"); return { cssColorScheme: html.colorScheme !== "normal" ? html.colorScheme : undefined, hasMetaTag: !!meta, metaValue: meta?.getAttribute("content") || undefined, isLight: /light/.test(html.colorScheme + (meta?.getAttribute("content") || "")), isDark: /dark/.test(html.colorScheme + (meta?.getAttribute("content") || "")) }; })(),
            reducedData: (() => { let hasRule = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media && /prefers-reduced-data/.test(rule.media.mediaText)) { hasRule = true; break; } } } catch {} } return { hasReducedData: hasRule }; })(),
            propertyRegistration: (() => { let count = 0; const props = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.startsWith("@property")) { count++; const name = rule.cssText.match(/@property\s+([\w-]+)/)?.[1]; if (props.length < 10 && name) props.push(name); } } } catch {} } return { count, props }; })(),
            scrollDrivenAnimations: (() => { let count = 0; const types = { scroll: 0, view: 0 }; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (/animation-timeline:\s*scroll/.test(text)) { count++; types.scroll++; } if (/animation-timeline:\s*view/.test(text)) { count++; types.view++; } } } catch {} } return { count, types }; })(),
            autocapitalizeAudit: (() => { return [...document.querySelectorAll("input,textarea")].slice(0, 30).filter(el => el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio").map(el => { const expected = { email: "none", tel: "characters", url: "none", password: "none", search: "sentences" }[el.type] || "sentences"; const actual = el.getAttribute("autocapitalize") || "sentences"; const autocorrect = el.getAttribute("autocorrect"); return { type: el.type || el.tagName.toLowerCase(), name: el.name || undefined, autocapitalize: actual, expected: actual === expected ? undefined : expected, autocorrect: autocorrect || undefined, issue: actual !== expected ? `autocapitalize should be ${expected} for type=${el.type}` : undefined }; }).filter(i => i.issue); })(),
            focusManagement: (() => { let autofocus = 0; let hasInert = 0; let hasHidden = 0; for (const el of document.querySelectorAll("[autofocus]")) autofocus++; for (const el of document.querySelectorAll("[inert]")) hasInert++; for (const el of document.querySelectorAll("[hidden]")) hasHidden++; const hasSkipLink = !!document.querySelector("a[href='#main'],a[href='#content']"); return { autofocusElements: autofocus, inertElements: hasInert, hiddenElements: hasHidden, hasSkipLink }; })(),
            viewportMetaDetailed: (() => { const meta = document.querySelector("meta[name=viewport]"); if (!meta) return { found: false, issue: "missing viewport meta tag" }; const content = meta.getAttribute("content") || ""; return { found: true, content, hasWidth: /width=/.test(content), hasInitialScale: /initial-scale=/.test(content), hasMaximumScale: /maximum-scale=/.test(content), hasUserScalable: /user-scalable=/.test(content), disablesZoom: /user-scalable=no/.test(content) || /maximum-scale=1/.test(content), issue: /user-scalable=no/.test(content) ? "user-scalable=no prevents zoom — WCAG 1.4.4 failure" : undefined }; })(),
            cssNestingDepth: (() => { let maxDepth = 0; let nestedCount = 0; for (const sheet of document.styleSheets) { try { const check = (rule, depth) => { if (rule.cssRules) { for (const inner of rule.cssRules) { if (inner.cssText && /&/.test(inner.cssText)) { nestedCount++; if (depth + 1 > maxDepth) maxDepth = depth + 1; check(inner, depth + 1); } else { check(inner, depth); } } } }; check(rule, 0); } catch {} } return { maxDepth, nestedCount }; })(),
            loadingStrategy: (() => { const imgs = [...document.querySelectorAll("img")]; const scripts = [...document.querySelectorAll("script[src]")]; const links = [...document.querySelectorAll("link[rel=stylesheet]")]; return { images: { total: imgs.length, lazy: imgs.filter(i => i.loading === "lazy").length, eager: imgs.filter(i => i.loading === "eager").length, none: imgs.filter(i => !i.loading).length }, scripts: { total: scripts.length, async: scripts.filter(s => s.async).length, defer: scripts.filter(s => s.defer).length, blocking: scripts.filter(s => !s.async && !s.defer).length }, stylesheets: { total: links.length, preload: [...links].filter(l => l.getAttribute("rel")?.includes("preload")).length } }; })(),
            trigFunctions: (() => { const m = { sin: 0, cos: 0, tan: 0, asin: 0, acos: 0, atan: 0, atan2: 0, pi: 0, e: 0 }; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; for (const fn of ["sin","cos","tan","asin","acos","atan","atan2"]) { if (new RegExp(`\\b${fn}\\(`).test(text)) m[fn]++; } if (/\bpi\b/.test(text)) m.pi++; if (/\be\b/.test(text) && /calc|math/.test(text)) m.e++; } } catch {} } const active = Object.entries(m).filter(([_,v]) => v > 0); return { total: active.length, functions: active.map(([fn, count]) => ({ fn, count })) }; })(),
            lineHeightRatio: (() => { const items = []; for (const el of document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,td,th,label,blockquote,caption,dd,dt")) { const s = getComputedStyle(el); const fs = parseFloat(s.fontSize); const lh = parseFloat(s.lineHeight); if (fs && lh && fs > 10) { const ratio = Math.round((lh / fs) * 100) / 100; if (ratio < 1.1 || ratio > 2.5) { items.push({ tag: el.tagName, fontSize: s.fontSize, lineHeight: s.lineHeight, ratio, issue: ratio < 1.1 ? "line-height too tight (<1.1) — text overlaps risk" : "line-height too loose (>2.5) — poor readability" }); if (items.length >= 15) break; } } } return items; })(),
            letterSpacingAudit: (() => { const items = []; for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6,label,button,a,.btn,.button,small,caption,th")) { const s = getComputedStyle(el); const ls = s.letterSpacing; if (ls && ls !== "normal" && ls !== "0px") { const val = parseFloat(ls); if (val > 0 && el.textContent?.trim()) { items.push({ tag: el.tagName, letterSpacing: ls, textPreview: el.textContent.trim().slice(0, 20) }); if (items.length >= 15) break; } } } return items; })(),
            visibleOverflow: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.overflow !== "visible" && s.overflowX !== "visible" && s.overflowY !== "visible") continue; const r = el.getBoundingClientRect(); if (r.width < 50 || r.height < 50) continue; const child = el.firstElementChild; if (child) { const cr = child.getBoundingClientRect(); if (cr.right > r.right + 2 || cr.bottom > r.bottom + 2) { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, overflow: s.overflow, childTag: child.tagName, issue: "child overflows parent — but overflow is visible" }); if (items.length >= 10) break; } } } return items; })(),
            cssComplexity: (() => { let totalSelectors = 0, totalDeclarations = 0, maxPerRule = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText) { const sels = rule.selectorText.split(",").length; totalSelectors += sels; const decls = rule.style?.length || 0; totalDeclarations += decls; if (decls > maxPerRule) maxPerRule = decls; } } } catch {} } return { totalSelectors, totalDeclarations, avgPerRule: totalSelectors > 0 ? Math.round(totalDeclarations / totalSelectors * 10) / 10 : 0, maxDeclarationsPerRule: maxPerRule }; })(),
            viewTransitions: (() => { let count = 0; const names = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (/view-transition-name/.test(text)) { count++; const m = text.match(/view-transition-name:\s*([\w-]+)/); if (m && names.length < 10) names.push(m[1]); } } } catch {} } return { count, names }; })(),
            pointerHover: (() => { let hasFine = false, hasCoarse = false, hasHover = false, hasNone = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media) { const t = rule.media.mediaText; if (/pointer:\s*fine/.test(t)) hasFine = true; if (/pointer:\s*coarse/.test(t)) hasCoarse = true; if (/hover:\s*hover/.test(t)) hasHover = true; if (/hover:\s*none/.test(t)) hasNone = true; } } } catch {} } return { hasFinePointer, hasCoarsePointer, hasHoverCapability, hasNoHover }; })(),
            tabularNumbers: (() => { const items = []; for (const el of document.querySelectorAll("td,th,.price,.amount,.currency,.number,.stat,[data-numeric]")) { const s = getComputedStyle(el); const fn = s.fontVariantNumeric; if (fn && fn !== "normal" && /tabular-nums|lining-nums/.test(fn)) { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, variant: fn.slice(0, 40) }); if (items.length >= 10) break; } } return { hasTabular: items.length > 0, items }; })(),
            hasLargeText: (() => { let large = 0, normal = 0, small = 0; for (const el of document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,td,th,label,span,a,button")) { const s = getComputedStyle(el); const fs = parseFloat(s.fontSize); if (!fs || !el.textContent?.trim()) continue; if (fs >= 24) large++; else if (fs >= 16) normal++; else small++; } return { large: large, normal: normal, small: small, issue: small > large + normal ? `${small} elements below 16px — body text should be 16px minimum` : undefined }; })(),
            gridItemAudit: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const parent = el.parentElement; if (!parent) continue; const ps = getComputedStyle(parent); if (ps.display.startsWith("grid") && el.style.gridColumn) { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, gridColumn: el.style.gridColumn, gridRow: el.style.gridRow || undefined, justifySelf: s.justifySelf !== "auto" ? s.justifySelf : undefined, alignSelf: s.alignSelf !== "auto" ? s.alignSelf : undefined }); if (items.length >= 15) break; } } return items; })(),
            cssAtRules: (() => { const m = { import: 0, charset: 0, namespace: 0, media: 0, supports: 0, keyframes: 0, fontface: 0, page: 0, layer: 0, property: 0, container: 0, scope: 0, startingstyle: 0 }; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const type = rule.constructor.name.replace("CSS", "").replace("Rule", "").toLowerCase(); if (m[type] !== undefined) m[type]++; if (rule.cssText?.startsWith("@keyframes")) m.keyframes++; if (rule.cssText?.startsWith("@font-face")) m.fontface++; if (rule.cssText?.startsWith("@property")) m.property++; if (rule.cssText?.startsWith("@container")) m.container++; if (rule.cssText?.startsWith("@layer")) m.layer++; if (rule.cssText?.startsWith("@scope")) m.scope++; if (rule.cssText?.startsWith("@starting-style")) m.startingstyle++; } } catch {} } return Object.entries(m).filter(([_,v]) => v > 0).sort((a,b) => b[1]-a[1]).map(([type, count]) => ({ type, count })); })(),
            keyframeAnimations: (() => { const names = new Set(); for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.startsWith("@keyframes")) { const m = rule.cssText.match(/@keyframes\s+([\w-]+)/); if (m) names.add(m[1]); } } } catch {} } return { total: names.size, names: [...names].slice(0, 20) }; })(),
            widthCalcAudit: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const w = s.width; if (w && w.includes("calc(")) { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, width: w.slice(0, 60) }); if (items.length >= 15) break; } } return items; })(),
            scrollDriven: (() => { let hasScrollTimeline = false; let hasViewTimeline = false; const props = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (/scroll-timeline/.test(text)) { hasScrollTimeline = true; if (props.length < 5) props.push(text.slice(0, 50)); } if (/view-timeline/.test(text)) { hasViewTimeline = true; if (props.length < 5) props.push(text.slice(0, 50)); } } } catch {} } return { hasScrollTimeline, hasViewTimeline, props }; })(),
            namedGridLines: (() => { const lines = new Set(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const cols = s.gridTemplateColumns; const rows = s.gridTemplateRows; for (const template of [cols, rows]) { if (template && template !== "none") { const named = template.match(/\[([\w-]+)\]/g); if (named) for (const n of named) lines.add(n.replace(/[\[\]]/g, "")); } } } return [...lines]; })(),
            anchorPositioning: (() => { let count = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText && (/anchor-name/.test(rule.cssText) || /position-anchor/.test(rule.cssText) || /anchor\(/.test(rule.cssText))) count++; } } catch {} } return { count }; })(),
            fontFeatureSettings: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const fs = s.fontFeatureSettings; if (fs && fs !== "normal" && el.textContent?.trim()) { m.set(fs, (m.get(fs) || 0) + 1); } } return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10).map(([value, count]) => ({ value, count })); })(),
            mathStyle: (() => { const has = { mathDepth: false, mathShift: false, mathVariant: false }; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (/math-depth/.test(text)) has.mathDepth = true; if (/math-shift/.test(text)) has.mathShift = true; if (/math-variant/.test(text)) has.mathVariant = true; } } catch {} } return has; })(),
            conditionalRules: (() => { let supportsCount = 0; const supportsFeatures = []; let mediaCount = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.startsWith("@supports")) { supportsCount++; const m = rule.cssText.match(/@supports\s+([^ {]+)/); if (m && supportsFeatures.length < 10) supportsFeatures.push(m[1].trim().slice(0, 50)); } if (rule.media) mediaCount++; } } catch {} } return { supportsCount, supportsFeatures, mediaCount }; })(),
            boxModelAudit: (() => { const issues = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); if (r.width < 2 && r.height < 2 && s.overflow === "visible" && el.children.length > 0) { issues.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, issue: "zero-size element with visible children — possible layout collapse" }); if (issues.length >= 10) break; } if (s.boxSizing === "content-box" && parseFloat(s.width) > 0 && (parseFloat(s.paddingLeft) + parseFloat(s.paddingRight) > 0 || parseFloat(s.borderLeftWidth) + parseFloat(s.borderRightWidth) > 0)) { if (issues.length < 10) issues.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, width: s.width, issue: "content-box with padding/border — width does not include padding/border" }); } } return issues; })(),
            counterStyle: (() => { let count = 0; const names = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.startsWith("@counter-style")) { count++; const m = rule.cssText.match(/@counter-style\s+([\w-]+)/); if (m && names.length < 10) names.push(m[1]); } } } catch {} } return { count, names }; })(),
            initialLetter: (() => { const items = []; for (const el of document.querySelectorAll("p, .dropcap, .drop-cap, .lede, .lead")) { const s = getComputedStyle(el); const il = s.initialLetter; if (il && il !== "normal") { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, initialLetter: il }); if (items.length >= 5) break; } } return items; })(),
            cssSupports: (() => { const features = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.startsWith("@supports")) { const m = rule.cssText.match(/@supports\s+(not\s+)?(.+?)(?:\s*\{|$)/); if (m) features.push({ condition: m[2]?.trim().slice(0, 60), negated: !!m[1] }); if (features.length >= 15) break; } } } catch {} } return features; })(),
            textWrapAudit: (() => { const m = new Map(); for (const el of document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,caption,dd,dt,figcaption")) { const s = getComputedStyle(el); const tw = s.textWrap; if (tw && tw !== "wrap" && el.textContent?.trim()) { m.set(tw, (m.get(tw) || 0) + 1); } } return [...m.entries()].map(([value, count]) => ({ value, count })); })(),
            lineClampAudit: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const wk = s.webkitLineClamp; if (wk && wk !== "none") { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, lines: wk, display: s.display, webkitBoxOrient: s.webkitBoxOrient }); if (items.length >= 15) break; } } return items; })(),
            rubyAnnotation: (() => { const ruby = [...document.querySelectorAll("ruby")]; const rt = [...document.querySelectorAll("rt")]; const rp = [...document.querySelectorAll("rp")]; return { rubyCount: ruby.length, rtCount: rt.length, rpCount: rp.length, hasRuby: ruby.length > 0 }; })(),
            inheritViewport: (() => { let hasInherit = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("inherit") && /viewport|large-viewport|small-viewport|dynamic-viewport/.test(rule.cssText)) hasInherit = true; } } catch {} } const sv = getComputedStyle(document.documentElement); return { hasSvh: /svh/.test(sv.height || ""), hasDvh: /dvh/.test(sv.height || ""), hasLvh: /lvh/.test(sv.height || ""), hasInherit }; })(),
            colorGamut: (() => { let hasSrgb = false, hasP3 = false, hasRec2020 = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media) { const t = rule.media.mediaText; if (/color-gamut:\s*srgb/.test(t)) hasSrgb = true; if (/color-gamut:\s*p3/.test(t)) hasP3 = true; if (/color-gamut:\s*rec2020/.test(t)) hasRec2020 = true; } } } catch {} } return { hasSrgb, hasP3, hasRec2020 }; })(),
            forcedColors: (() => { let hasForced = false, hasActive = false, hasNone = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media) { const t = rule.media.mediaText; if (/forced-colors:\s*active/.test(t)) { hasForced = true; hasActive = true; } if (/forced-colors:\s*none/.test(t)) hasForced = true; } } } catch {} } return { hasForcedColors: hasForced, hasActive }; })(),
            contentVisibility: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.contentVisibility === "auto") { const r = el.getBoundingClientRect(); items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, height: Math.round(r.height), containIntrinsicSize: s.containIntrinsicSize?.slice(0, 40) || undefined }); if (items.length >= 15) break; } } return { count: items.length, items }; })(),
            textUnderlineOffset: (() => { const m = new Map(); for (const el of document.querySelectorAll("a,u,ins")) { const s = getComputedStyle(el); const o = s.textUnderlineOffset; const dp = s.textDecorationThickness; if ((o && o !== "auto") || (dp && dp !== "auto")) { const key = `offset:${o} thickness:${dp}`; m.set(key, (m.get(key) || 0) + 1); } } return [...m.entries()].map(([value, count]) => ({ value, count })); })(),
            gridAutoFlow: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.display.startsWith("grid")) { const af = s.gridAutoFlow; m.set(af, (m.get(af) || 0) + 1); } } return [...m.entries()].map(([value, count]) => ({ value, count })); })(),
            gapShorthand: (() => { let usesGap = 0, usesRowColGap = 0; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.gap !== "normal" && parseFloat(s.gap) > 0) { const rg = s.rowGap; const cg = s.columnGap; if (rg !== cg) usesRowColGap++; else usesGap++; } } return { usesGap, usesRowColGap }; })(),
            descendentSelectors: (() => { let count = 0; const samples = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText) { const parts = rule.selectorText.split(","); for (const sel of parts) { const depth = (sel.match(/\s+/g) || []).length; if (depth >= 3) { count++; if (samples.length < 10) samples.push(sel.trim().slice(0, 60)); } } } } } catch {} } return { count, samples }; })(),
            textOrientation: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.textOrientation && s.textOrientation !== "mixed" && el.textContent?.trim()) { items.push({ tag: el.tagName, textOrientation: s.textOrientation, writingMode: s.writingMode }); if (items.length >= 10) break; } } return items; })(),
            colorContrastPairs: (() => { const pairs = new Map(); for (const el of document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,span,a,td,th,label,button,li,strong,em,b,small")) { const s = getComputedStyle(el); if (!el.textContent?.trim()) continue; const fg = s.color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); const bg = (s.backgroundColor === "rgba(0, 0, 0, 0)" ? "rgb(255,255,255)" : s.backgroundColor).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/); if (!fg || !bg) continue; const key = `${fg[0]}|${bg[0]}`; if (!pairs.has(key)) { const lum = (m) => { const [r,g,b] = [+m[1],+m[2],+m[3]].map(c => { c/=255; return c<=0.039?c/12.92:Math.pow((c+0.055)/1.055,2.4); }); return 0.2126*r+0.7152*g+0.0722*b; }; const l1 = lum(fg), l2 = lum(bg); const ratio = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05); pairs.set(key, { fg: fg[0], bg: bg[0], ratio: Math.round(ratio*100)/100, level: ratio >= 7 ? "AAA" : ratio >= 4.5 ? "AA" : ratio >= 3 ? "AA Large" : "Fail", count: 0 }); } pairs.get(key).count++; } return [...pairs.values()].sort((a,b) => a.ratio - b.ratio).slice(0, 15); })(),
            variableFonts: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const vss = s.fontVariationSettings; if (vss && vss !== "normal" && el.textContent?.trim()) { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, variation: vss.slice(0, 60), fontFamily: s.fontFamily?.slice(0, 30) }); if (items.length >= 15) break; } } return { count: items.length, items }; })(),
            overscrollBehavior: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const ob = s.overscrollBehavior; if (ob && ob !== "auto") m.set(ob, (m.get(ob) || 0) + 1); } return [...m.entries()].map(([value, count]) => ({ value, count })); })(),
            reducedTransparency: (() => { let hasRule = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media && /prefers-reduced-transparency/.test(rule.media.mediaText)) { hasRule = true; break; } } } catch {} } return { hasReducedTransparency: hasRule }; })(),
            scopeRules: (() => { let count = 0; const scopes = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.startsWith("@scope")) { count++; const m = rule.cssText.match(/@scope\s+\(([^)]+)\)/); if (m && scopes.length < 10) scopes.push(m[1].trim().slice(0, 40)); } } } catch {} } return { count, scopes }; })(),
            fieldSizing: (() => { const items = []; for (const el of document.querySelectorAll("textarea,input")) { const s = getComputedStyle(el); const fs = s.fieldSizing; if (fs && fs !== "fixed") { items.push({ tag: el.tagName, type: el.type || undefined, fieldSizing: fs }); if (items.length >= 10) break; } } return items; })(),
            textSpacingTrim: (() => { let hasTrim = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("text-spacing-trim")) { hasTrim = true; break; } } } catch {} } return { hasTextSpacingTrim: hasTrim }; })(),
            interpolateSize: (() => { let hasAllow = false, hasNumeric = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("interpolate-size: allow-keywords")) hasAllow = true; if (rule.cssText?.includes("interpolate-size: numeric-only")) hasNumeric = true; } } catch {} } return { hasAllowKeywords: hasAllow, hasNumericOnly: hasNumeric }; })(),
            fontPalette: (() => { let count = 0; const palettes = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.startsWith("@font-palette-values")) { count++; const m = rule.cssText.match(/@font-palette-values\s+([\w-]+)/); if (m && palettes.length < 10) palettes.push(m[1]); } } } catch {} } return { count, palettes }; })(),
            startingStyle: (() => { let count = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.startsWith("@starting-style")) count++; } } catch {} } return { count }; })(),
            scrollDrivenProgress: (() => { const items = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (/animation-range:/.test(text) && !/animation-range: normal/.test(text)) { const m = text.match(/animation-range:\s*([^;]+)/); if (m && items.length < 10) items.push(m[1].trim().slice(0, 50)); } } } catch {} } return { count: items.length, ranges: items }; })(),
            directionAware: (() => { const m = { logicalProps: 0, insetInline: 0, marginInline: 0, paddingInline: 0, blockSize: 0, inlineSize: 0 }; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.marginInline !== "0px") m.marginInline++; if (s.paddingInline !== "0px") m.paddingInline++; if (s.insetInline !== "auto") m.insetInline++; if (s.inlineSize !== "auto") m.inlineSize++; if (s.blockSize !== "auto") m.blockSize++; } return m; })(),
            colorFunctionLevel: (() => { const m = { rgb: 0, rgba: 0, hsl: 0, hsla: 0, oklch: 0, oklab: 0, lab: 0, lch: 0, color: 0, colorMix: 0, relative: 0 }; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (/\brgb\(/.test(text)) m.rgb++; if (/\brgba\(/.test(text)) m.rgba++; if (/\bhsl\(/.test(text)) m.hsl++; if (/\bhsla\(/.test(text)) m.hsla++; if (/oklch\(/.test(text)) m.oklch++; if (/oklab\(/.test(text)) m.oklab++; if (/\blab\(/.test(text)) m.lab++; if (/\blch\(/.test(text)) m.lch++; if (/\bcolor\(/.test(text)) m.color++; if (/color-mix\(/.test(text)) m.colorMix++; if (/from\s+(rgb|hsl|oklch|oklab|lab|lch|color)/.test(text)) m.relative++; } } catch {} } return Object.entries(m).filter(([_,v]) => v > 0).sort((a,b) => b[1]-a[1]).map(([fn, count]) => ({ fn, count })); })(),
            scrollTimelineNamed: (() => { const names = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; const m = text.match(/scroll-timeline(?:-name)?:\s*([\w-]+)/g); if (m) for (const match of m) { const n = match.match(/:\s*([\w-]+)/)?.[1]; if (n && !names.includes(n) && names.length < 10) names.push(n); } const m2 = text.match(/view-timeline(?:-name)?:\s*([\w-]+)/g); if (m2) for (const match of m2) { const n = match.match(/:\s*([\w-]+)/)?.[1]; if (n && !names.includes(n) && names.length < 10) names.push(n); } } } catch {} } return { count: names.length, names }; })(),
            transitionProperties: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const t = s.transitionProperty; if (t && t !== "all" && t !== "none") { for (const prop of t.split(",")) { const p = prop.trim(); if (p) m.set(p, (m.get(p) || 0) + 1); } } } return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, 15).map(([prop, count]) => ({ prop, count })); })(),
            originReporting: (() => { const trial = document.querySelector("meta[http-equiv=origin-trial]"); const permissions = [...document.querySelectorAll("meta[name=permissions-policy]")]; return { hasOriginTrial: !!trial, trialContent: trial?.getAttribute("content")?.slice(0, 80), hasPermissionsPolicy: permissions.length > 0, permissionsContent: permissions[0]?.getAttribute("content")?.slice(0, 80) }; })(),
            baselineAudit: (() => { const modern = new Set(["color-mix","oklch","oklab","lab","lch","container","subgrid","cascade-layers","@layer","view-transition","anchor","scroll-timeline","view-timeline","@scope","@starting-style","interpolate-size","field-sizing","text-wrap","content-visibility","aspect-ratio","gap","has()",":has(",":is(",":where("]); let modernCount = 0; const found = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = (rule.cssText || "").toLowerCase(); for (const feature of modern) { if (text.includes(feature) && !found.includes(feature)) { found.push(feature); modernCount++; } } } } catch {} } return { totalModernFeatures: modernCount, features: found }; })(),
            hasSelectorAudit: (() => { let count = 0; const samples = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText && /:has\(/.test(rule.selectorText)) { count++; if (samples.length < 10) samples.push(rule.selectorText.slice(0, 60)); } } } catch {} } return { count, samples }; })(),
            isWhereSelectors: (() => { let hasIs = 0, hasWhere = 0; const samples = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText && /:is\(/.test(rule.selectorText)) { hasIs++; if (samples.length < 10) samples.push({ type: ":is", selector: rule.selectorText.slice(0, 50) }); } if (rule.selectorText && /:where\(/.test(rule.selectorText)) { hasWhere++; if (samples.length < 10) samples.push({ type: ":where", selector: rule.selectorText.slice(0, 50) }); } } } catch {} } return { isCount: hasIs, whereCount: hasWhere, samples }; })(),
            nestingCompatability: (() => { let hasNativeNesting = false, hasPostcssNesting = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText && /&/.test(rule.cssText)) { hasNativeNesting = true; break; } } } catch {} } return { hasNativeNesting, recommendation: !hasNativeNesting ? "native CSS nesting is available in all modern browsers — consider migrating from preprocessor nesting" : undefined }; })(),
            pageTransitionTypes: (() => { let count = 0; const types = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (/view-transition-name/.test(text)) { count++; const m = text.match(/view-transition-name:\s*([\w-]+)/); if (m && !types.includes(m[1]) && types.length < 15) types.push(m[1]); } } } catch {} } return { count, types }; })(),
            positionTry: (() => { let count = 0; const fallbacks = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (/position-try/.test(text)) { count++; const m = text.match(/position-try(?:-fallbacks)?:\s*([^;]+)/); if (m && fallbacks.length < 10) fallbacks.push(m[1].trim().slice(0, 40)); } if (/@position-try/.test(text)) { count++; const m = text.match(/@position-try\s+([\w-]+)/); if (m && fallbacks.length < 10) fallbacks.push(m[1]); } } } catch {} } return { count, fallbacks }; })(),
            cssBaselineStatus: (() => { const baselines = { newly: 0, widely: 0, limited: 0 }; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = (rule.cssText || "").toLowerCase(); if (/anchor\(|anchor-name|position-anchor/.test(text)) baselines.limited++; if (/@starting-style|interpolate-size/.test(text)) baselines.limited++; if (/subgrid/.test(text)) baselines.newly++; if (/container-type|@container/.test(text)) baselines.widely++; if (/:has\(/.test(text)) baselines.widely++; if (/color-mix/.test(text)) baselines.widely++; if (/oklch/.test(text)) baselines.newly++; } } catch {} } return baselines; })(),
            inputEnterKeyHint: (() => { return [...document.querySelectorAll("input,textarea")].slice(0, 30).filter(el => el.type !== "hidden" && el.type !== "checkbox" && el.type !== "radio").map(el => { const expected = { search: "search", email: "next", tel: "next", url: "go", password: "go", text: "done" }[el.type] || "done"; const actual = el.getAttribute("enterkeyhint"); return { type: el.type || el.tagName.toLowerCase(), name: el.name || undefined, enterKeyHint: actual, expected: actual === expected ? undefined : expected, issue: !actual ? `missing enterkeyhint — should be ${expected} for mobile keyboard` : actual !== expected ? `enterkeyhint should be ${expected}` : undefined }; }).filter(i => i.issue); })(),
            cssBorderImage: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const bi = s.borderImage; if (bi && bi !== "none") { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, borderImage: bi.slice(0, 60) }); if (items.length >= 10) break; } } return items; })(),
            anchorInset: (() => { let count = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; if (/inset-area/.test(text) || /position-visibility/.test(text)) count++; } } catch {} } return { count }; })(),
            textAutospace: (() => { let count = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("text-autospace")) count++; } } catch {} } return { count }; })(),
            spreadGlyph: (() => { let count = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("text-group-align")) count++; } } catch {} } const els = [...document.querySelectorAll("[data-text-group-align]")]; return { cssCount: count, dataAttrCount: els.length }; })(),
            crossOriginIsolation: (() => { return { crossOriginIsolated: self.crossOriginIsolated, isSecureContext: self.isSecureContext, hasSharedArrayBuffer: typeof SharedArrayBuffer !== "undefined" }; })(),
            paintWorklet: (() => { let hasPaint = false; try { hasPaint = CSS.paintWorklet !== undefined; } catch {} let hasLayout = false; try { hasLayout = CSS.layoutWorklet !== undefined; } catch {} let hasAnimation = false; try { hasAnimation = CSS.animationWorklet !== undefined; } catch {} return { paintWorklet: hasPaint, layoutWorklet: hasLayout, animationWorklet: hasAnimation }; })(),
            flexWrapAudit: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.display.startsWith("flex") && el.children.length > 2) { if (s.flexWrap === "nowrap") { const r = el.getBoundingClientRect(); let totalChildWidth = 0; for (const c of el.children) totalChildWidth += c.getBoundingClientRect().width; if (totalChildWidth > r.width + 5) items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, containerWidth: Math.round(r.width), childWidth: Math.round(totalChildWidth), issue: "flex-wrap:nowrap but children overflow — will clip or overflow" }); } if (items.length >= 10) break; } } return items; })(),
            colorSpaceMeta: (() => { const html = getComputedStyle(document.documentElement); const hasSrgb = /srgb/.test(html.colorScheme || ""); const profileMeta = document.querySelector("meta[name=color-profile]"); return { cssColorSpace: html.colorSpace || "auto", hasColorProfileMeta: !!profileMeta, profileValue: profileMeta?.getAttribute("content") || undefined }; })(),
            scrollbarColor: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); if (s.scrollbarColor && s.scrollbarColor !== "auto") { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, scrollbarColor: s.scrollbarColor.slice(0, 50) }); if (items.length >= 10) break; } } return items; })(),
            transformOrigin: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const to = s.transformOrigin; if (s.transform !== "none" && to && to !== "50% 50%") m.set(to, (m.get(to) || 0) + 1); } return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, 10).map(([value, count]) => ({ value, count })); })(),
            outlineStyleAudit: (() => { const m = new Map(); for (const el of document.querySelectorAll("a,button,input,select,textarea,[tabindex]")) { const s = getComputedStyle(el); if (s.outlineStyle !== "none") { const key = `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`; m.set(key, (m.get(key) || 0) + 1); } } return [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, 8).map(([value, count]) => ({ value, count })); })(),
            prefersInstant: (() => { let hasInstant = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media && /prefers-instant|prefers-reduced-motion/.test(rule.media.mediaText)) { hasInstant = true; break; } } } catch {} } return { hasPrefersInstant: hasInstant }; })(),
            selectAccentColor: (() => { const items = []; for (const el of document.querySelectorAll("input[type=checkbox],input[type=radio],input[type=range]")) { const s = getComputedStyle(el); if (s.accentColor && s.accentColor !== "auto" && s.accentColor !== "rgb(0, 0, 0)") { items.push({ tag: el.tagName, type: el.type, accentColor: s.accentColor }); if (items.length >= 10) break; } } return { hasCustomAccent: items.length > 0, items }; })(),
            crossOriginCSS: (() => { const crossOrigin = []; for (const sheet of document.styleSheets) { try { if (sheet.href) { const url = new URL(sheet.href); if (url.origin !== location.origin) crossOrigin.push({ href: sheet.href.slice(0, 60), cors: sheet.crossOrigin || undefined, blocked: false }); } } catch { if (sheet.href) crossOrigin.push({ href: sheet.href.slice(0, 60), blocked: true }); } } return { count: crossOrigin.length, sheets: crossOrigin }; })(),
            stickyStacking: (() => { const sticky = [...document.querySelectorAll("*")].filter(el => getComputedStyle(el).position === "sticky"); const issues = []; for (let i = 0; i < sticky.length; i++) { for (let j = i + 1; j < sticky.length; j++) { const r1 = sticky[i].getBoundingClientRect(); const r2 = sticky[j].getBoundingClientRect(); if (Math.abs(r1.top - r2.top) < 5 && Math.abs(r1.left - r2.left) < 5) { issues.push({ elements: [sticky[i].tagName, sticky[j].tagName], issue: "two sticky elements at same position — stacking conflict" }); if (issues.length >= 5) break; } } if (issues.length >= 5) break; } return { stickyCount: sticky.length, conflicts: issues }; })(),
            verticalRhythm: (() => { const items = []; for (const el of document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote,figcaption,caption,dd,dt")) { const s = getComputedStyle(el); const mb = parseFloat(s.marginBottom); const mt = parseFloat(s.marginTop); const lh = parseFloat(s.lineHeight); if (mb > 0 || mt > 0) { items.push({ tag: el.tagName, marginTop: s.marginTop, marginBottom: s.marginBottom, lineHeight: s.lineHeight, fontSize: s.fontSize }); if (items.length >= 20) break; } } const bases = new Set(); for (const i of items) { for (const v of [parseFloat(i.marginTop), parseFloat(i.marginBottom)]) { if (v > 0) { const base = v >= 8 ? Math.round(v / 8) * 8 : v; bases.add(base); } } } return { hasConsistentBase: bases.size <= 3, spacingBases: [...bases].sort((a,b) => a-b), samples: items.slice(0, 10) }; })(),
            inputTypeAudit: (() => { const inputs = [...document.querySelectorAll("input")]; const issues = []; for (const el of inputs) { if (el.type === "text" || !el.type) { const ac = el.getAttribute("autocomplete") || ""; const ph = el.placeholder || el.getAttribute("aria-label") || el.name || ""; if (/email/i.test(ph) || /email/i.test(ac)) issues.push({ type: "text", name: el.name, issue: "should be type=email for better mobile keyboard and validation" }); if (/phone|tel/i.test(ph) || /tel/i.test(ac)) issues.push({ type: "text", name: el.name, issue: "should be type=tel for mobile phone keyboard" }); if (/url|website/i.test(ph) || /url/i.test(ac)) issues.push({ type: "text", name: el.name, issue: "should be type=url for mobile URL keyboard" }); if (/search/i.test(ph)) issues.push({ type: "text", name: el.name, issue: "should be type=search for search-optimized keyboard" }); if (/number|amount|qty|quantity/i.test(ph)) issues.push({ type: "text", name: el.name, issue: "should be type=number or inputmode=numeric" }); } } return issues; })(),
            layoutShiftRisk: (() => { const risks = []; for (const img of document.querySelectorAll("img")) { const s = getComputedStyle(img); const r = img.getBoundingClientRect(); const hasRatio = s.aspectRatio && s.aspectRatio !== "auto"; const hasAttrs = img.getAttribute("width") && img.getAttribute("height"); if (!hasRatio && !hasAttrs && r.width > 100) risks.push({ tag: "img", src: img.src.slice(0, 50), width: Math.round(r.width), risk: "no aspect-ratio or width/height — CLS when it loads" }); } for (const el of document.querySelectorAll("iframe,embed,object")) { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); if (!s.aspectRatio || s.aspectRatio === "auto") if (r.width > 100) risks.push({ tag: el.tagName, src: (el.src||el.data||"").slice(0,50), width: Math.round(r.width), risk: "no aspect-ratio — CLS risk" }); } const fonts = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("@font-face") && !/font-display:\s*(swap|optional)/.test(rule.cssText)) fonts.push("font without swap/optional — FOIT causes layout shift"); } } catch {} } if (fonts.length) risks.push({ tag: "@font-face", risk: fonts[0], count: fonts.length }); return risks; })(),
            responsiveFontScale: (() => { const items = []; for (const el of document.querySelectorAll("h1,h2,h3,h4,h5,h6,p,body")) { const s = getComputedStyle(el); const fs = s.fontSize; if (fs && /clamp|vw|vmin|vmax|cqw|cqmin|cqmax/.test(fs)) { items.push({ tag: el.tagName, fontSize: fs.slice(0, 50) }); if (items.length >= 15) break; } } return { hasFluidType: items.length > 0, items }; })(),
            dataUriAssets: (() => { let imgCount = 0, fontCount = 0, svgCount = 0, totalSize = 0; for (const el of document.querySelectorAll("img[src^='data:']")) imgCount++; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; const dataUris = text.match(/data:[^"')]+/g) || []; for (const uri of dataUris) { totalSize += uri.length; if (uri.startsWith("data:image/svg")) svgCount++; else if (uri.startsWith("data:font") || uri.startsWith("data:application/font")) fontCount++; else if (uri.startsWith("data:image")) imgCount++; } } } catch {} } return { inlineImages: imgCount, inlineFonts: fontCount, inlineSvgs: svgCount, estimatedSizeKB: Math.round(totalSize / 1024) }; })(),
            printPageBreak: (() => { let hasBreakBefore = false, hasBreakAfter = false, hasBreakInside = false, hasPageSize = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media && /print/.test(rule.media.mediaText)) { for (const inner of (rule.cssRules || [])) { const text = inner.cssText || ""; if (/break-before|page-break-before/.test(text)) hasBreakBefore = true; if (/break-after|page-break-after/.test(text)) hasBreakAfter = true; if (/break-inside|page-break-inside/.test(text)) hasBreakInside = true; if (/page-size|size:/.test(text)) hasPageSize = true; } } } } catch {} } return { hasBreakBefore, hasBreakAfter, hasBreakInside, hasPageSize, hasPrintRules: hasBreakBefore || hasBreakAfter || hasBreakInside }; })(),
            focusVisibleStyles: (() => { const rules = []; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.selectorText && /:focus-visible/.test(rule.selectorText)) { rules.push({ selector: rule.selectorText.slice(0, 50), outline: rule.style.outline || undefined, boxShadow: rule.style.boxShadow?.slice(0, 40) || undefined, border: rule.style.border?.slice(0, 30) || undefined }); if (rules.length >= 10) break; } } } catch {} } return { count: rules.length, rules }; })(),
            spacingScale: (() => { const m = new Map(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); for (const p of ["margin-top","margin-bottom","padding-top","padding-bottom","gap"]) { const v = s.getPropertyValue(p); if (v && v !== "0px" && v !== "normal" && v !== "auto" && /px$/.test(v)) { const px = parseInt(v); if (px > 0) m.set(px, (m.get(px) || 0) + 1); } } } const sorted = [...m.entries()].sort((a,b) => b[1]-a[1]).slice(0, 20); const isBase8 = sorted.every(([px]) => px % 8 === 0 || px % 4 === 0); return { values: sorted.map(([px, count]) => ({ px, count })), hasBaseScale: isBase8, likelyBase: sorted.length > 0 ? (sorted[0][0] % 8 === 0 ? 8 : sorted[0][0] % 4 === 0 ? 4 : 1) : undefined }; })(),
            dimensionAudit: (() => { const issues = []; for (const el of document.querySelectorAll("img,video,iframe")) { const s = getComputedStyle(el); const r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) issues.push({ tag: el.tagName, src: (el.src||"").slice(0,40), issue: "zero dimensions — element is invisible or collapsed" }); if (r.width > 0 && r.height === 0) issues.push({ tag: el.tagName, src: (el.src||"").slice(0,40), width: Math.round(r.width), issue: "zero height but non-zero width — height not set" }); } return issues; })(),
            metaThemeColor: (() => { const metas = [...document.querySelectorAll("meta[name='theme-color'], meta[name='apple-mobile-web-app-status-bar-style']")]; return { hasThemeColor: metas.some(m => m.getAttribute("name") === "theme-color"), themeColor: metas.find(m => m.getAttribute("name") === "theme-color")?.getAttribute("content") || undefined, hasAppleStatusBar: metas.some(m => m.getAttribute("name")?.includes("apple")), appleStyle: metas.find(m => m.getAttribute("name")?.includes("apple"))?.getAttribute("content") || undefined }; })(),
            formValidation: (() => { const inputs = [...document.querySelectorAll("input,textarea,select")].filter(el => el.type !== "hidden" && el.type !== "submit" && el.type !== "button"); let hasRequired = 0, hasPattern = 0, hasMinLength = 0, hasMaxLength = 0, hasMin = 0, hasMax = 0, hasStep = 0, hasNoValidate = 0; const forms = [...document.querySelectorAll("form")]; for (const f of forms) if (f.noValidate) hasNoValidate++; for (const el of inputs) { if (el.required) hasRequired++; if (el.pattern) hasPattern++; if (el.minLength > 0) hasMinLength++; if (el.maxLength > 0 && el.maxLength !== -1) hasMaxLength++; if (el.min) hasMin++; if (el.max) hasMax++; if (el.step && el.step !== "") hasStep++; } return { totalInputs: inputs.length, required: hasRequired, pattern: hasPattern, minLength: hasMinLength, maxLength: hasMaxLength, min: hasMin, max: hasMax, step: hasStep, formsWithNoValidate: hasNoValidate }; })(),
            cssPrefixAudit: (() => { let webkit = 0, moz = 0, ms = 0, o = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { const text = rule.cssText || ""; const wm = text.match(/-webkit-/g); if (wm) webkit += wm.length; const mm = text.match(/-moz-/g); if (mm) moz += mm.length; const im = text.match(/-ms-/g); if (im) ms += im.length; const om = text.match(/-o-/g); if (om) o += om.length; } } catch {} } return { webkit, moz, ms, o, total: webkit + moz + ms + o }; })(),
            gridMinmax: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const cols = s.gridTemplateColumns; if (cols && cols !== "none" && /minmax/.test(cols)) { items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, columns: cols.slice(0, 80) }); if (items.length >= 10) break; } } return items; })(),
            containerType: (() => { const items = []; for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const ct = s.containerType; if (ct && ct !== "normal") { const r = el.getBoundingClientRect(); items.push({ tag: el.tagName, class: el.className?.toString?.()?.slice?.(0, 30) || undefined, containerType: ct, width: Math.round(r.width) }); if (items.length >= 10) break; } } return items; })(),
            pageLayoutType: (() => { const body = document.body; const bs = getComputedStyle(body); const main = document.querySelector("main, [role=main]"); const ms = main ? getComputedStyle(main) : null; const sidebar = document.querySelector("aside, [role=complementary], .sidebar, nav:not([aria-label=breadcrumb])"); const hasGrid = bs.display.startsWith("grid") || (ms && ms.display.startsWith("grid")); const hasFlex = bs.display.startsWith("flex") || (ms && ms.display.startsWith("flex")); const hasFloats = [...document.querySelectorAll("*")].some(el => getComputedStyle(el).float !== "none"); return { layoutType: hasGrid ? "grid" : hasFlex ? "flex" : hasFloats ? "float" : "block", hasSidebar: !!sidebar, sidebarPosition: sidebar ? (getComputedStyle(sidebar).order || getComputedStyle(sidebar).float || "unknown") : undefined }; })(),
            fontStack: (() => { const m = new Map(); for (const el of document.querySelectorAll("body,h1,h2,h3,p,li,td,th,label,button,a,small,caption")) { const s = getComputedStyle(el); const ff = s.fontFamily; if (ff) { const primary = ff.split(",")[0].trim().replace(/["']/g, ""); const stack = ff.slice(0, 80); const key = primary; if (!m.has(key)) m.set(key, { primary, stack, count: 0, sampleTags: [] }); const entry = m.get(key); entry.count++; if (entry.sampleTags.length < 3) entry.sampleTags.push(el.tagName); } } return [...m.values()].sort((a,b) => b.count - a.count).slice(0, 10); })(),
            headingSizes: (() => { const items = []; for (let i = 1; i <= 6; i++) { const h = document.querySelector("h" + i); if (h) { const s = getComputedStyle(h); items.push({ level: i, fontSize: s.fontSize, fontWeight: s.fontWeight, lineHeight: s.lineHeight, marginTop: s.marginTop, marginBottom: s.marginBottom }); } } return { hasScale: items.length >= 3, hasConsistentRatio: (() => { if (items.length < 2) return false; const sizes = items.map(i => parseFloat(i.fontSize)); const ratios = []; for (let i = 0; i < sizes.length - 1; i++) ratios.push(Math.round((sizes[i] / sizes[i+1]) * 100) / 100); const avg = ratios.reduce((a,b) => a+b, 0) / ratios.length; return ratios.every(r => Math.abs(r - avg) < 0.15); })(), items }; })(),
            linkTargetAudit: (() => { const external = [...document.querySelectorAll("a[href^='http]"), ...document.querySelectorAll("a[href^='//']")].filter(a => { try { return new URL(a.href).origin !== location.origin; } catch { return false; } }); const withoutRel = external.filter(a => { const rel = a.getAttribute("rel") || ""; return !/noopener|noreferrer/.test(rel); }); const withTargetBlank = [...document.querySelectorAll("a[target=_blank]")]; const blankWithoutNoopener = withTargetBlank.filter(a => { const rel = a.getAttribute("rel") || ""; return !/noopener/.test(rel); }); return { externalLinks: external.length, missingRel: withoutRel.length, targetBlank: withTargetBlank.length, blankWithoutNoopener: blankWithoutNoopener.length, issue: blankWithoutNoopener.length ? `${blankWithoutNoopener.length} target=_blank without rel=noopener — security risk (reverse tabnabbing)` : undefined }; })(),
            cssLineBreak: (() => { const m = new Map(); for (const el of document.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,td,th,blockquote,caption,dd,dt,figcaption")) { const s = getComputedStyle(el); const lb = s.lineBreak; const wbs = s.wordBreak; if ((lb && lb !== "auto") || (wbs && wbs !== "normal")) { const key = `line-break:${lb} word-break:${wbs}`; m.set(key, (m.get(key) || 0) + 1); } } return [...m.entries()].map(([value, count]) => ({ value, count })); })(),
            pageWeight: (() => { const entries = performance.getEntriesByType("resource"); let html = 0, css = 0, js = 0, img = 0, font = 0, other = 0; for (const e of entries) { const size = e.transferSize || e.encodedBodySize || 0; const name = e.name.toLowerCase(); if (/\.css$|\.css\?/.test(name)) css += size; else if (/\.js$|\.js\?|\.mjs$/.test(name)) js += size; else if (/\.(png|jpg|jpeg|gif|webp|avif|svg|ico)$/.test(name)) img += size; else if (/\.(woff2?|ttf|otf|eot)$/.test(name)) font += size; else if (/\.html?$|\/$/.test(name)) html += size; else other += size; } const total = html + css + js + img + font + other; return { totalKB: Math.round(total / 1024), htmlKB: Math.round(html / 1024), cssKB: Math.round(css / 1024), jsKB: Math.round(js / 1024), imgKB: Math.round(img / 1024), fontKB: Math.round(font / 1024), otherKB: Math.round(other / 1024) }; })(),
            errorHandling: (() => { let hasOnError = 0, hasWindowOnError = false, hasUnhandledRejection = false, hasErrorBoundary = false; for (const el of document.querySelectorAll("[onerror]")) hasOnError++; if (window.onerror) hasWindowOnError = true; if (window.onunhandledrejection) hasUnhandledRejection = true; for (const el of document.querySelectorAll("[data-error-boundary], .error-boundary, #error-boundary")) hasErrorBoundary = true; return { inlineOnError: hasOnError, hasWindowOnError, hasUnhandledRejection, hasErrorBoundary, issue: !hasWindowOnError && !hasUnhandledRejection ? "no global error handlers — unhandled errors will be silent" : undefined }; })(),
            lazyIframe: (() => { const iframes = [...document.querySelectorAll("iframe")]; return { total: iframes.length, lazy: iframes.filter(f => f.loading === "lazy").length, eager: iframes.filter(f => f.loading === "eager").length, none: iframes.filter(f => !f.loading).length, issue: iframes.length > 3 && iframes.filter(f => f.loading !== "lazy").length > iframes.filter(f => f.loading === "lazy").length ? "most iframes are not lazy-loaded — consider loading=lazy for below-the-fold embeds" : undefined }; })(),
            cssResetType: (() => { let hasTailwind = false, hasNormalize = false, hasReset = false, hasSanitize = false; for (const sheet of document.styleSheets) { try { const text = (sheet.cssRules ? [...sheet.cssRules].map(r => r.cssText).join("") : "").slice(0, 2000); if (/tailwind|preflight/.test(text)) hasTailwind = true; if (/normalize/.test(sheet.href || "")) hasNormalize = true; if (/\*\s*\{[^}]*margin:\s*0/.test(text) && /\*\s*\{[^}]*padding:\s*0/.test(text)) hasReset = true; if (/sanitize/.test(sheet.href || "")) hasSanitize = true; } catch {} } return { tailwind: hasTailwind, normalize: hasNormalize, reset: hasReset, sanitize: hasSanitize }; })(),
            cssCommentDensity: (() => { let totalRules = 0, totalComments = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { totalRules++; if (rule.cssText && /\/\*/.test(rule.cssText)) totalComments++; } } catch {} } return { totalRules, totalComments, ratio: totalRules > 0 ? Math.round((totalComments / totalRules) * 100) / 100 : 0 }; })(),
            defaultFormColors: (() => { const inputs = [...document.querySelectorAll("input,select,textarea,button")].slice(0, 20); const hasCustomBg = inputs.filter(el => { const s = getComputedStyle(el); return s.backgroundColor !== "rgba(0, 0, 0, 0)" && s.backgroundColor !== "rgb(255, 255, 255)"; }).length; const hasCustomBorder = inputs.filter(el => { const s = getComputedStyle(el); return s.borderColor !== "rgb(118, 118, 118)" && s.borderColor !== "rgba(0, 0, 0, 0)"; }).length; return { total: inputs.length, customBackground: hasCustomBg, customBorder: hasCustomBorder, usesDefaults: inputs.length - hasCustomBg - hasCustomBorder, issue: inputs.length > 5 && hasCustomBg + hasCustomBorder < 2 ? "form controls use default UA styling — no custom form design" : undefined }; })(),
            interactionStates: (() => { let hasActive = 0, hasFocus = 0, hasHover = 0, hasVisited = 0, hasFocusVisible = 0, hasFocusWithin = 0; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (!rule.selectorText) continue; if (/:active/.test(rule.selectorText)) hasActive++; if (/:focus[^-]/.test(rule.selectorText)) hasFocus++; if (/:hover/.test(rule.selectorText)) hasHover++; if (/:visited/.test(rule.selectorText)) hasVisited++; if (/:focus-visible/.test(rule.selectorText)) hasFocusVisible++; if (/:focus-within/.test(rule.selectorText)) hasFocusWithin++; } } catch {} } return { active: hasActive, focus: hasFocus, hover: hasHover, visited: hasVisited, focusVisible: hasFocusVisible, focusWithin: hasFocusWithin, issue: hasHover > 5 && hasFocusVisible === 0 ? ":hover rules without :focus-visible — touch users see hover styles, keyboard users get default" : undefined }; })(),
            cssZindexScale: (() => { const z = new Set(); for (const el of document.querySelectorAll("*")) { const s = getComputedStyle(el); const zi = s.zIndex; if (zi !== "auto" && zi !== "0") z.add(parseInt(zi)); } const sorted = [...z].sort((a,b) => a-b); return { values: sorted.slice(0, 20), count: sorted.length, hasClearScale: sorted.length <= 5, issue: sorted.length > 10 ? `${sorted.length} distinct z-index values — no clear stacking scale, likely specificity wars` : undefined }; })(),
            motionPreference: (() => { let hasReduced = false; let hasInstant = false; let hasNoPreference = false; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.media) { const t = rule.media.mediaText; if (/prefers-reduced-motion:\s*reduce/.test(t)) hasReduced = true; if (/prefers-reduced-motion:\s*no-preference/.test(t)) hasNoPreference = true; if (/prefers-instant/.test(t)) hasInstant = true; } } } catch {} } return { hasReducedMotion: hasReduced, hasNoPreference, hasInstant, issue: !hasReduced ? "no prefers-reduced-motion — animations ignore user preference" : undefined }; })(),
            formAutocomplete: (() => { const inputs = [...document.querySelectorAll("input,select,textarea")].filter(el => el.type !== "hidden" && el.type !== "submit" && el.type !== "button"); let hasAutocomplete = 0, missingAutocomplete = 0; const missing = []; for (const el of inputs) { const ac = el.getAttribute("autocomplete"); if (ac) hasAutocomplete++; else { missingAutocomplete++; if (missing.length < 10) missing.push({ type: el.type || el.tagName.toLowerCase(), name: el.name || undefined, label: el.labels?.[0]?.textContent?.trim().slice(0, 20) || el.getAttribute("aria-label") || undefined }); } } return { total: inputs.length, withAutocomplete: hasAutocomplete, withoutAutocomplete: missingAutocomplete, missing }; })(),
            fontFormatAudit: (() => { const m = { woff2: 0, woff: 0, ttf: 0, otf: 0, eot: 0 }; for (const sheet of document.styleSheets) { try { for (const rule of sheet.cssRules) { if (rule.cssText?.includes("@font-face")) { const src = rule.style.getPropertyValue("src") || rule.cssText || ""; if (/\.woff2/.test(src)) m.woff2++; if (/\.woff(?!2)/.test(src)) m.woff++; if (/\.ttf/.test(src)) m.ttf++; if (/\.otf/.test(src)) m.otf++; if (/\.eot/.test(src)) m.eot++; } } } catch {} } return { ...m, hasModernFormat: m.woff2 > 0, hasLegacyOnly: m.woff2 === 0 && (m.woff + m.ttf + m.otf + m.eot > 0), issue: m.eot > 0 ? "EOT fonts detected — IE-only format, safe to remove" : m.woff2 === 0 && m.ttf > 0 ? "TTF without WOFF2 — add WOFF2 for 30% smaller downloads" : undefined }; })(),
          };
        },
      }, `design audit in tab ${tab.id}`);
      const audit = results[0]?.result;
      if (!audit) throw new Error("Could not extract design tokens from the page");
      const lines = ["# Design Audit"];
      if (audit.colors?.length) { lines.push("\n## Colors"); for (const c of audit.colors.slice(0, 15)) lines.push(`  ${c}`); }
      if (audit.backgrounds?.length) { lines.push("\n## Backgrounds"); for (const c of audit.backgrounds.slice(0, 10)) lines.push(`  ${c}`); }
      if (audit.fonts?.length) { lines.push("\n## Fonts"); for (const f of audit.fonts) lines.push(`  ${f.family} (${f.count} elements)`); }
      if (audit.fontSizes?.length) { lines.push("\n## Font sizes"); lines.push(`  ${audit.fontSizes.join(", ")}`); }
      if (audit.spacing?.length) { lines.push("\n## Spacing scale"); for (const s of audit.spacing) lines.push(`  ${s.value} (${s.count} uses)`); }
      if (audit.borderRadius?.length) { lines.push("\n## Border radius"); for (const r of audit.borderRadius) lines.push(`  ${r.value} (${r.count} uses)`); }
      if (audit.shadows?.length) { lines.push("\n## Box shadows"); for (const sh of audit.shadows) lines.push(`  ${sh.value} (${sh.count} uses)`); }
      if (audit.transitions?.length) { lines.push("\n## Transitions"); for (const t of audit.transitions) lines.push(`  ${t.value} (${t.count} uses)`); }
      if (audit.mediaQueries?.length) { lines.push("\n## Media queries"); for (const mq of audit.mediaQueries) lines.push(`  ${mq}`); }
      if (audit.imageCount) { lines.push(`\n## Images: ${audit.imageCount} total`); for (const src of (audit.images || []).slice(0, 5)) lines.push(`  ${src.slice(0, 80)}`); }
      lines.push(`\n## Contrast: ${audit.contrastIssues} potential issues (below 4.5:1) out of ~${Math.min(200, audit.totalElements)} checked`);
      if (audit.ariaIssues?.length) { lines.push(`\n## ARIA issues (${audit.ariaIssues.length})`); for (const a of audit.ariaIssues.slice(0, 15)) lines.push(`  ${a.tag}${a.id ? `#${a.id}` : ""} ${a.role ? `[role=${a.role}]` : ""} — ${a.issue}`); }
      if (audit.tapTargets?.length) { lines.push(`\n## Tap target issues (${audit.tapTargets.length} below 44x44px)`); for (const t of audit.tapTargets) lines.push(`  ${t.tag} ${t.text} — ${t.width}x${t.height}px ${t.suggestion}`); }
      if (audit.gradients?.length) { lines.push("\n## Gradients"); for (const g of audit.gradients) lines.push(`  ${g.value.slice(0, 80)} (${g.count} uses)`); }
      if (audit.fontWeights?.length) { lines.push("\n## Font weights"); for (const w of audit.fontWeights) lines.push(`  ${w.weight} (${w.count} elements)`); }
      if (audit.focusOrder?.length) { lines.push("\n## Focus / tab order"); for (const f of audit.focusOrder.slice(0, 20)) lines.push(`  ${f.order}. ${f.tag}${f.type ? `[${f.type}]` : ""} ${f.text}${f.tabindex ? ` (tabindex=${f.tabindex})` : ""}`); }
      if (audit.animations?.length) { lines.push("\n## Animations"); for (const a of audit.animations) lines.push(`  ${a.value} (${a.count} elements)`); }
      if (audit.imageAudit) { lines.push(`\n## Image audit: ${audit.imageAudit.total} images`); if (audit.imageAudit.missingAlt) lines.push(`  Missing alt: ${audit.imageAudit.missingAlt}`); if (audit.imageAudit.withoutExplicitSize) lines.push(`  Missing explicit dimensions: ${audit.imageAudit.withoutExplicitSize}`); if (audit.imageAudit.lazyLoaded) lines.push(`  Lazy-loaded: ${audit.imageAudit.lazyLoaded}`); if (audit.imageAudit.large?.length) lines.push(`  Oversized (>2000px): ${audit.imageAudit.large.length}`); }
      if (audit.semanticAudit?.length) { lines.push(`\n## Semantic HTML issues (${audit.semanticAudit.length})`); for (const issue of audit.semanticAudit) lines.push(`  ${issue}`); }
      if (audit.metaTags) { lines.push("\n## Meta / SEO / Social"); if (audit.metaTags.title) lines.push(`  Title: ${audit.metaTags.title.slice(0, 60)}`); if (audit.metaTags.description) lines.push(`  Description: ${audit.metaTags.description.slice(0, 60)}`); if (audit.metaTags.viewport) lines.push(`  Viewport: ${audit.metaTags.viewport}`); if (audit.metaTags.ogTitle) lines.push(`  OG:title: ${audit.metaTags.ogTitle.slice(0, 60)}`); if (audit.metaTags.ogImage) lines.push(`  OG:image: ${audit.metaTags.ogImage.slice(0, 60)}`); if (audit.metaTags.twitterCard) lines.push(`  Twitter:card: ${audit.metaTags.twitterCard}`); if (audit.metaTags.canonical) lines.push(`  Canonical: ${audit.metaTags.canonical.slice(0, 60)}`); if (audit.metaTags.themeColor) lines.push(`  Theme-color: ${audit.metaTags.themeColor}`); }
      if (audit.tables?.length) { lines.push(`\n## Tables (${audit.tables.length})`); for (const t of audit.tables) { lines.push(`  ${t.rows}x${t.cols}${t.hasCaption ? " +caption" : ""}${t.hasThead ? " +thead" : ""}${t.hasScope ? " +scope" : ""}${t.issue ? ` — ${t.issue}` : ""}`); } }
      if (audit.layoutAudit) { lines.push("\n## Layout"); lines.push(`  flex: ${audit.layoutAudit.flex}, grid: ${audit.layoutAudit.grid}, block: ${audit.layoutAudit.block}, inline: ${audit.layoutAudit.inline}, none: ${audit.layoutAudit.none}`); }
      if (audit.positionAudit) { lines.push("\n## Positioning"); lines.push(`  static: ${audit.positionAudit.static}, relative: ${audit.positionAudit.relative}, absolute: ${audit.positionAudit.absolute}, fixed: ${audit.positionAudit.fixed}, sticky: ${audit.positionAudit.sticky}`); }
      if (audit.darkMode) { lines.push(`\n## Dark mode: ${audit.darkMode.hasMediaQuery ? "has prefers-color-scheme" : "no prefers-color-scheme"}${audit.darkMode.hasDarkVars ? `, ${audit.darkMode.darkVarCount} dark vars` : ""}`); if (audit.darkMode.darkSelectors?.length) { lines.push(`  Selectors: ${audit.darkMode.darkSelectors.join(", ")}`); } }
      if (audit.typographyDetails?.lineHeights?.length) { lines.push("\n## Typography details"); lines.push("  Line heights:"); for (const lh of audit.typographyDetails.lineHeights.slice(0, 5)) lines.push(`    ${lh.value} (${lh.count} uses)`); if (audit.typographyDetails.letterSpacing?.length) { lines.push("  Letter spacing:"); for (const ls of audit.typographyDetails.letterSpacing.slice(0, 5)) lines.push(`    ${ls.value} (${ls.count} uses)`); } }
      if (audit.colorFormats) { const f = audit.colorFormats; lines.push("\n## Color formats"); lines.push(`  hex: ${f.hex}, rgb: ${f.rgb}, rgba: ${f.rgba}, hsl: ${f.hsl}, hsla: ${f.hsla}, named: ${f.named}`); }
      if (audit.breakpoints?.length) { lines.push("\n## Breakpoints"); for (const bp of audit.breakpoints) lines.push(`  ${bp}`); }
      if (audit.flexGridAudit?.flexContainers?.length) { lines.push(`\n## Flex containers (${audit.flexGridAudit.flexContainers.length})`); for (const f of audit.flexGridAudit.flexContainers.slice(0, 10)) lines.push(`  ${f.tag}${f.class ? `.${f.class}` : ""} ${f.direction} justify:${f.justify} align:${f.align} gap:${f.gap} (${f.children} children)`); }
      if (audit.flexGridAudit?.gridContainers?.length) { lines.push(`\n## Grid containers (${audit.flexGridAudit.gridContainers.length})`); for (const g of audit.flexGridAudit.gridContainers.slice(0, 10)) lines.push(`  ${g.tag}${g.class ? `.${g.class}` : ""} cols:${g.columns} gap:${g.gap} (${g.children} children)`); }
      if (audit.hiddenContent?.length) { lines.push(`\n## Hidden content (${audit.hiddenContent.length})`); for (const h of audit.hiddenContent.slice(0, 10)) lines.push(`  ${h.tag}${h.id ? `#${h.id}` : ""} [${h.method}] "${h.textPreview}"`); }
      if (audit.viewportIssues?.issues?.length) { lines.push(`\n## Viewport issues (${audit.viewportIssues.issues.length})`); lines.push(`  Viewport: ${audit.viewportIssues.viewportWidth}x${audit.viewportIssues.viewportHeight}`); for (const i of audit.viewportIssues.issues) lines.push(`  ${i.issue}${i.overflow ? ` (${i.overflow}px overflow)` : ""}`); }
      if (audit.inputModes?.length) { lines.push(`\n## Input mode issues (${audit.inputModes.length})`); for (const i of audit.inputModes) lines.push(`  <input type="${i.type}"> ${i.label || i.name || ""} — ${i.missingInputMode ? "missing inputmode" : ""} ${i.missingAutocomplete ? "missing autocomplete" : ""}`.trim()); }
      if (audit.scriptAudit) { lines.push(`\n## Scripts: ${audit.scriptAudit.total} total (${audit.scriptAudit.external} external, ${audit.scriptAudit.inline} inline, ${audit.scriptAudit.async} async, ${audit.scriptAudit.defer} defer, ${audit.scriptAudit.module} module)`); if (audit.scriptAudit.inlineSize) lines.push(`  Inline size: ${audit.scriptAudit.inlineSize} chars`); }
      if (audit.iframeAudit?.total) { lines.push(`\n## Iframes: ${audit.iframeAudit.total} (${audit.iframeAudit.sandboxed} sandboxed, ${audit.iframeAudit.crossOrigin} cross-origin, ${audit.iframeAudit.missingTitle} missing title)`); for (const f of (audit.iframeAudit.list || []).slice(0, 5)) lines.push(`  ${f.src}${f.sandbox ? ` [sandbox:${f.sandbox}]` : ""}${f.title ? ` title="${f.title}"` : " [no title]"}`); }
      if (audit.deprecatedHtml?.length) { lines.push(`\n## Deprecated HTML (${audit.deprecatedHtml.length} tags)`); for (const d of audit.deprecatedHtml) lines.push(`  <${d.tag}>: ${d.count} occurrences`); }
      if (audit.csp) { lines.push(`\n## Security: CSP ${audit.csp.hasCspMeta ? "present" : "missing"}, X-Frame-Options ${audit.csp.hasXFrameOptions ? "present" : "missing"}, Referrer-Policy ${audit.csp.hasReferrerPolicy ? "present" : "missing"}`); if (audit.csp.policy) lines.push(`  Policy: ${audit.csp.policy.slice(0, 80)}`); }
      if (audit.classPatterns?.length) { lines.push("\n## Repeated classes (design system patterns)"); for (const c of audit.classPatterns.slice(0, 15)) lines.push(`  .${c.class} (${c.count} elements)`); }
      if (audit.fontLoading?.totalFaces) { lines.push(`\n## @font-face: ${audit.fontLoading.totalFaces} faces (${audit.fontLoading.missingFontDisplay} missing font-display)`); for (const f of (audit.fontLoading.faces || []).slice(0, 5)) lines.push(`  ${f.family} — display:${f.display} src:${(f.src || "").slice(0, 40)}`); }
      if (audit.importantAudit?.count) { lines.push(`\n## !important: ${audit.importantAudit.count} occurrences`); for (const sel of (audit.importantAudit.topSelectors || [])) lines.push(`  ${sel}`); }
      if (audit.negativeMargins?.length) { lines.push(`\n## Negative margins (${audit.negativeMargins.length})`); for (const n of audit.negativeMargins.slice(0, 10)) lines.push(`  ${n.tag}${n.class ? `.${n.class}` : ""} ${n.property}: ${n.value}`); }
      if (audit.inlineStyles?.count) { lines.push(`\n## Inline styles: ${audit.inlineStyles.count} elements`); for (const s of (audit.inlineStyles.samples || []).slice(0, 5)) lines.push(`  ${s.tag}${s.class ? `.${s.class}` : ""} style="${(s.style || "").slice(0, 60)}"`); }
      if (audit.pseudoElements?.total) { lines.push(`\n## Pseudo-elements: ${audit.pseudoElements.total} (::before: ${audit.pseudoElements.beforeCount}, ::after: ${audit.pseudoElements.afterCount})`); }
      if (audit.scrollContainers?.length) { lines.push(`\n## Scroll containers (${audit.scrollContainers.length})`); for (const c of audit.scrollContainers.slice(0, 10)) lines.push(`  ${c.tag}${c.id ? `#${c.id}` : ""}${c.class ? `.${c.class}` : ""} scrollHeight:${c.scrollHeight} clientHeight:${c.clientHeight}`); }
      if (audit.aspectRatioCheck?.length) { lines.push(`\n## Aspect ratio issues (${audit.aspectRatioCheck.length} media without dimensions)`); for (const a of audit.aspectRatioCheck.slice(0, 10)) lines.push(`  ${a.tag} ${a.src} — ${a.risk}`); }
      if (audit.colorPalette?.total) { lines.push(`\n## Color palette: ${audit.colorPalette.total} unique colors`); for (const [name, colors] of Object.entries(audit.colorPalette.groups)) { if (colors.length) { lines.push(`  ${name} (${colors.length}):`); for (const c of colors.slice(0, 5)) lines.push(`    ${c.hex} (${c.count} uses)`); } } }
      if (audit.eventHandlers?.inlineCount) { lines.push(`\n## Inline event handlers: ${audit.eventHandlers.inlineCount} (${audit.eventHandlers.attributes.join(", ")})`); }
      if (audit.cssSize) { lines.push(`\n## CSS size: ${audit.cssSize.totalRules} rules, ~${(audit.cssSize.estimatedSizeChars / 1024).toFixed(1)}KB`); for (const f of (audit.cssSize.files || []).slice(0, 5)) lines.push(`  ${f.href}${f.blocked ? " (blocked)" : f.size ? ` (${(f.size/1024).toFixed(1)}KB)` : ""}`); }
      if (audit.buttonStyles?.length) { lines.push(`\n## Button styles (${audit.buttonStyles.length} found)`); for (const b of audit.buttonStyles.slice(0, 8)) lines.push(`  ${b.tag} "${b.text}" — bg:${b.bg} color:${b.color} radius:${b.borderRadius} ${b.width}x${b.height}px cursor:${b.cursor}`); }
      if (audit.linkStyles?.length) { lines.push("\n## Link style variants"); for (const l of audit.linkStyles) lines.push(`  color:${l.color} decoration:${l.textDecoration} weight:${l.fontWeight} (${l.count} links)`); }
      if (audit.nestingDepth?.length) { lines.push(`\n## Deep nesting (${audit.nestingDepth.length} elements > 8 levels deep)`); for (const d of audit.nestingDepth.slice(0, 8)) lines.push(`  depth:${d.depth} ${d.tag}${d.class ? `.${d.class}` : ""} — ${d.path}`); }
      if (audit.headingHierarchy?.issues?.length) { lines.push(`\n## Heading hierarchy issues (${audit.headingHierarchy.issues.length})`); for (const i of audit.headingHierarchy.issues) lines.push(`  ${i.issue}: "${i.text}"`); }
      if (audit.overflowAudit?.length) { lines.push(`\n## Overflow clipping (${audit.overflowAudit.length} elements clipping content)`); for (const o of audit.overflowAudit.slice(0, 10)) lines.push(`  ${o.tag}${o.id ? `#${o.id}` : ""}${o.class ? `.${o.class}` : ""} ${o.clipped} clips ${o.content} (${o.direction})`); }
      if (audit.unusedClasses?.unusedCount) { lines.push(`\n## Unused CSS classes: ${audit.unusedClasses.unusedCount} of ${audit.unusedClasses.defined} defined`); for (const c of (audit.unusedClasses.unused || []).slice(0, 10)) lines.push(`  .${c}`); }
      if (audit.formLayout?.length) { lines.push(`\n## Form layout (${audit.formLayout.length} forms)`); for (const f of audit.formLayout) lines.push(`  ${f.fields} fields, ${f.labels} labels${f.hasFieldset ? ", fieldset" : ""}${f.hasLegend ? ", legend" : ""} display:${f.formDisplay} wrappers:[${f.inputWrappers.join(",")}]`); }
      if (audit.pointerEvents?.length) { lines.push(`\n## Pointer events issues (${audit.pointerEvents.length})`); for (const p of audit.pointerEvents) lines.push(`  ${p.tag} .${p.class} — ${p.issue}`); }
      if (audit.borderAudit?.length) { lines.push("\n## Border styles"); for (const b of audit.borderAudit.slice(0, 10)) lines.push(`  ${b.value} (${b.count} uses)`); }
      if (audit.opacityTransform?.opacityElements?.length) { lines.push(`\n## Opacity < 1 (${audit.opacityTransform.opacityElements.length})`); for (const o of audit.opacityTransform.opacityElements.slice(0, 8)) lines.push(`  ${o.tag}${o.class ? `.${o.class}` : ""} opacity:${o.opacity}`); }
      if (audit.opacityTransform?.transformElements?.length) { lines.push(`\n## Transforms (${audit.opacityTransform.transformElements.length})`); for (const t of audit.opacityTransform.transformElements.slice(0, 8)) lines.push(`  ${t.tag}${t.class ? `.${t.class}` : ""} ${t.transform}`); }
      if (audit.responsiveImages) { lines.push(`\n## Responsive images: ${audit.responsiveImages.total} total, ${audit.responsiveImages.withSrcset} with srcset, ${audit.responsiveImages.withSizes} with sizes, ${audit.responsiveImages.inPicture} in picture`); if (audit.responsiveImages.missingSrcset) lines.push(`  Missing srcset (>400px): ${audit.responsiveImages.missingSrcset}`); if (audit.responsiveImages.missingSizes) lines.push(`  Missing sizes (has srcset): ${audit.responsiveImages.missingSizes}`); }
      if (audit.containerQueries?.count) { lines.push(`\n## Container queries: ${audit.containerQueries.count} found`); for (const s of (audit.containerQueries.samples || [])) lines.push(`  ${s}`); }
      if (audit.printStyles) { lines.push(`\n## Print styles: ${audit.printStyles.hasPrintStyles ? `yes (${audit.printStyles.estimatedRules} rules)` : "no"}`); }
      if (audit.willChange?.length) { lines.push(`\n## will-change (${audit.willChange.length} elements)`); for (const w of audit.willChange.slice(0, 8)) lines.push(`  ${w.tag}${w.class ? `.${w.class}` : ""} — ${w.willChange}`); }
      if (audit.focusStyles) { lines.push(`\n## Focus styles: ${audit.focusStyles.focusableCount} focusable — ${audit.focusStyles.withOutline} outline, ${audit.focusStyles.withBoxShadowFocus} box-shadow focus, ${audit.focusStyles.noIndicator} no indicator`); if (audit.focusStyles.noIndicator > 0) lines.push(`  WARNING: ${audit.focusStyles.noIndicator} elements with no visible focus indicator`); }
      if (audit.hoverStates) { lines.push(`\n## Hover states: ${audit.hoverStates.hoverRules} :hover rules${audit.hoverStates.hasFocusVisible ? ", has :focus-visible" : ", NO :focus-visible"}`); for (const s of (audit.hoverStates.samples || []).slice(0, 5)) lines.push(`  ${s}`); }
      if (audit.reducedMotion) { lines.push(`\n## Reduced motion: ${audit.reducedMotion.hasReducedMotion ? "has prefers-reduced-motion" : "MISSING prefers-reduced-motion"}`); }
      if (audit.readingWidth?.length) { lines.push(`\n## Reading width issues (${audit.readingWidth.length})`); for (const r of audit.readingWidth) lines.push(`  ${r.tag} ${r.width}px @ ${r.fontSize} — ~${r.estCharsPerLine} cpl — ${r.issue}`); }
      if (audit.brokenImages?.length) { lines.push(`\n## Broken images (${audit.brokenImages.length})`); for (const b of audit.brokenImages.slice(0, 10)) lines.push(`  ${b.src}${b.alt ? ` alt="${b.alt}"` : ""}`); }
      if (audit.specificity?.length) { lines.push(`\n## High specificity selectors (${audit.specificity.length})`); for (const s of audit.specificity) lines.push(`  score:${s.specificity} depth:${s.depth} ${s.selector}`); }
      if (audit.mixedContent?.issues?.length) { lines.push(`\n## Mixed content (${audit.mixedContent.issues.length} issues)`); if (!audit.mixedContent.secure) lines.push("  PAGE IS NOT HTTPS"); for (const i of audit.mixedContent.issues.slice(0, 10)) lines.push(`  ${i.tag} ${i.src || ""} — ${i.issue}`); }
      if (audit.resourceHints?.total) { lines.push(`\n## Resource hints (${audit.resourceHints.total})`); for (const h of audit.resourceHints.hints.slice(0, 10)) lines.push(`  ${h.rel}: ${h.href}${h.as ? ` as=${h.as}` : ""}`); } else { lines.push("\n## Resource hints: none (missing preload/prefetch/preconnect)"); }
      if (audit.textOverflow?.length) { lines.push("\n## Text overflow strategies"); for (const t of audit.textOverflow) lines.push(`  text-overflow:${t.textOverflow} overflow:${t.overflow} white-space:${t.whiteSpace} (${t.count} elements)`); }
      if (audit.userSelect?.length) { lines.push(`\n## user-select:none on text (${audit.userSelect.length} elements)`); for (const u of audit.userSelect.slice(0, 10)) lines.push(`  ${u.tag}${u.class ? `.${u.class}` : ""} "${u.textPreview}"`); }
      if (audit.svgAudit) { lines.push(`\n## SVG audit: ${audit.svgAudit.inline} inline, ${audit.svgAudit.external} external`); if (audit.svgAudit.withoutAccess) lines.push(`  Without accessibility: ${audit.svgAudit.withoutAccess}`); if (audit.svgAudit.withTitle) lines.push(`  With <title>: ${audit.svgAudit.withTitle}`); }
      if (audit.scrollSnap?.length) { lines.push(`\n## Scroll snap (${audit.scrollSnap.length} containers)`); for (const s of audit.scrollSnap) lines.push(`  ${s.tag}${s.class ? `.${s.class}` : ""} — ${s.snapType}`); }
      if (audit.touchAction?.length) { lines.push(`\n## Touch action issues (${audit.touchAction.length})`); for (const t of audit.touchAction) lines.push(`  ${t.tag}${t.class ? `.${t.class}` : ""} — touch-action:${t.touchAction}`); }
      if (audit.modernCss) { const m = audit.modernCss; lines.push("\n## Modern CSS usage"); if (m.backdropFilter) lines.push(`  backdrop-filter: ${m.backdropFilter} elements`); if (m.clipPath) lines.push(`  clip-path: ${m.clipPath} elements`); if (m.cssContain) lines.push(`  contain: ${m.cssContain} elements`); if (m.logicalProps) lines.push(`  logical properties: ${m.logicalProps} elements`); if (m.aspectRatio) lines.push(`  aspect-ratio: ${m.aspectRatio} elements`); if (m.contentVisibility) lines.push(`  content-visibility: ${m.contentVisibility} elements`); if (m.colorMix) lines.push(`  color-mix(): ${m.colorMix} rules`); if (m.oklch) lines.push(`  oklch/lab/lch: ${m.oklch} rules`); if (m.layers) lines.push(`  @layer: ${m.layers} rules`); if (m.viewTransitions) lines.push(`  view-transition-name: ${m.viewTransitions} rules`); }
      if (audit.filterEffects?.length) { lines.push("\n## CSS filter effects"); for (const f of audit.filterEffects.slice(0, 8)) lines.push(`  ${f.value} (${f.count} elements)`); }
      if (audit.objectFit?.length) { lines.push(`\n## Object-fit (${audit.objectFit.length} media)`); for (const o of audit.objectFit.slice(0, 8)) lines.push(`  ${o.tag} ${o.objectFit}${o.objectPosition ? ` @ ${o.objectPosition}` : ""} ${o.src}`); }
      if (audit.scrollbarGutter?.hasGutter) { lines.push(`\n## Scrollbar gutter: ${audit.scrollbarGutter.hasGutter} elements (${audit.scrollbarGutter.stable} stable)`); }
      if (audit.cascadeLayers?.count) { lines.push(`\n## @layer: ${audit.cascadeLayers.count} layers`); lines.push(`  Names: ${audit.cascadeLayers.names.join(", ")}`); }
      if (audit.minMaxConstraints?.length) { lines.push("\n## Min/max width constraints"); for (const c of audit.minMaxConstraints.slice(0, 8)) lines.push(`  ${c.value} (${c.count} elements)`); }
      if (audit.gapAudit?.length) { lines.push("\n## Gap scale"); for (const g of audit.gapAudit.slice(0, 10)) lines.push(`  ${g.value} (${g.count} uses)`); }
      if (audit.stickyElements?.length) { lines.push(`\n## Sticky elements (${audit.stickyElements.length})`); for (const s of audit.stickyElements.slice(0, 10)) lines.push(`  ${s.tag}${s.class ? `.${s.class}` : ""} top:${s.top}${s.bottom ? ` bottom:${s.bottom}` : ""}${s.zIndex ? ` z:${s.zIndex}` : ""} ${s.width}x${s.height}px`); }
      if (audit.contrastRatios?.length) { lines.push(`\n## Contrast ratios (${audit.contrastRatios.filter(r => r.level === "Fail").length} fail, ${audit.contrastRatios.filter(r => r.level === "AA Large").length} AA Large, ${audit.contrastRatios.filter(r => r.level === "AA").length} AA)`); for (const r of audit.contrastRatios.filter(r => r.level === "Fail").slice(0, 10)) lines.push(`  ${r.tag} "${r.text}" — ${r.ratio}:1 (${r.level}) fg:${r.fg}`); }
      if (audit.customPropUsage?.totalUsages) { lines.push(`\n## Custom property usage: ${audit.customPropUsage.totalUsages} var() references`); for (const p of audit.customPropUsage.topProps.slice(0, 10)) lines.push(`  ${p.name} (${p.count} uses)`); }
      if (audit.fontSubsetting?.totalFaces) { lines.push(`\n## Font subsetting: ${audit.fontSubsetting.totalFaces} faces, ${audit.fontSubsetting.uniqueFamilies} families, ${audit.fontSubsetting.hasSubsetting} with unicode-range`); }
      if (audit.ariaRoles?.length) { lines.push("\n## ARIA roles"); for (const r of audit.ariaRoles) lines.push(`  ${r.role}: ${r.count}`); }
      if (audit.viewportUnits) { const v = audit.viewportUnits; const modern = (v.svh || 0) + (v.dvh || 0) + (v.lvh || 0); lines.push(`\n## Viewport units: ${v.vw} vw, ${v.vh} vh, ${modern} modern (svh/dvh/lvh), ${v.vmin} vmin, ${v.vmax} vmax, ${v.cqw + v.cqh} container (cqw/cqh), ${v.percent} percent`); if (v.vh && !modern) lines.push("  WARNING: using vh without svh/dvh fallback — mobile address bar causes layout shift"); }
      if (audit.gridAreas?.length) { lines.push(`\n## Grid template areas (${audit.gridAreas.length})`); for (const g of audit.gridAreas.slice(0, 5)) lines.push(`  ${g.tag}${g.class ? `.${g.class}` : ""} — ${g.areas}`); }
      if (audit.cursorAudit?.nonInteractivePointer?.length) { lines.push(`\n## Cursor issues: ${audit.cursorAudit.nonInteractivePointer.length} non-interactive elements with cursor:pointer`); for (const u of audit.cursorAudit.nonInteractivePointer.slice(0, 8)) lines.push(`  ${u.tag}${u.class ? `.${u.class}` : ""}`); }
      if (audit.textTransform?.length) { lines.push("\n## Text transform"); for (const t of audit.textTransform) lines.push(`  ${t.transform}: ${t.count} elements`); }
      if (audit.customScrollbars?.hasCustomScrollbar) { lines.push(`\n## Custom scrollbars: ${audit.customScrollbars.webkit ? "webkit" : ""}${audit.customScrollbars.firefox ? " firefox" : ""}`); }
      if (audit.selectionStyling?.hasSelectionStyling) { lines.push("\n## ::selection styling: present"); for (const r of (audit.selectionStyling.rules || [])) lines.push(`  ${r.selector} bg:${r.bg} color:${r.color}`); } else { lines.push("\n## ::selection styling: none (default browser selection colors)"); }
      if (audit.stackingIsolation && (audit.stackingIsolation.isolation || audit.stackingIsolation.backfaceHidden)) { lines.push(`\n## Stacking isolation: ${audit.stackingIsolation.isolation} isolation:isolate, ${audit.stackingIsolation.backfaceHidden} backface-visibility:hidden`); }
      if (audit.textFlow) { const t = audit.textFlow; const active = Object.entries(t).filter(([_,v]) => v > 0); if (active.length) { lines.push("\n## Text flow"); for (const [k, v] of active) lines.push(`  ${k}: ${v}`); } }
      if (audit.listStyles) { lines.push(`\n## Lists: ${audit.listStyles.ulCount} ul (${audit.listStyles.ulWithoutMarker} without marker), ${audit.listStyles.olCount} ol, ${audit.listStyles.dlCount} dl`); if (audit.listStyles.olTypes?.length) lines.push(`  ol types: ${audit.listStyles.olTypes.join(", ")}`); }
      if (audit.placeholderStyling?.hasPlaceholderStyling) { lines.push("\n## ::placeholder styling: present"); for (const r of (audit.placeholderStyling.rules || [])) lines.push(`  ${r.selector} color:${r.color}${r.opacity ? ` opacity:${r.opacity}` : ""}`); }
      if (audit.tableStrategy?.length) { lines.push(`\n## Table strategy (${audit.tableStrategy.length})`); for (const t of audit.tableStrategy) lines.push(`  layout:${t.layout} width:${t.width} ${t.borderCollapse}${t.emptyCells !== "show" ? ` empty-cells:${t.emptyCells}` : ""}`); }
      if (audit.textRendering?.textRendering?.length || audit.textRendering?.fontSmoothing?.length) { lines.push("\n## Text rendering"); if (audit.textRendering.textRendering?.length) for (const r of audit.textRendering.textRendering) lines.push(`  text-rendering: ${r.value} (${r.count} elements)`); if (audit.textRendering.fontSmoothing?.length) lines.push(`  -webkit-font-smoothing: ${audit.textRendering.fontSmoothing[0].smoothing} (${audit.textRendering.fontSmoothing.length}+ elements)`); }
      if (audit.dataAttributes?.length) { lines.push(`\n## data-* attribute usage (${audit.dataAttributes.length} prefixes)`); for (const d of audit.dataAttributes.slice(0, 10)) lines.push(`  ${d.prefix}: ${d.count}`); }
      if (audit.resolutionAudit?.hasMinResolution) { lines.push(`\n## Resolution media queries: ${audit.resolutionAudit.hasDppx ? "dppx" : ""} ${audit.resolutionAudit.hasDpi ? "dpi" : ""}`); for (const q of (audit.resolutionAudit.queries || [])) lines.push(`  ${q}`); }
      if (audit.backgroundAudit) { lines.push(`\n## Background strategy: ${audit.backgroundAudit.color} color, ${audit.backgroundAudit.image} image, ${audit.backgroundAudit.gradient} gradient, ${audit.backgroundAudit.backgroundClip} non-default clip`); }
      if (audit.cssFunctions?.length) { lines.push("\n## CSS functions"); for (const f of audit.cssFunctions) lines.push(`  ${f.fn}(): ${f.count} uses`); }
      if (audit.preflightReset) { lines.push(`\n## CSS reset: ${audit.preflightReset.likelyReset ? "detected" : "not detected"} (box-sizing:${audit.preflightReset.hasBoxSizing}, margin:0:${audit.preflightReset.hasMarginZero}, border:0:${audit.preflightReset.hasBorderZero})`); }
      if (audit.accordionDisclosure) { const d = audit.accordionDisclosure; lines.push(`\n## Native HTML components: ${d.detailsCount} details, ${d.dialogCount} dialog, ${d.popoverCount} popover`); if (d.hasNativeAccordion) lines.push("  Uses native <details> for accordions"); if (d.hasNativeDialog) lines.push("  Uses native <dialog>"); if (d.hasPopoverApi) lines.push("  Uses Popover API"); }
      if (audit.imageFormat) { const f = audit.imageFormat; lines.push(`\n## Image formats: ${f.webp} webp, ${f.avif} avif, ${f.jpg} jpg, ${f.png} png, ${f.svg} svg, ${f.gif} gif`); if (!f.webp && !f.avif && (f.jpg + f.png > 5)) lines.push("  WARNING: no modern image formats (webp/avif)"); }
      if (audit.counterContent?.hasCounter) { lines.push("\n## CSS counters"); for (const r of (audit.counterContent.rules || [])) lines.push(`  ${r}`); }
      if (audit.whitespaceHandling) { const w = audit.whitespaceHandling; lines.push(`\n## Whitespace: ${w.cssGap} gap elements, ${w.brTags} <br>, ${w.hrTags} <hr>${w.nbsp ? ", has &nbsp;" : ""}`); if (w.brTags > 10) lines.push(`  WARNING: ${w.brTags} <br> tags — use CSS spacing instead`); }
      if (audit.performanceBudget?.totalResources) { lines.push(`\n## Performance budget: ${audit.performanceBudget.totalResources} resources, ${audit.performanceBudget.totalSizeKB}KB total`); for (const [type, info] of Object.entries(audit.performanceBudget.byType)) lines.push(`  ${type}: ${info.count} requests, ${Math.round(info.size/1024)}KB`); if (audit.performanceBudget.slowestRequests?.length) { lines.push("  Slowest:"); for (const s of audit.performanceBudget.slowestRequests.slice(0, 3)) lines.push(`    ${s.duration}ms ${s.name}`); } }
      if (audit.colorSchemes?.count) { lines.push(`\n## Color schemes: ${audit.colorSchemes.count} dark/light variable sets`); for (const s of audit.colorSchemes.schemes.slice(0, 3)) lines.push(`  ${s.selector} — ${s.varCount} vars`); }
      if (audit.scrollbarWidth) { lines.push(`\n## Scrollbar: ${audit.scrollbarWidth.isOverlay ? "overlay (0px)" : `${audit.scrollbarWidth.scrollbarWidth}px`}`); }
      if (audit.textColumns?.length) { lines.push(`\n## CSS columns (${audit.textColumns.length})`); for (const c of audit.textColumns.slice(0, 5)) lines.push(`  ${c.tag}${c.class ? `.${c.class}` : ""} — ${c.columns} cols, gap:${c.gap}${c.hasRule ? ", has rule" : ""}`); }
      if (audit.outlineOffset?.recommendation) { lines.push(`\n## Focus outline: ${audit.outlineOffset.withOffset} with offset, ${audit.outlineOffset.withoutOffset} without — ${audit.outlineOffset.recommendation}`); }
      if (audit.cssCustomSelect) { lines.push(`\n## Select styling: ${audit.cssCustomSelect.total} total, ${audit.cssCustomSelect.customStyled} custom, ${audit.cssCustomSelect.native} native`); }
      if (audit.subgridUsage?.count) { lines.push(`\n## Subgrid: ${audit.subgridUsage.count} elements using subgrid`); }
      if (audit.langAndDir) { lines.push(`\n## Lang/dir: ${audit.langAndDir.lang || "MISSING"} / ${audit.langAndDir.dir}${audit.langAndDir.issue ? ` — ${audit.langAndDir.issue}` : ""}`); }
      if (audit.inputWidths?.length) { lines.push(`\n## Input width issues (${audit.inputWidths.length})`); for (const i of audit.inputWidths.slice(0, 10)) lines.push(`  ${i.type} ${i.name || ""} — ${i.width}px ${i.tooWide ? "(too wide >600px)" : "(too narrow <80px)"}`); }
      if (audit.contentEditable?.count) { lines.push(`\n## contenteditable: ${audit.contentEditable.count} elements, ${audit.contentEditable.withoutLabel} without label`); }
      if (audit.prefersContrast) { lines.push(`\n## prefers-contrast: ${audit.prefersContrast.hasPrefersContrast ? "present" : "MISSING"}, forced-colors: ${audit.prefersContrast.hasForcedColors ? "present" : "MISSING"}`); }
      if (audit.shapeOutside?.length) { lines.push(`\n## shape-outside (${audit.shapeOutside.length})`); for (const s of audit.shapeOutside.slice(0, 5)) lines.push(`  ${s.tag}${s.class ? `.${s.class}` : ""} — ${s.shape} (float:${s.float})`); }
      if (audit.cssNesting?.hasNesting) { lines.push(`\n## CSS nesting: ${audit.cssNesting.nestedRules} nested rules using & selector`); }
      if (audit.fieldsetLegend) { lines.push(`\n## Fieldset/legend: ${audit.fieldsetLegend.fieldsetCount} fieldsets (${audit.fieldsetLegend.withLegend} with legend, ${audit.fieldsetLegend.withoutLegend} without), ${audit.fieldsetLegend.ariaGroups} aria groups`); if (audit.fieldsetLegend.withoutLegend) lines.push(`  WARNING: ${audit.fieldsetLegend.withoutLegend} fieldsets without <legend>`); }
      if (audit.audioVideo) { const a = audit.audioVideo; if (a.videos || a.audios) { lines.push(`\n## Media: ${a.videos} videos, ${a.audios} audios`); if (a.videosWithoutControls) lines.push(`  WARNING: ${a.videosWithoutControls} videos without controls`); if (a.videos && !a.videosWithCaptions) lines.push(`  WARNING: no video captions detected`); if (a.videosAutoplay) lines.push(`  Autoplay: ${a.videosAutoplay}`); } }
      if (audit.skipLinks) { lines.push(`\n## Skip links: ${audit.skipLinks.hasSkipLink ? `${audit.skipLinks.total} found (${audit.skipLinks.alwaysVisible} visible, ${audit.skipLinks.hiddenUntilFocus} hidden-until-focus)` : "NONE — keyboard users must tab through entire header"}`); }
      if (audit.dupIds?.length) { lines.push(`\n## Duplicate IDs (${audit.dupIds.length})`); for (const id of audit.dupIds.slice(0, 10)) lines.push(`  #${id}`); }
      if (audit.emptyLinks?.length) { lines.push(`\n## Empty links (${audit.emptyLinks.length})`); for (const l of audit.emptyLinks.slice(0, 10)) lines.push(`  ${l.href}${l.class ? ` .${l.class}` : ""}`); }
      if (audit.liveRegions?.total) { lines.push(`\n## Live regions: ${audit.liveRegions.total} (polite:${audit.liveRegions.polite}, assertive:${audit.liveRegions.assertive})`); for (const r of (audit.liveRegions.items || []).slice(0, 5)) lines.push(`  ${r.tag} — aria-live:${r.live}${r.atomic ? ` atomic:${r.atomic}` : ""}`); }
      if (audit.mathFunctions?.length) { lines.push("\n## CSS math functions"); for (const f of audit.mathFunctions.slice(0, 10)) lines.push(`  ${f.fn}(): ${f.count} uses`); }
      if (audit.anchorScrolling) { lines.push(`\n## Anchor scrolling: ${audit.anchorScrolling.scrollBehavior}${audit.anchorScrolling.hasScrollPaddingTop ? `, scroll-padding-top:${audit.anchorScrolling.hasScrollPaddingTop}` : ""}`); if (audit.anchorScrolling.isSmooth && !audit.anchorScrolling.hasScrollPaddingTop) lines.push("  NOTE: smooth scroll without scroll-padding-top — sticky headers will overlap anchored content"); }
      if (audit.breadcrumbAudit) { lines.push(`\n## Breadcrumbs: ${audit.breadcrumbAudit.hasBreadcrumbNav ? "present" : "not found"}${audit.breadcrumbAudit.hasStructuredData ? " (with structured data)" : ""}`); if (audit.breadcrumbAudit.items?.length) lines.push(`  ${audit.breadcrumbAudit.items.join(" > ")}`); }
      if (audit.titleHierarchy?.issue) { lines.push(`\n## Title hierarchy: ${audit.titleHierarchy.issue}`); if (audit.titleHierarchy.docTitle) lines.push(`  <title>: ${audit.titleHierarchy.docTitle}`); if (audit.titleHierarchy.firstH1) lines.push(`  <h1>: ${audit.titleHierarchy.firstH1}`); }
      if (audit.duplicateTracking?.total) { lines.push(`\n## Analytics tracking: ${audit.duplicateTracking.total} scripts (${audit.duplicateTracking.services.join(", ")})`); if (audit.duplicateTracking.total > 3) lines.push(`  NOTE: ${audit.duplicateTracking.total} tracking scripts — consider consolidation for performance`); }
      if (audit.fontSwap) { lines.push(`\n## Font display: FOUT:${audit.fontSwap.hasFout}, FOIT:${audit.fontSwap.hasFoIT}, size-adjust:${audit.fontSwap.hasSizeAdjust}`); if (audit.fontSwap.recommendation) lines.push(`  ${audit.fontSwap.recommendation}`); }
      if (audit.cssCustomPropsFallback?.withoutFallback > 0) { lines.push(`\n## CSS var() fallback: ${audit.cssCustomPropsFallback.withFallback} with, ${audit.cssCustomPropsFallback.withoutFallback} without fallback`); if (audit.cssCustomPropsFallback.recommendation) lines.push(`  ${audit.cssCustomPropsFallback.recommendation}`); }
      if (audit.inputWidthCols?.length) { lines.push(`\n## Input dimensions (${audit.inputWidthCols.length} inputs)`); for (const i of audit.inputWidthCols.slice(0, 8)) lines.push(`  ${i.type} "${i.label}" — ${i.width}x${i.height}px${i.borderRadius ? ` r:${i.borderRadius}` : ""}`); }
      if (audit.headingDensity?.total) { lines.push(`\n## Heading density: ${audit.headingDensity.total} headings over ~${audit.headingDensity.estimatedScreens} screens (${audit.headingDensity.headingsPerScreen}/screen)`); if (audit.headingDensity.issue) lines.push(`  ${audit.headingDensity.issue}`); }
      if (audit.listSemantics?.issue) { lines.push(`\n## List semantics: ${audit.listSemantics.semanticLists} semantic lists, ${audit.listSemantics.divAsList} div-as-list`); lines.push(`  ${audit.listSemantics.issue}`); }
      if (audit.buttonVsLink?.issue) { lines.push(`\n## Button vs link: ${audit.buttonVsLink.linksAsButtons} links-as-buttons, ${audit.buttonVsLink.buttonsAsNav} buttons-as-nav`); lines.push(`  ${audit.buttonVsLink.issue}`); }
      if (audit.fileInputAudit?.length) { lines.push(`\n## File inputs (${audit.fileInputAudit.length})`); for (const f of audit.fileInputAudit) lines.push(`  accept:${f.accept || "*"} multiple:${f.multiple} capture:${f.capture || "no"} label:${f.hasAriaLabel ? "yes" : "NO"}`); }
      if (audit.regionLandmarks?.length) { lines.push(`\n## Landmarks (${audit.regionLandmarks.length})`); for (const l of audit.regionLandmarks) lines.push(`  <${l.tag}> role=${l.role} (${l.count})`); }
      if (audit.colorScheme) { lines.push(`\n## color-scheme: ${audit.colorScheme.cssColorScheme || "not set"}${audit.colorScheme.hasMetaTag ? `, meta: ${audit.colorScheme.metaValue}` : ""}`); if (!audit.colorScheme.cssColorScheme && !audit.colorScheme.hasMetaTag) lines.push("  NOTE: no color-scheme set — form controls use default UA styling"); }
      if (audit.reducedData) { lines.push(`\n## prefers-reduced-data: ${audit.reducedData.hasReducedData ? "present" : "MISSING"}`); }
      if (audit.propertyRegistration?.count) { lines.push(`\n## @property: ${audit.propertyRegistration.count} registered custom properties`); for (const p of (audit.propertyRegistration.props || []).slice(0, 5)) lines.push(`  ${p}`); }
      if (audit.scrollDrivenAnimations?.count) { lines.push(`\n## Scroll-driven animations: ${audit.scrollDrivenAnimations.count} (scroll:${audit.scrollDrivenAnimations.types.scroll}, view:${audit.scrollDrivenAnimations.types.view})`); }
      if (audit.autocapitalizeAudit?.length) { lines.push(`\n## Autocapitalize issues (${audit.autocapitalizeAudit.length})`); for (const a of audit.autocapitalizeAudit.slice(0, 10)) lines.push(`  ${a.type} ${a.name || ""} — ${a.issue}`); }
      if (audit.focusManagement) { lines.push(`\n## Focus management: ${audit.focusManagement.autofocusElements} autofocus, ${audit.focusManagement.inertElements} inert, ${audit.focusManagement.hiddenElements} hidden, skip link:${audit.focusManagement.hasSkipLink ? "yes" : "no"}`); }
      if (audit.viewportMetaDetailed) { lines.push(`\n## Viewport meta: ${audit.viewportMetaDetailed.found ? audit.viewportMetaDetailed.content : "MISSING"}`); if (audit.viewportMetaDetailed.issue) lines.push(`  WARNING: ${audit.viewportMetaDetailed.issue}`); if (audit.viewportMetaDetailed.disablesZoom) lines.push("  WARNING: zoom is disabled — WCAG 1.4.4 failure"); }
      if (audit.cssNestingDepth?.nestedCount) { lines.push(`\n## CSS nesting: ${audit.cssNestingDepth.nestedCount} nested rules, max depth ${audit.cssNestingDepth.maxDepth}`); if (audit.cssNestingDepth.maxDepth > 3) lines.push("  NOTE: deep nesting (>3) reduces readability"); }
      if (audit.loadingStrategy) { const l = audit.loadingStrategy; lines.push(`\n## Loading strategy: images ${l.images.lazy} lazy/${l.images.eager} eager/${l.images.none} none, scripts ${l.scripts.async} async/${l.scripts.defer} defer/${l.scripts.blocking} blocking`); if (l.scripts.blocking > 3) lines.push(`  WARNING: ${l.scripts.blocking} render-blocking scripts`); if (l.images.total > 5 && l.images.lazy < l.images.total / 2) lines.push("  NOTE: most images are not lazy-loaded"); }
      if (audit.trigFunctions?.total) { lines.push(`\n## CSS trig/math constants: ${audit.trigFunctions.total} types`); for (const f of audit.trigFunctions.functions) lines.push(`  ${f.fn}(): ${f.count} uses`); }
      if (audit.lineHeightRatio?.length) { lines.push(`\n## Line-height ratio issues (${audit.lineHeightRatio.length})`); for (const l of audit.lineHeightRatio.slice(0, 10)) lines.push(`  ${l.tag} ${l.fontSize}/${l.lineHeight} ratio:${l.ratio} — ${l.issue}`); }
      if (audit.letterSpacingAudit?.length) { lines.push(`\n## Letter spacing (${audit.letterSpacingAudit.length} elements with tracking)`); for (const l of audit.letterSpacingAudit.slice(0, 8)) lines.push(`  ${l.tag} ${l.letterSpacing} "${l.textPreview}"`); }
      if (audit.visibleOverflow?.length) { lines.push(`\n## Visible overflow (${audit.visibleOverflow.length} children overflowing parents)`); for (const o of audit.visibleOverflow.slice(0, 8)) lines.push(`  ${o.tag} → ${o.childTag} ${o.issue}`); }
      if (audit.cssComplexity) { lines.push(`\n## CSS complexity: ${audit.cssComplexity.totalSelectors} selectors, ${audit.cssComplexity.totalDeclarations} declarations, avg ${audit.cssComplexity.avgPerRule}/rule, max ${audit.cssComplexity.maxDeclarationsPerRule}/rule`); }
      if (audit.viewTransitions?.count) { lines.push(`\n## View transitions: ${audit.viewTransitions.count} named transitions (${audit.viewTransitions.names.join(", ")})`); }
      if (audit.pointerHover) { const p = audit.pointerHover; lines.push(`\n## Pointer/hover media queries: ${p.hasFinePointer ? "fine" : ""} ${p.hasCoarsePointer ? "coarse" : ""} ${p.hasHoverCapability ? "hover" : ""} ${p.hasNoHover ? "no-hover" : ""}`); if (!p.hasCoarsePointer) lines.push("  NOTE: no pointer:coarse query — touch interactions may not be optimized"); }
      if (audit.tabularNumbers?.hasTabular) { lines.push(`\n## Tabular numbers: ${audit.tabularNumbers.items.length} elements using font-variant-numeric`); for (const t of audit.tabularNumbers.items.slice(0, 5)) lines.push(`  ${t.tag} — ${t.variant}`); } else { lines.push("\n## Tabular numbers: none (tables/numbers may misalign without tabular-nums)"); }
      if (audit.hasLargeText) { const t = audit.hasLargeText; lines.push(`\n## Text size distribution: ${t.large} large (>=24px), ${t.normal} normal (>=16px), ${t.small} small (<16px)`); if (t.issue) lines.push(`  WARNING: ${t.issue}`); }
      if (audit.gridItemAudit?.length) { lines.push(`\n## Grid item placement (${audit.gridItemAudit.length})`); for (const g of audit.gridItemAudit.slice(0, 10)) lines.push(`  ${g.tag}${g.class ? `.${g.class}` : ""} col:${g.gridColumn}${g.gridRow ? ` row:${g.gridRow}` : ""}`); }
      if (audit.cssAtRules?.length) { lines.push("\n## CSS @-rules"); for (const r of audit.cssAtRules) lines.push(`  @${r.type}: ${r.count}`); }
      if (audit.keyframeAnimations?.total) { lines.push(`\n## @keyframes: ${audit.keyframeAnimations.total} defined`); lines.push(`  ${audit.keyframeAnimations.names.slice(0, 10).join(", ")}`); }
      if (audit.widthCalcAudit?.length) { lines.push(`\n## calc() width (${audit.widthCalcAudit.length} elements)`); for (const w of audit.widthCalcAudit.slice(0, 8)) lines.push(`  ${w.tag}${w.class ? `.${w.class}` : ""} — ${w.width}`); }
      if (audit.scrollDriven?.hasScrollTimeline || audit.scrollDriven?.hasViewTimeline) { lines.push(`\n## Scroll timelines: ${audit.scrollDriven.hasScrollTimeline ? "scroll" : ""} ${audit.scrollDriven.hasViewTimeline ? "view" : ""}`); }
      if (audit.namedGridLines?.length) { lines.push(`\n## Named grid lines: ${audit.namedGridLines.join(", ")}`); }
      if (audit.anchorPositioning?.count) { lines.push(`\n## CSS anchor positioning: ${audit.anchorPositioning.count} rules`); }
      if (audit.fontFeatureSettings?.length) { lines.push("\n## Font feature settings"); for (const f of audit.fontFeatureSettings) lines.push(`  ${f.value} (${f.count} elements)`); }
      if (audit.mathStyle && (audit.mathStyle.mathDepth || audit.mathStyle.mathShift || audit.mathStyle.mathVariant)) { lines.push("\n## Math CSS: detected math properties"); }
      if (audit.conditionalRules) { lines.push(`\n## Conditional CSS: ${audit.conditionalRules.supportsCount} @supports, ${audit.conditionalRules.mediaCount} @media`); for (const f of (audit.conditionalRules.supportsFeatures || []).slice(0, 5)) lines.push(`  @supports ${f}`); }
      if (audit.boxModelAudit?.length) { lines.push(`\n## Box model issues (${audit.boxModelAudit.length})`); for (const b of audit.boxModelAudit.slice(0, 8)) lines.push(`  ${b.tag}${b.class ? `.${b.class}` : ""} — ${b.issue}`); }
      if (audit.counterStyle?.count) { lines.push(`\n## @counter-style: ${audit.counterStyle.count} custom counter styles (${audit.counterStyle.names.join(", ")})`); }
      if (audit.initialLetter?.length) { lines.push(`\n## initial-letter: ${audit.initialLetter.length} drop caps`); for (const d of audit.initialLetter) lines.push(`  ${d.tag} — ${d.initialLetter}`); }
      if (audit.cssSupports?.length) { lines.push(`\n## @supports features (${audit.cssSupports.length})`); for (const s of audit.cssSupports.slice(0, 10)) lines.push(`  ${s.negated ? "NOT " : ""}${s.condition}`); }
      if (audit.textWrapAudit?.length) { lines.push("\n## text-wrap"); for (const t of audit.textWrapAudit) lines.push(`  ${t.value}: ${t.count} elements`); }
      if (audit.lineClampAudit?.length) { lines.push(`\n## Line clamp (${audit.lineClampAudit.length})`); for (const l of audit.lineClampAudit.slice(0, 8)) lines.push(`  ${l.tag}${l.class ? `.${l.class}` : ""} — ${l.lines} lines`); }
      if (audit.rubyAnnotation?.hasRuby) { lines.push(`\n## Ruby annotations: ${audit.rubyAnnotation.rubyCount} ruby, ${audit.rubyAnnotation.rtCount} rt, ${audit.rubyAnnotation.rpCount} rp`); }
      if (audit.inheritViewport) { lines.push(`\n## Viewport units: svh:${audit.inheritViewport.hasSvh} dvh:${audit.inheritViewport.hasDvh} lvh:${audit.inheritViewport.hasLvh}`); if (!audit.inheritViewport.hasDvh && !audit.inheritViewport.hasSvh) lines.push("  NOTE: no modern viewport units — vh causes mobile address bar shift"); }
      if (audit.colorGamut) { lines.push(`\n## Color gamut: srgb:${audit.colorGamut.hasSrgb} p3:${audit.colorGamut.hasP3} rec2020:${audit.colorGamut.hasRec2020}`); if (audit.colorGamut.hasP3) lines.push("  Uses display-p3 media query — wide gamut color support"); }
      if (audit.forcedColors) { lines.push(`\n## Forced colors: ${audit.forcedColors.hasForcedColors ? "supported" : "MISSING"}`); }
      if (audit.contentVisibility?.count) { lines.push(`\n## content-visibility:auto: ${audit.contentVisibility.count} elements`); for (const c of audit.contentVisibility.items.slice(0, 5)) lines.push(`  ${c.tag}${c.class ? `.${c.class}` : ""} ${c.height}px${c.containIntrinsicSize ? ` intrinsic:${c.containIntrinsicSize}` : ""}`); }
      if (audit.textUnderlineOffset?.length) { lines.push("\n## Underline styling"); for (const u of audit.textUnderlineOffset) lines.push(`  ${u.value} (${u.count} elements)`); }
      if (audit.gridAutoFlow?.length) { lines.push("\n## Grid auto-flow"); for (const g of audit.gridAutoFlow) lines.push(`  ${g.value}: ${g.count} containers`); }
      if (audit.gapShorthand) { lines.push(`\n## Gap shorthand: ${audit.gapShorthand.usesGap} use gap, ${audit.gapShorthand.usesRowColGap} use row-gap/column-gap separately`); }
      if (audit.descendentSelectors?.count) { lines.push(`\n## Deep descendent selectors (${audit.descendentSelectors.count} with 3+ levels)`); for (const s of (audit.descendentSelectors.samples || []).slice(0, 5)) lines.push(`  ${s}`); }
      if (audit.textOrientation?.length) { lines.push(`\n## Text orientation (${audit.textOrientation.length})`); for (const t of audit.textOrientation) lines.push(`  ${t.tag} — ${t.textOrientation} (${t.writingMode})`); }
      if (audit.colorContrastPairs?.length) { lines.push(`\n## Color contrast pairs (${audit.colorContrastPairs.filter(p => p.level === "Fail").length} fail)`); for (const p of audit.colorContrastPairs.slice(0, 10)) lines.push(`  ${p.fg} on ${p.bg} — ${p.ratio}:1 (${p.level}) x${p.count}`); }
      if (audit.variableFonts?.count) { lines.push(`\n## Variable fonts: ${audit.variableFonts.count} elements with font-variation-settings`); for (const v of audit.variableFonts.items.slice(0, 5)) lines.push(`  ${v.tag} ${v.fontFamily} — ${v.variation}`); }
      if (audit.overscrollBehavior?.length) { lines.push("\n## Overscroll behavior"); for (const o of audit.overscrollBehavior) lines.push(`  ${o.value}: ${o.count} elements`); }
      if (audit.reducedTransparency) { lines.push(`\n## prefers-reduced-transparency: ${audit.reducedTransparency.hasReducedTransparency ? "present" : "MISSING"}`); }
      if (audit.scopeRules?.count) { lines.push(`\n## @scope: ${audit.scopeRules.count} rules (${audit.scopeRules.scopes.join(", ")})`); }
      if (audit.fieldSizing?.length) { lines.push(`\n## field-sizing (${audit.fieldSizing.length})`); for (const f of audit.fieldSizing) lines.push(`  ${f.tag}${f.type ? `[${f.type}]` : ""} — ${f.fieldSizing}`); }
      if (audit.textSpacingTrim?.hasTextSpacingTrim) { lines.push("\n## text-spacing-trim: present"); }
      if (audit.interpolateSize?.hasAllowKeywords || audit.interpolateSize?.hasNumericOnly) { lines.push(`\n## interpolate-size: ${audit.interpolateSize.hasAllowKeywords ? "allow-keywords" : ""} ${audit.interpolateSize.hasNumericOnly ? "numeric-only" : ""}`); }
      if (audit.fontPalette?.count) { lines.push(`\n## @font-palette-values: ${audit.fontPalette.count} palettes (${audit.fontPalette.palettes.join(", ")})`); }
      if (audit.startingStyle?.count) { lines.push(`\n## @starting-style: ${audit.startingStyle.count} rules`); }
      if (audit.scrollDrivenProgress?.count) { lines.push(`\n## Scroll-driven animation ranges: ${audit.scrollDrivenProgress.count}`); for (const r of audit.scrollDrivenProgress.ranges.slice(0, 5)) lines.push(`  ${r}`); }
      if (audit.directionAware) { const d = audit.directionAware; const active = Object.entries(d).filter(([_,v]) => v > 0); if (active.length) { lines.push("\n## Direction-aware properties (i18n)"); for (const [k, v] of active) lines.push(`  ${k}: ${v} elements`); } }
      if (audit.colorFunctionLevel?.length) { lines.push("\n## Color function level"); for (const c of audit.colorFunctionLevel) lines.push(`  ${c.fn}(): ${c.count} uses`); }
      if (audit.scrollTimelineNamed?.count) { lines.push(`\n## Named scroll/view timelines: ${audit.scrollTimelineNamed.count} (${audit.scrollTimelineNamed.names.join(", ")})`); }
      if (audit.transitionProperties?.length) { lines.push("\n## Transition properties"); for (const t of audit.transitionProperties.slice(0, 10)) lines.push(`  ${t.prop}: ${t.count} elements`); }
      if (audit.originReporting) { lines.push(`\n## Origin trials: ${audit.originReporting.hasOriginTrial ? "present" : "none"}, Permissions-Policy: ${audit.originReporting.hasPermissionsPolicy ? "present" : "MISSING"}`); }
      if (audit.baselineAudit?.totalModernFeatures) { lines.push(`\n## Baseline: ${audit.baselineAudit.totalModernFeatures} modern CSS features detected`); lines.push(`  ${audit.baselineAudit.features.join(", ")}`); }
      if (audit.hasSelectorAudit?.count) { lines.push(`\n## :has() selector: ${audit.hasSelectorAudit.count} rules`); for (const s of audit.hasSelectorAudit.samples.slice(0, 5)) lines.push(`  ${s}`); }
      if (audit.isWhereSelectors && (audit.isWhereSelectors.isCount || audit.isWhereSelectors.whereCount)) { lines.push(`\n## :is()/:where() selectors: ${audit.isWhereSelectors.isCount} :is, ${audit.isWhereSelectors.whereCount} :where`); for (const s of audit.isWhereSelectors.samples.slice(0, 5)) lines.push(`  ${s.type}(${s.selector})`); }
      if (audit.nestingCompatability) { lines.push(`\n## CSS nesting: ${audit.nestingCompatability.hasNativeNesting ? "native" : "not detected"}`); if (audit.nestingCompatability.recommendation) lines.push(`  ${audit.nestingCompatability.recommendation}`); }
      if (audit.pageTransitionTypes?.count) { lines.push(`\n## View transition types: ${audit.pageTransitionTypes.count} named (${audit.pageTransitionTypes.types.join(", ")})`); }
      if (audit.positionTry?.count) { lines.push(`\n## position-try: ${audit.positionTry.count} rules`); for (const f of audit.positionTry.fallbacks.slice(0, 5)) lines.push(`  ${f}`); }
      if (audit.cssBaselineStatus) { const b = audit.cssBaselineStatus; if (b.widely || b.newly || b.limited) { lines.push(`\n## Baseline status: ${b.widely} widely-available, ${b.newly} newly-available, ${b.limited} limited`); } }
      if (audit.inputEnterKeyHint?.length) { lines.push(`\n## enterkeyhint issues (${audit.inputEnterKeyHint.length})`); for (const i of audit.inputEnterKeyHint.slice(0, 10)) lines.push(`  ${i.type} ${i.name || ""} — ${i.issue}`); }
      if (audit.cssBorderImage?.length) { lines.push(`\n## Border-image (${audit.cssBorderImage.length})`); for (const b of audit.cssBorderImage.slice(0, 5)) lines.push(`  ${b.tag} — ${b.borderImage}`); }
      if (audit.anchorInset?.count) { lines.push(`\n## Anchor inset-area/position-visibility: ${audit.anchorInset.count} rules`); }
      if (audit.textAutospace?.count) { lines.push(`\n## text-autospace: ${audit.textAutospace.count} rules`); }
      if (audit.spreadGlyph && (audit.spreadGlyph.cssCount || audit.spreadGlyph.dataAttrCount)) { lines.push(`\n## Text group align: ${audit.spreadGlyph.cssCount} CSS rules, ${audit.spreadGlyph.dataAttrCount} data attrs`); }
      if (audit.crossOriginIsolation) { lines.push(`\n## Security context: crossOriginIsolated:${audit.crossOriginIsolation.crossOriginIsolated}, secure:${audit.crossOriginIsolation.isSecureContext}, SharedArrayBuffer:${audit.crossOriginIsolation.hasSharedArrayBuffer}`); }
      if (audit.paintWorklet) { lines.push(`\n## Houdini worklets: paint:${audit.paintWorklet.paintWorklet}, layout:${audit.paintWorklet.layoutWorklet}, animation:${audit.paintWorklet.animationWorklet}`); }
      if (audit.flexWrapAudit?.length) { lines.push(`\n## Flex nowrap overflow (${audit.flexWrapAudit.length})`); for (const f of audit.flexWrapAudit.slice(0, 5)) lines.push(`  ${f.tag}${f.class ? `.${f.class}` : ""} — ${f.childWidth}px children in ${f.containerWidth}px container`); }
      if (audit.colorSpaceMeta) { lines.push(`\n## Color space: ${audit.colorSpaceMeta.cssColorSpace}${audit.colorSpaceMeta.hasColorProfileMeta ? `, meta: ${audit.colorSpaceMeta.profileValue}` : ""}`); }
      if (audit.scrollbarColor?.length) { lines.push(`\n## scrollbar-color (${audit.scrollbarColor.length})`); for (const s of audit.scrollbarColor.slice(0, 5)) lines.push(`  ${s.tag} — ${s.scrollbarColor}`); }
      if (audit.transformOrigin?.length) { lines.push("\n## Non-default transform-origin"); for (const t of audit.transformOrigin.slice(0, 5)) lines.push(`  ${t.value} (${t.count} elements)`); }
      if (audit.outlineStyleAudit?.length) { lines.push("\n## Focus outline styles"); for (const o of audit.outlineStyleAudit.slice(0, 5)) lines.push(`  ${o.value} (${o.count} elements)`); }
      if (audit.prefersInstant) { lines.push(`\n## prefers-instant: ${audit.prefersInstant.hasPrefersInstant ? "present" : "MISSING"}`); }
      if (audit.selectAccentColor?.hasCustomAccent) { lines.push(`\n## accent-color: ${audit.selectAccentColor.items.length} custom-styled inputs`); for (const a of audit.selectAccentColor.items.slice(0, 5)) lines.push(`  ${a.type} — ${a.accentColor}`); } else { lines.push("\n## accent-color: none — checkboxes/radios use default UA blue"); }
      if (audit.crossOriginCSS?.count) { lines.push(`\n## Cross-origin CSS: ${audit.crossOriginCSS.count} sheets`); for (const s of audit.crossOriginCSS.sheets.slice(0, 5)) lines.push(`  ${s.href}${s.blocked ? " (BLOCKED — can't read rules)" : s.cors ? ` crossorigin=${s.cors}` : ""}`); }
      if (audit.stickyStacking?.conflicts?.length) { lines.push(`\n## Sticky stacking conflicts (${audit.stickyStacking.conflicts.length})`); for (const c of audit.stickyStacking.conflicts) lines.push(`  ${c.elements.join(" vs ")} — ${c.issue}`); }
      if (audit.verticalRhythm) { lines.push(`\n## Vertical rhythm: ${audit.verticalRhythm.hasConsistentBase ? `consistent` : `inconsistent`} (bases: ${audit.verticalRhythm.spacingBases.join(", ")}px)`); if (!audit.verticalRhythm.hasConsistentBase && audit.verticalRhythm.spacingBases.length > 5) lines.push("  WARNING: many spacing values — not a clear rhythm scale"); }
      if (audit.inputTypeAudit?.length) { lines.push(`\n## Input type issues (${audit.inputTypeAudit.length})`); for (const i of audit.inputTypeAudit.slice(0, 10)) lines.push(`  ${i.name || ""} — ${i.issue}`); }
      if (audit.layoutShiftRisk?.length) { lines.push(`\n## CLS risks (${audit.layoutShiftRisk.length})`); for (const r of audit.layoutShiftRisk.slice(0, 10)) lines.push(`  ${r.tag} ${r.src || ""} — ${r.risk}`); }
      if (audit.responsiveFontScale?.hasFluidType) { lines.push(`\n## Fluid typography: ${audit.responsiveFontScale.items.length} elements with clamp/vw/cq units`); for (const f of audit.responsiveFontScale.items.slice(0, 5)) lines.push(`  ${f.tag} — ${f.fontSize}`); } else { lines.push("\n## Fluid typography: none — consider clamp() for responsive font sizes"); }
      if (audit.dataUriAssets && (audit.dataUriAssets.inlineImages || audit.dataUriAssets.inlineFonts || audit.dataUriAssets.inlineSvgs)) { lines.push(`\n## Inline data URIs: ${audit.dataUriAssets.inlineImages} images, ${audit.dataUriAssets.inlineFonts} fonts, ${audit.dataUriAssets.inlineSvgs} SVGs (~${audit.dataUriAssets.estimatedSizeKB}KB)`); if (audit.dataUriAssets.estimatedSizeKB > 50) lines.push("  WARNING: large inline data — bloats HTML/CSS, consider external files"); }
      if (audit.printPageBreak) { lines.push(`\n## Print page breaks: ${audit.printPageBreak.hasPrintRules ? `break-before:${audit.printPageBreak.hasBreakBefore} break-after:${audit.printPageBreak.hasBreakAfter} break-inside:${audit.printPageBreak.hasBreakInside} page-size:${audit.printPageBreak.hasPageSize}` : "no print break rules"}`); }
      if (audit.focusVisibleStyles?.count) { lines.push(`\n## :focus-visible styles: ${audit.focusVisibleStyles.count} rules`); for (const r of audit.focusVisibleStyles.rules.slice(0, 5)) lines.push(`  ${r.selector} — ${r.outline || r.boxShadow || r.border || "custom"}`); } else { lines.push("\n## :focus-visible: NONE — keyboard focus uses default UA outline or :focus only"); }
      if (audit.spacingScale?.values?.length) { lines.push(`\n## Spacing scale: ${audit.spacingScale.values.length} values${audit.spacingScale.likelyBase ? `, likely base ${audit.spacingScale.likelyBase}px` : ""}`); for (const v of audit.spacingScale.values.slice(0, 10)) lines.push(`  ${v.px}px (${v.count} uses)`); }
      if (audit.dimensionAudit?.length) { lines.push(`\n## Dimension issues (${audit.dimensionAudit.length})`); for (const d of audit.dimensionAudit.slice(0, 8)) lines.push(`  ${d.tag} ${d.src} — ${d.issue}`); }
      if (audit.metaThemeColor) { lines.push(`\n## Theme color: ${audit.metaThemeColor.themeColor || "not set"}${audit.metaThemeColor.hasAppleStatusBar ? `, Apple status bar: ${audit.metaThemeColor.appleStyle}` : ""}`); if (!audit.metaThemeColor.hasThemeColor) lines.push("  NOTE: no theme-color — mobile browser chrome uses default color"); }
      if (audit.formValidation) { const f = audit.formValidation; lines.push(`\n## Form validation: ${f.totalInputs} inputs — required:${f.required}, pattern:${f.pattern}, minLength:${f.minLength}, maxLength:${f.maxLength}, min/max:${f.min}/${f.max}, step:${f.step}${f.formsWithNoValidate ? `, ${f.formsWithNoValidate} forms with novalidate` : ""}`); }
      if (audit.cssPrefixAudit?.total) { lines.push(`\n## Vendor prefixes: ${audit.cssPrefixAudit.total} total (webkit:${audit.cssPrefixAudit.webkit}, moz:${audit.cssPrefixAudit.moz}, ms:${audit.cssPrefixAudit.ms}, o:${audit.cssPrefixAudit.o})`); if (audit.cssPrefixAudit.webkit > 50) lines.push("  NOTE: many -webkit- prefixes — consider autoprefixer or removing legacy prefixes"); }
      if (audit.gridMinmax?.length) { lines.push(`\n## Grid minmax (${audit.gridMinmax.length})`); for (const g of audit.gridMinmax.slice(0, 5)) lines.push(`  ${g.tag}${g.class ? `.${g.class}` : ""} — ${g.columns}`); }
      if (audit.containerType?.length) { lines.push(`\n## Container type (${audit.containerType.length})`); for (const c of audit.containerType.slice(0, 5)) lines.push(`  ${c.tag}${c.class ? `.${c.class}` : ""} — ${c.containerType} (${c.width}px)`); }
      if (audit.pageLayoutType) { lines.push(`\n## Page layout: ${audit.pageLayoutType.layoutType}${audit.pageLayoutType.hasSidebar ? `, sidebar (${audit.pageLayoutType.sidebarPosition})` : ""}`); }
      if (audit.fontStack?.length) { lines.push(`\n## Font stacks (${audit.fontStack.length})`); for (const f of audit.fontStack.slice(0, 5)) lines.push(`  ${f.primary} (${f.count} uses: ${f.sampleTags.join(",")}) — ${f.stack.slice(0, 50)}`); }
      if (audit.headingSizes?.items?.length) { lines.push(`\n## Heading scale: ${audit.headingSizes.hasScale ? "has scale" : "incomplete"}${audit.headingSizes.hasConsistentRatio ? ", consistent ratio" : ""}`); for (const h of audit.headingSizes.items) lines.push(`  h${h.level}: ${h.fontSize} / ${h.fontWeight} / lh:${h.lineHeight}`); }
      if (audit.linkTargetAudit?.issue) { lines.push(`\n## Link target issues: ${audit.linkTargetAudit.targetBlank} target=_blank, ${audit.linkTargetAudit.blankWithoutNoopener} without rel=noopener`); lines.push(`  ${audit.linkTargetAudit.issue}`); }
      if (audit.cssLineBreak?.length) { lines.push("\n## Line break / word break"); for (const l of audit.cssLineBreak) lines.push(`  ${l.value} (${l.count} elements)`); }
      if (audit.pageWeight?.totalKB) { lines.push(`\n## Page weight: ${audit.pageWeight.totalKB}KB total — HTML:${audit.pageWeight.htmlKB}, CSS:${audit.pageWeight.cssKB}, JS:${audit.pageWeight.jsKB}, img:${audit.pageWeight.imgKB}, font:${audit.pageWeight.fontKB}`); if (audit.pageWeight.jsKB > 500) lines.push(`  WARNING: ${audit.pageWeight.jsKB}KB JS — consider code splitting`); if (audit.pageWeight.totalKB > 3000) lines.push(`  WARNING: ${audit.pageWeight.totalKB}KB total — heavy page`); }
      if (audit.errorHandling?.issue) { lines.push(`\n## Error handling: window.onerror:${audit.errorHandling.hasWindowOnError}, unhandledrejection:${audit.errorHandling.hasUnhandledRejection}, inline onerror:${audit.errorHandling.inlineOnError}`); lines.push(`  ${audit.errorHandling.issue}`); }
      if (audit.lazyIframe?.issue) { lines.push(`\n## Iframe loading: ${audit.lazyIframe.total} total, ${audit.lazyIframe.lazy} lazy, ${audit.lazyIframe.eager} eager, ${audit.lazyIframe.none} none`); lines.push(`  ${audit.lazyIframe.issue}`); }
      if (audit.cssResetType) { const r = audit.cssResetType; lines.push(`\n## CSS reset: ${r.tailwind ? "Tailwind" : r.normalize ? "Normalize" : r.sanitize ? "Sanitize" : r.reset ? "custom reset" : "none detected"}`); }
      if (audit.cssCommentDensity?.totalRules) { lines.push(`\n## CSS comments: ${audit.cssCommentDensity.totalComments} in ${audit.cssCommentDensity.totalRules} rules (${audit.cssCommentDensity.ratio} ratio)`); if (audit.cssCommentDensity.ratio === 0) lines.push("  NOTE: no CSS comments — documentation would help maintainability"); }
      if (audit.defaultFormColors?.issue) { lines.push(`\n## Form control styling: ${audit.defaultFormColors.total} controls, ${audit.defaultFormColors.customBackground} custom bg, ${audit.defaultFormColors.customBorder} custom border`); lines.push(`  ${audit.defaultFormColors.issue}`); }
      if (audit.interactionStates?.issue) { lines.push(`\n## Interaction states: :hover:${audit.interactionStates.hover}, :focus:${audit.interactionStates.focus}, :focus-visible:${audit.interactionStates.focusVisible}, :active:${audit.interactionStates.active}`); lines.push(`  ${audit.interactionStates.issue}`); }
      if (audit.cssZindexScale?.issue) { lines.push(`\n## Z-index scale: ${audit.cssZindexScale.count} values (${audit.cssZindexScale.values.slice(0, 10).join(", ")})`); lines.push(`  ${audit.cssZindexScale.issue}`); }
      if (audit.motionPreference?.issue) { lines.push(`\n## Motion preference: reduced:${audit.motionPreference.hasReducedMotion}, no-preference:${audit.motionPreference.hasNoPreference}, instant:${audit.motionPreference.hasInstant}`); lines.push(`  ${audit.motionPreference.issue}`); }
      if (audit.formAutocomplete?.withoutAutocomplete > 0) { lines.push(`\n## Autocomplete: ${audit.formAutocomplete.withAutocomplete}/${audit.formAutocomplete.total} have autocomplete`); for (const m of audit.formAutocomplete.missing.slice(0, 5)) lines.push(`  ${m.type} ${m.label || m.name || ""} — missing autocomplete`); }
      if (audit.fontFormatAudit) { const f = audit.fontFormatAudit; if (f.woff2 + f.woff + f.ttf + f.otf + f.eot > 0) { lines.push(`\n## Font formats: woff2:${f.woff2}, woff:${f.woff}, ttf:${f.ttf}, otf:${f.otf}, eot:${f.eot}`); if (f.issue) lines.push(`  ${f.issue}`); } }
      return { text: lines.join("\n"), audit };
    }
    case "page.css": {
      const tab = await getTabByParams(params);
      if (params.foreground) await bringToFront(tab);
      const results = await executeScriptTimed({
        target: { tabId: tab.id, frameIds: [0] },
        world: "MAIN",
        func: (sel, uid) => {
          const state = window.__PI_CHROME_STATE__;
          const el = uid && state && state.elements && state.elements[uid] ? state.elements[uid] : (sel ? document.querySelector(sel) : null);
          if (!el) return null;
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const props = ["display","position","top","right","bottom","left","z-index","width","height","min-width","max-width","padding","padding-top","padding-right","padding-bottom","padding-left","margin","margin-top","margin-right","margin-bottom","margin-left","border","border-width","border-color","border-radius","background-color","color","font-family","font-size","font-weight","font-style","line-height","letter-spacing","text-align","text-decoration","text-transform","overflow","opacity","cursor","flex-direction","justify-content","align-items","gap","grid-template-columns","grid-template-rows","box-shadow","transition","animation","transform"];
          const computed = {};
          for (const p of props) computed[p] = s.getPropertyValue(p);
          return { tag: el.tagName, id: el.id || undefined, class: el.className?.toString?.()?.slice?.(0, 60) || undefined, rect: { x: r.x, y: r.y, width: r.width, height: r.height }, computed };
        },
        args: [params.selector ?? null, params.uid ?? null],
      }, `css inspect in tab ${tab.id}`);
      const css = results[0]?.result;
      if (!css) throw new Error("Element not found for CSS inspection");
      const lines = [`# CSS: ${css.tag}${css.id ? `#${css.id}` : ""}${css.class ? `.${css.class}` : ""}`, `Box: ${css.rect.width}x${css.rect.height} @ ${css.rect.x},${css.rect.y}`];
      const groups = { Layout: ["display","position","top","right","bottom","left","z-index","flex-direction","justify-content","align-items","gap","grid-template-columns","grid-template-rows"], Box: ["width","height","min-width","max-width","padding","margin","border","border-width","border-color","border-radius"], Typography: ["font-family","font-size","font-weight","font-style","line-height","letter-spacing","text-align","text-decoration","text-transform"], Visual: ["background-color","color","opacity","box-shadow","overflow","cursor","transition","animation","transform"] };
      for (const [group, props] of Object.entries(groups)) {
        lines.push(`\n${group}:`);
        for (const p of props) { const v = css.computed[p]; if (v && v !== "auto" && v !== "normal" && v !== "none") lines.push(`  ${p}: ${v}`); }
      }
      return { text: lines.join("\n"), css };
    }
    case "page.screenshot":
      return takeScreenshot(params);
    case "automation.status": {
      // Report this session's owned automation target (ids only). Used for diagnostics/tests.
      await hydrateAutomationTargets();
      const t = automationTargets.get(sessionKeyOf(params));
      return { windowId: t?.windowId ?? null, tabId: t?.tabId ?? null };
    }
    case "automation.cleanup":
      // Close only THIS session's pi-chrome-owned window/tab. Never touches user tabs/windows or
      // another Pi session's target.
      return cleanupAutomationTarget(sessionKeyOf(params));
    // === Emulation domain (CDP) — no new permissions needed ===
    case "emulate.device": {
      const tab = await getTabByParams(params);
      await attachDebugger(tab.id);
      await cdp(tab.id, "Emulation.setDeviceMetricsOverride", {
        width: params.width ?? 390,
        height: params.height ?? 844,
        deviceScaleFactor: params.deviceScaleFactor ?? 3,
        mobile: params.mobile ?? true,
        ...(params.userAgent ? { userAgent: params.userAgent } : {}),
      });
      return { emulated: "device", width: params.width ?? 390, height: params.height ?? 844, tabId: tab.id };
    }
    case "emulate.geolocation": {
      const tab = await getTabByParams(params);
      await attachDebugger(tab.id);
      await cdp(tab.id, "Emulation.setGeolocationOverride", {
        latitude: params.latitude ?? 0,
        longitude: params.longitude ?? 0,
        accuracy: params.accuracy ?? 100,
      });
      return { emulated: "geolocation", latitude: params.latitude, longitude: params.longitude, tabId: tab.id };
    }
    case "emulate.timezone": {
      const tab = await getTabByParams(params);
      await attachDebugger(tab.id);
      await cdp(tab.id, "Emulation.setTimezoneOverride", { timezoneId: params.timezoneId ?? "UTC" });
      return { emulated: "timezone", timezoneId: params.timezoneId, tabId: tab.id };
    }
    case "emulate.cpu": {
      const tab = await getTabByParams(params);
      await attachDebugger(tab.id);
      await cdp(tab.id, "Emulation.setCPUThrottlingRate", { rate: params.rate ?? 4 });
      return { emulated: "cpu", rate: params.rate ?? 4, tabId: tab.id };
    }
    case "emulate.clear": {
      const tab = await getTabByParams(params);
      await attachDebugger(tab.id);
      await cdp(tab.id, "Emulation.clearDeviceMetricsOverride", {}).catch(() => undefined);
      await cdp(tab.id, "Emulation.clearGeolocationOverride", {}).catch(() => undefined);
      await cdp(tab.id, "Emulation.clearTimezoneOverride", {}).catch(() => undefined);
      await cdp(tab.id, "Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => undefined);
      return { cleared: true, tabId: tab.id };
    }
    case "emulate.colorblind": {
      const tab = await getTabByParams(params);
      await attachDebugger(tab.id);
      // CDP Emulation.setDOMMutationObserver or CSS filter approach. We use the simpler
      // approach: inject a CSS filter on the document element via Runtime.evaluate.
      const filters = {
        protanopia: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><filter id='p'><feColorMatrix type='matrix' values='0.567,0.433,0,0,0 0.558,0.442,0,0,0 0,0.242,0.758,0,0 0,0,0,1,0'/></filter></svg>#p\")",
        deuteranopia: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><filter id='d'><feColorMatrix type='matrix' values='0.625,0.375,0,0,0 0.7,0.3,0,0,0 0,0.3,0.7,0,0 0,0,0,1,0'/></filter></svg>#d\")",
        tritanopia: "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><filter id='t'><feColorMatrix type='matrix' values='0.95,0.05,0,0,0 0,0.433,0.567,0,0 0,0.475,0.525,0,0 0,0,0,1,0'/></filter></svg>#t\")",
        achromatopsia: "grayscale(100%)",
        "high-contrast": "contrast(150%) saturate(0)",
        none: "none",
      };
      const filter = filters[params.type] || filters.none;
      await cdp(tab.id, "Runtime.evaluate", { expression: `document.documentElement.style.filter = ${JSON.stringify(filter)}`, returnByValue: true });
      return { emulated: "colorblind", type: params.type, filter: filter.slice(0, 60), tabId: tab.id };
    }
    // === Network domain (CDP) — no new permissions needed ===
    case "network.userAgent": {
      const tab = await getTabByParams(params);
      await attachDebugger(tab.id);
      await cdp(tab.id, "Network.setUserAgentOverride", { userAgent: params.userAgent });
      return { set: true, userAgent: params.userAgent, tabId: tab.id };
    }
    case "network.clearCache": {
      const tab = await getTabByParams(params);
      await attachDebugger(tab.id);
      await cdp(tab.id, "Network.enable", {}).catch(() => undefined);
      await cdp(tab.id, "Network.clearBrowserCache", {});
      return { cleared: "cache", tabId: tab.id };
    }
    case "network.clearCookies": {
      const tab = await getTabByParams(params);
      await attachDebugger(tab.id);
      await cdp(tab.id, "Network.enable", {}).catch(() => undefined);
      await cdp(tab.id, "Network.clearBrowserCookies", {});
      return { cleared: "cookies", tabId: tab.id };
    }
    // === Cookies API — needs cookies permission ===
    case "cookies.getAll": {
      if (!chrome.cookies) throw new Error("chrome.cookies API unavailable; reload the extension after granting the cookies permission");
      const cookies = await chrome.cookies.getAll({
        ...(params.domain ? { domain: params.domain } : {}),
        ...(params.name ? { name: params.name } : {}),
        ...(params.path ? { path: params.path } : {}),
        ...(params.secure !== undefined ? { secure: params.secure } : {}),
        ...(params.url ? { url: params.url } : {}),
      });
      return { cookies: cookies.map((c) => ({ name: c.name, value: c.value.length > 100 ? c.value.slice(0, 100) + "..." : c.value, domain: c.domain, path: c.path, secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite, hostOnly: c.hostOnly, session: c.session, expirationDate: c.expirationDate })) };
    }
    case "cookies.set": {
      if (!chrome.cookies) throw new Error("chrome.cookies API unavailable; reload the extension after granting the cookies permission");
      if (!params.url) throw new Error("cookies.set requires a url");
      await chrome.cookies.set({
        url: params.url,
        name: params.name,
        value: params.value ?? "",
        ...(params.domain ? { domain: params.domain } : {}),
        ...(params.path ? { path: params.path } : {}),
        ...(params.secure !== undefined ? { secure: params.secure } : {}),
        ...(params.httpOnly !== undefined ? { httpOnly: params.httpOnly } : {}),
        ...(params.sameSite ? { sameSite: params.sameSite } : {}),
        ...(params.expirationDate ? { expirationDate: params.expirationDate } : {}),
      });
      return { set: true, name: params.name, url: params.url };
    }
    case "cookies.remove": {
      if (!chrome.cookies) throw new Error("chrome.cookies API unavailable; reload the extension after granting the cookies permission");
      if (!params.url) throw new Error("cookies.remove requires a url");
      await chrome.cookies.remove({ url: params.url, name: params.name });
      return { removed: true, name: params.name, url: params.url };
    }
    // === Identity API — needs identity permission ===
    case "identity.getToken": {
      if (!chrome.identity) throw new Error("chrome.identity API unavailable; reload the extension after granting the identity permission");
      const token = await chrome.identity.getAuthToken({ interactive: params.interactive ?? true, ...(params.scopes ? { scopes: params.scopes } : {}) });
      return { token: token || null };
    }
    // === Downloads API — needs downloads permission ===
    case "downloads.download": {
      if (!chrome.downloads) throw new Error("chrome.downloads API unavailable; reload the extension after granting the downloads permission");
      const id = await chrome.downloads.download({
        url: params.url,
        ...(params.filename ? { filename: params.filename } : {}),
        ...(params.saveAs !== undefined ? { saveAs: params.saveAs } : {}),
        ...(params.conflictAction ? { conflictAction: params.conflictAction } : {}),
      });
      return { downloaded: true, downloadId: id };
    }
    case "downloads.list": {
      if (!chrome.downloads) throw new Error("chrome.downloads API unavailable; reload the extension after granting the downloads permission");
      const items = await chrome.downloads.search({
        ...(params.state ? { state: params.state } : {}),
        ...(params.filenameRegex ? { filenameRegex: params.filenameRegex } : {}),
        limit: params.limit ?? 10,
        orderBy: ["-startTime"],
      });
      return { downloads: items.map((d) => ({ id: d.id, filename: d.filename, url: d.url, state: d.state, totalBytes: d.totalBytes, exists: d.exists })) };
    }
    // === History API — needs history permission ===
    case "history.search": {
      if (!chrome.history) throw new Error("chrome.history API unavailable; reload the extension after granting the history permission");
      const results = await chrome.history.search({
        text: params.text ?? "",
        startTime: params.startTime ?? (Date.now() - 7 * 24 * 60 * 60 * 1000),
        maxResults: params.maxResults ?? 20,
      });
      return { results: results.map((h) => ({ url: h.url, title: h.title, lastVisitTime: h.lastVisitTime, visitCount: h.visitCount })) };
    }
    case "history.deleteUrl": {
      if (!chrome.history) throw new Error("chrome.history API unavailable; reload the extension after granting the history permission");
      await chrome.history.deleteUrl({ url: params.url });
      return { deleted: true, url: params.url };
    }
    // === Sessions API — needs sessions permission ===
    case "sessions.recent": {
      if (!chrome.sessions) throw new Error("chrome.sessions API unavailable; reload the extension after granting the sessions permission");
      const result = await chrome.sessions.getRecentlyClosed({ maxResults: params.maxResults ?? 10 });
      return { sessions: result.map((s) => {
        if (s.tab) return { type: "tab", tab: { id: s.tab.id, url: s.tab.url, title: s.tab.title, windowId: s.tab.windowId }, lastModified: s.lastModified };
        if (s.window) return { type: "window", tabs: (s.window.tabs || []).map((t) => ({ id: t.id, url: t.url, title: t.title })), lastModified: s.lastModified };
        return { type: "unknown", lastModified: s.lastModified };
      }) };
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

async function formatTab(tab) {
  return {
    id: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    highlighted: tab.highlighted,
    title: tab.title || "",
    url: tab.url || "",
    status: tab.status,
    pinned: tab.pinned,
    incognito: tab.incognito,
    groupId: typeof tab.groupId === "number" ? tab.groupId : -1,
    group: await groupRecord(tab.groupId),
  };
}

// Resolve which Chrome tab an action targets.
//
// Explicit targeting (targetId / urlIncludes / titleIncludes) is unchanged: callers can still act
// on any existing tab, including a user tab, when they ask for it by name. Only the implicit
// "no target given" case changed — it used to grab the user's *active* tab (and page.navigate
// would then overwrite it); it now resolves to this Pi session's dedicated automation target.
//
// `createOwnedTarget` controls the implicit case:
//   - true  (default): create the automation target on first use. Used by every page/content
//     action — page.navigate, click/type/fill/key/hover/drag/scroll/tap/upload, snapshot,
//     inspect, evaluate, screenshot, waitFor, console/network list, probe. These need a live
//     surface to drive, so auto-creating is correct and they no longer touch the user's tab.
//   - false: do NOT create. Used by tab.activate/close/group/ungroup (tab *management*): with no
//     explicit target they operate on an already-owned automation target if one exists, else
//     throw asking for an explicit target — so e.g. `chrome_tab close` can never silently close
//     the user's active tab the way it used to, and never spawns a throwaway tab just to close it.
async function getTabByParams(params, { createOwnedTarget = true } = {}) {
  const tabs = await chrome.tabs.query({});
  let tab;
  if (params.targetId !== undefined) {
    const id = Number(params.targetId);
    tab = await chrome.tabs.get(id).catch(() => null);
    if (!tab?.id) {
      // Chrome tab ids are not stable across reloads/navigations; a long session can hold a
      // stale id. Surface the current tabs so the caller can re-target instead of guessing.
      const listed = tabs
        .filter((candidate) => candidate.id !== undefined)
        .slice(0, 20)
        .map((candidate) => `  ${candidate.id}${candidate.active ? " *" : ""}\t${(candidate.title || "(untitled)").slice(0, 60)}\t${candidate.url || ""}`)
        .join("\n");
      throw new Error(
        `No Chrome tab with id ${id} (it was likely closed or replaced). ` +
        `Re-target with chrome_tab list, or pass urlIncludes/titleIncludes instead of targetId.\n` +
        `Current tabs:\n${listed || "  (none)"}`,
      );
    }
  } else if (params.urlIncludes) {
    tab = tabs.find((candidate) => (candidate.url || "").includes(params.urlIncludes));
  } else if (params.titleIncludes) {
    tab = tabs.find((candidate) => (candidate.title || "").includes(params.titleIncludes));
  } else {
    // No explicit target: use this session's dedicated automation target instead of hijacking the
    // user's active tab. This keeps human browsing and Pi automation separated — navigating here
    // never replaces whatever the user currently has open. Callers that *want* a specific
    // existing tab pass targetId/urlIncludes/titleIncludes above.
    const sessionKey = sessionKeyOf(params);
    tab = createOwnedTarget
      ? await getOrCreateAutomationTarget(sessionKey, params.sessionGroupTitle)
      : await resolveOwnedAutomationTarget(sessionKey);
    if (!tab) {
      throw new Error(
        "No target tab specified and this Pi session has no automation tab yet. " +
        "Pass targetId/urlIncludes/titleIncludes, or run chrome_navigate first.",
      );
    }
  }
  if (!tab?.id) throw new Error("No matching Chrome tab found");
  const url = tab.url || "";
  if (url.startsWith("chrome://") || url.startsWith("chrome-extension://") || url.startsWith("devtools://")) {
    throw new Error(`Chrome blocks extension automation on protected URL: tab=${tab.id} url=${url}`);
  }
  // Tabs Pi interacts with (page.* actions) join this session's group so the user can see exactly
  // which tabs Pi is driving. We only adopt *ungrouped* tabs — never hijack a tab the user (or
  // another Pi session) already grouped, since groupTab would otherwise rename that group.
  if (params.joinSessionGroup && params.sessionGroupTitle) {
    await joinSessionGroup(tab, params.sessionGroupTitle);
  }
  return tab;
}

// Add an ungrouped tab to the session's tab group (reusing it by title, else creating it).
// No-op when the tab is already grouped or tabGroups is unavailable.
async function joinSessionGroup(tab, title) {
  if (!chrome.tabGroups || typeof tab.id !== "number") return;
  if (typeof tab.groupId === "number" && tab.groupId >= 0) return;
  try {
    await groupTab(tab, title);
  } catch {
    // Grouping is best-effort; never block the actual page action on a grouping failure.
  }
}

// Helper sources that get concatenated into the injected MAIN-world script. Kept as separate
// functions so callers below can reference them by `.toString()`. The helpers do not perform any
// eval themselves — they're plain function declarations.
const HELPER_FUNCS = [
  getPiChromeState,
  rememberElement,
  elementBySelectorOrUid,
  installPiChromeInstrumentation,
  resolvePoint,
  dispatchInputEvents,
  setNativeValue,
  normalizeKey,
  isElementVisible,
  occluderAt,
  pageHash,
  pointerEventSequence,
  sleepPage,
  rand,
  dispatchPointerLikeEvent,
  humanMoveTo,
  humanClickPoint,
  usKeyLayoutForChar,
  printableKeyCode,
  dispatchKeyEvent,
  typeCharacter,
  pressKeyInPage,
  scrollPage,
];

async function executeInTab(params, func, args) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);

  // Phase 1: define the helpers and the action function as page globals via CDP
  // Runtime.evaluate. This bypasses page CSP (no `eval`/`new Function`), which is the
  // root cause of snapshot/click/etc silently failing on `script-src 'self'` sites.
  // Each helper is a named function declaration, assigned to window.<name> so the action
  // (which references helpers by bare name) resolves them as globals at call time.
  const assignments = HELPER_FUNCS.map((helper) => `window.${helper.name}=${helper.toString()}`).join(";\n");
  const actionAssign = `window.__piAction=(${func.toString()})`;
  const defineRes = await cdpEval(tab.id, `(()=>{${assignments};\n${actionAssign};})()`);
  if (defineRes.exceptionDetails) {
    throw new Error(`Failed to inject Chrome page helpers: ${cdpExceptionText(defineRes.exceptionDetails) || "unknown error"}`);
  }

  // Phase 2: run the action via chrome.scripting.executeScript. The `func:` form is
  // injected by Chrome itself (not `new Function`), so it is CSP-safe, and it lets Chrome
  // serialize the invocation args. The wrapper references window.__piAction defined above.
  const results = await executeScriptTimed({
    target: { tabId: tab.id },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        return { ok: true, value: await window.__piAction(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [args || []],
  }, `execute page action in tab ${tab.id}`);
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome page script failed");
  }
  return envelope?.value;
}

// Serializer for page.evaluate results. Embedded (via .toString()) into the CDP-evaluated
// expression so we can return rich markers for values that don't survive returnByValue
// (undefined/function/symbol/bigint/Error), plus expand DOMRect-like objects whose fields
// are non-enumerable. Kept as a standalone function so it stays editable/lintable.
function piEvalStringify(v) {
  if (v === undefined) return { kind: "undefined" };
  if (typeof v === "function") return { kind: "function", source: v.toString().slice(0, 500) };
  if (typeof v === "symbol") return { kind: "symbol", description: v.description };
  if (typeof v === "bigint") return { kind: "bigint", value: v.toString() };
  if (v instanceof Error) return { kind: "error", name: v.name, message: v.message, stack: v.stack };
  // DOMRect/DOMRectReadOnly (and getBoundingClientRect results) have non-enumerable
  // properties, so JSON.stringify yields `{}`. Expand the fields explicitly.
  if ((typeof DOMRectReadOnly !== "undefined" && v instanceof DOMRectReadOnly) ||
      (typeof DOMRect !== "undefined" && v instanceof DOMRect) ||
      (v && typeof v === "object" && typeof v.toJSON === "function" &&
       typeof v.width === "number" && typeof v.height === "number" && typeof v.top === "number")) {
    return { x: v.x, y: v.y, width: v.width, height: v.height, top: v.top, right: v.right, bottom: v.bottom, left: v.left };
  }
  return v;
}

// Dedicated executor for page.evaluate. Uses CDP Runtime.evaluate (via cdpEval) which is not
// subject to the page's CSP, fixing `chrome_evaluate` silently returning null / failing on
// pages that ship `script-src 'self'` without `'unsafe-eval'` (which blocks `eval`/`new Function`).
async function evaluateInTab(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  const expression = String(params.expression ?? "");
  const stringifySrc = `(${piEvalStringify.toString()})`;
  // Wrap the user expression so the result is run through piEvalStringify in-page before it
  // crosses the returnByValue boundary. Try expression form first (so `1+1` / `document.title`
  // work without `return`); on a SyntaxError fall back to statement form for multi-statement
  // bodies (loops, var decls, etc), matching the previous new Function() two-form behavior.
  const buildWrapper = (form) => `(async () => { const __s=${stringifySrc}; const __v = await ${form}; return __s(__v); })()`;
  const exprForm = `(async () => (${expression}))()`;
  const stmtForm = `(async () => { ${expression} })()`;

  let res = await cdpEval(tab.id, buildWrapper(exprForm));
  if (res.exceptionDetails && cdpIsSyntaxError(res.exceptionDetails)) {
    res = await cdpEval(tab.id, buildWrapper(stmtForm));
  }
  if (res.exceptionDetails) {
    throw new Error(`chrome_evaluate failed: ${cdpExceptionText(res.exceptionDetails) || "evaluation failed"}`);
  }
  const result = res.result;
  if (!result || result.type === "undefined") return undefined;
  const v = result.value;
  // Unwrap special markers produced by piEvalStringify.
  if (v && typeof v === "object" && !Array.isArray(v)) {
    if (v.kind === "undefined") return undefined;
    if (v.kind === "function") return `[Function: ${v.source}]`;
    if (v.kind === "symbol") return `[Symbol: ${v.description}]`;
    if (v.kind === "bigint") return v.value;
    if (v.kind === "error") throw new Error(`${v.name}: ${v.message}\n${v.stack || ""}`);
  }
  return v;
}

async function withOptionalSnapshot(params, actionFn) {
  const result = await actionFn(params);
  if (params.includeSnapshot) {
    const snapshot = await snapshotInTab({ ...params, foreground: false });
    return { result, snapshot };
  }
  return result;
}

// Snapshot/inspect run from a packaged MAIN-world script (snapshot_injected.js) injected via
// chrome.scripting.executeScript({ files }). That file is free of eval/new Function, so it works
// on strict-CSP pages, and it installs globalThis.__piChromeSnapshotPage / __piChromeInspectTarget.
// It shares window.__PI_CHROME_STATE__ (same el- uid scheme) with the CDP-injected input helpers.
async function snapshotInTab(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  const args = [
    params.maxElements || 80,
    params.containingText ?? null,
    params.roleFilter ?? null,
    params.nearUid ?? null,
    params.mode || "auto",
    params.query ?? null,
    params.maxTextChars ?? null,
  ];
  await executeScriptTimed({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    files: ["snapshot_injected.js"],
  }, `inject snapshot script in tab ${tab.id}`);
  const results = await executeScriptTimed({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        const snapshotPage = globalThis.__piChromeSnapshotPage;
        if (typeof snapshotPage !== "function") throw new Error("snapshot_injected.js did not install __piChromeSnapshotPage");
        return { ok: true, value: await snapshotPage(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [args],
  }, `run snapshot script in tab ${tab.id}`);
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome snapshot script failed");
  }
  return envelope?.value;
}

async function inspectInTab(params) {
  if (!params.uid && !params.selector) throw new Error("chrome_inspect requires uid or selector");
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  const args = [params.uid ?? null, params.selector ?? null, params.scrollIntoView === true];
  await executeScriptTimed({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    files: ["snapshot_injected.js"],
  }, `inject inspect script in tab ${tab.id}`);
  const results = await executeScriptTimed({
    target: { tabId: tab.id, frameIds: [0] },
    world: "MAIN",
    func: async (invocationArgs) => {
      try {
        const inspectTarget = globalThis.__piChromeInspectTarget;
        if (typeof inspectTarget !== "function") throw new Error("snapshot_injected.js did not install __piChromeInspectTarget");
        return { ok: true, value: await inspectTarget(...invocationArgs) };
      } catch (error) {
        return { ok: false, error: error?.stack || error?.message || String(error) };
      }
    },
    args: [args],
  }, `run inspect script in tab ${tab.id}`);
  const first = results?.[0];
  if (first?.error) {
    const message = typeof first.error === "string" ? first.error : (first.error.message || JSON.stringify(first.error));
    throw new Error(message);
  }
  const envelope = first?.result;
  if (envelope && typeof envelope === "object" && envelope.ok === false) {
    throw new Error(envelope.error || "Chrome inspect script failed");
  }
  return envelope?.value;
}

// One-shot init script registry, scoped per tab. The source is registered with CDP
// Page.addScriptToEvaluateOnNewDocument, which runs it at document_start in the page's MAIN
// world and is NOT subject to page CSP (the old func:(code)=>new Function(code) path was
// blocked by `script-src 'self'`). page.navigate registers before the nav and unregisters
// after load, so only the intended navigation receives the script.
const initScriptIds = new Map(); // tabId -> CDP script identifier
async function registerInitScript(tabId, source) {
  await attachDebugger(tabId);
  await cdp(tabId, "Page.enable", {}).catch(() => undefined);
  const result = await cdp(tabId, "Page.addScriptToEvaluateOnNewDocument", { source });
  if (result && result.identifier !== undefined) initScriptIds.set(tabId, result.identifier);
}
async function unregisterInitScript(tabId) {
  const identifier = initScriptIds.get(tabId);
  if (identifier === undefined) return;
  initScriptIds.delete(tabId);
  await cdp(tabId, "Page.removeScriptToEvaluateOnNewDocument", { identifier }).catch(() => undefined);
}

// Always inject early console/network capture at document_start on every navigation.
// Catches console messages, errors, and network requests that fire during page load,
// before chrome_snapshot or chrome_evaluate install the instrumentation normally.
// The function installEarlyCapture sets __piChromeWrapped flags so the post-hoc
// installPiChromeInstrumentation() call is idempotent.
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId !== 0) return;
    chrome.scripting.executeScript({
      target: { tabId: details.tabId, frameIds: [0] },
      world: "MAIN",
      injectImmediately: true,
      func: installEarlyCapture,
      args: [],
    }).catch(() => undefined);
  });
}

async function bringToFront(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out after ${timeoutMs}ms waiting for tab ${tabId} to load`));
    }, timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(true);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function takeScreenshot(params) {
  const tab = await getTabByParams(params);
  if (params.foreground) await bringToFront(tab);
  let previousActiveId;
  if (!tab.active) {
    const activeBefore = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    previousActiveId = activeBefore[0]?.id;
    await chrome.tabs.update(tab.id, { active: true });
  }
  try {
    if (params.fullPage) {
      // Tile-stitched full page capture: scroll, capture, paste, repeat.
      const tiles = await executeInTab({ ...params, foreground: false }, captureFullPageTiles, []);
      // captureFullPageTiles only computes scroll positions / metrics; we capture per scroll here
      // (chrome.tabs.captureVisibleTab can't be called from MAIN world).
      const captured = [];
      for (const tile of tiles.tiles) {
        await executeInTab({ ...params, foreground: false }, scrollToY, [tile.scrollY]);
        // Small settle delay; many sites have on-scroll animations / lazy-load.
        await sleep(120);
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
          format: params.format || "png",
          quality: params.format === "jpeg" ? params.quality : undefined,
        });
        captured.push({ y: tile.y, dataUrl });
      }
      await executeInTab({ ...params, foreground: false }, scrollToY, [tiles.originalScrollY]);
      return {
        fullPage: true,
        tab: await formatTab(tab),
        dimensions: { width: tiles.width, height: tiles.height, viewportHeight: tiles.viewportHeight, dpr: tiles.dpr },
        tiles: captured,
      };
    }
    // Element screenshot: capture only the bounding box of a specific element.
    if (params.uid || params.selector) {
      await attachDebugger(tab.id);
      const rectResult = await cdp(tab.id, "Runtime.evaluate", {
        expression: `(() => {
          const state = window.__PI_CHROME_STATE__;
          const el = ${params.uid ? `state && state.elements && state.elements['${params.uid}']` : `document.querySelector(${JSON.stringify(params.selector)})`};
          if (!el || !el.isConnected) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, scrollX: window.scrollX, scrollY: window.scrollY };
        })()`,
        returnByValue: true,
      });
      const rect = rectResult?.result?.value;
      if (!rect || !rect.width) throw new Error("Element not found or has no visible bounds for screenshot");
      const clip = { x: rect.x + rect.scrollX, y: rect.y + rect.scrollY, width: rect.width, height: rect.height, scale: 1 };
      const shot = await cdp(tab.id, "Page.captureScreenshot", { format: params.format || "png", clip });
      return { dataUrl: shot?.data ? `data:image/${params.format || "png"};base64,${shot.data}` : null, tab: await formatTab(tab), elementRect: rect };
    }
    // Responsive sweep: capture screenshots at multiple breakpoints.
    if (params.breakpoints && Array.isArray(params.breakpoints)) {
      const shots = [];
      for (const bp of params.breakpoints) {
        await cdp(tab.id, "Emulation.setDeviceMetricsOverride", { width: bp.width || 390, height: bp.height || 844, deviceScaleFactor: 1, mobile: !!bp.mobile });
        await sleep(300); // settle
        const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: params.format || "png" });
        shots.push({ name: bp.name || `${bp.width}x${bp.height}`, dataUrl });
      }
      await cdp(tab.id, "Emulation.clearDeviceMetricsOverride", {}).catch(() => undefined);
      return { sweep: true, screenshots: shots, tab: await formatTab(tab) };
    }
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: params.format || "png",
      quality: params.format === "jpeg" ? params.quality : undefined,
    });
    return { dataUrl, tab: await formatTab(tab) };
  } finally {
    if (previousActiveId !== undefined && previousActiveId !== tab.id) {
      await chrome.tabs.update(previousActiveId, { active: true }).catch(() => undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// MAIN-world helpers (function declarations injected into the page).
// ---------------------------------------------------------------------------

function getPiChromeState() {
  const state = window.__PI_CHROME_STATE__ || {
    nextElementUid: 1,
    elements: {},
    console: [],
    network: [],
    nextRequestId: 1,
    instrumentationInstalled: false,
  };
  window.__PI_CHROME_STATE__ = state;
  return state;
}

function rememberElement(element) {
  const state = getPiChromeState();
  if (!element.__piChromeUid) element.__piChromeUid = "el-" + state.nextElementUid++;
  state.elements[element.__piChromeUid] = element;
  return element.__piChromeUid;
}

function elementBySelectorOrUid(selector, uid) {
  if (uid) {
    const element = getPiChromeState().elements[uid];
    if (!element || !element.isConnected) throw new Error(`No live element for uid: ${uid}. Take a fresh chrome_snapshot.`);
    return element;
  }
  if (selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`No element matches selector: ${selector}`);
    return element;
  }
  return null;
}

function isElementVisible(element) {
  if (!element || !element.getBoundingClientRect) return false;
  const style = getComputedStyle(element);
  if (style.visibility === "hidden" || style.display === "none") return false;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom < 0 || rect.right < 0) return false;
  if (rect.top > innerHeight || rect.left > innerWidth) return false;
  return true;
}

function occluderAt(x, y, expected) {
  const top = document.elementFromPoint(x, y);
  if (!top || top === expected) return null;
  if (expected && expected.contains(top)) return null;
  if (top.contains(expected)) return null;
  return {
    tag: top.tagName.toLowerCase(),
    id: top.id || undefined,
    className: typeof top.className === "string" ? top.className : undefined,
  };
}

function pageHash() {
  // Cheap rolling hash used for `pageMutated`. Combines first 4kb of body innerText with the
  // current values of inputs/textareas (which are not part of innerText) and the count of
  // descendants of <body>. This catches: text changes, input value edits, and DOM structure
  // changes — the three things a click/type/fill might cause.
  const body = document.body;
  const text = (body ? body.innerText : "").slice(0, 4000);
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  if (body) {
    const inputs = body.querySelectorAll("input,textarea,select");
    let valueBlob = "";
    for (let i = 0; i < inputs.length && valueBlob.length < 4000; i++) {
      const v = inputs[i].value;
      if (typeof v === "string") valueBlob += v + "\x00";
    }
    for (let i = 0; i < valueBlob.length; i++) h = (h * 31 + valueBlob.charCodeAt(i)) | 0;
    h = (h * 31 + body.getElementsByTagName("*").length) | 0;
  }
  return h;
}

function sleepPage(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

function dispatchPointerLikeEvent(element, type, x, y, prevX, prevY, opts = {}) {
  const isPointer = type.startsWith("pointer");
  const Ctor = isPointer ? PointerEvent : MouseEvent;
  const isMove = type === "pointermove" || type === "mousemove";
  const isUpOrClick = type === "pointerup" || type === "mouseup" || type === "click";
  const init = {
    bubbles: true,
    cancelable: true,
    view: window,
    clientX: x,
    clientY: y,
    screenX: x + (window.screenX || 0),
    screenY: y + (window.screenY || 0),
    movementX: Number.isFinite(prevX) ? x - prevX : 0,
    movementY: Number.isFinite(prevY) ? y - prevY : 0,
    button: 0,
    buttons: isMove || isUpOrClick ? 0 : 1,
  };
  if (isPointer) {
    init.pointerType = "mouse";
    init.pointerId = 1;
    init.isPrimary = true;
    init.width = 1;
    init.height = 1;
    init.pressure = opts.pressure ?? (type === "pointerdown" ? 0.5 : 0);
    init.tangentialPressure = 0;
    init.tiltX = 0;
    init.tiltY = 0;
  }
  const ev = new Ctor(type, init);
  element.dispatchEvent(ev);
  return ev.defaultPrevented;
}

function pointerEventSequence(element, x, y, sequence) {
  let defaultPrevented = false;
  const state = getPiChromeState();
  const prevX = state.pointer?.x;
  const prevY = state.pointer?.y;
  for (const type of sequence) {
    defaultPrevented = dispatchPointerLikeEvent(element, type, x, y, prevX, prevY) || defaultPrevented;
  }
  state.pointer = { x, y, t: performance.now() };
  return defaultPrevented;
}

async function humanMoveTo(x, y, steps) {
  const state = getPiChromeState();
  const startX = Number.isFinite(state.pointer?.x) ? state.pointer.x : rand(12, Math.max(24, innerWidth - 12));
  const startY = Number.isFinite(state.pointer?.y) ? state.pointer.y : rand(12, Math.max(24, innerHeight - 12));
  const n = steps || Math.max(12, Math.min(42, Math.round(Math.hypot(x - startX, y - startY) / 18)));
  let prevX = startX, prevY = startY;
  let defaultPrevented = false;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 8;
    const px = startX + (x - startX) * ease + rand(-wobble, wobble);
    const py = startY + (y - startY) * ease + rand(-wobble, wobble);
    const el = document.elementFromPoint(px, py) || document.body || document.documentElement;
    defaultPrevented = dispatchPointerLikeEvent(el, "pointermove", px, py, prevX, prevY) || defaultPrevented;
    defaultPrevented = dispatchPointerLikeEvent(el, "mousemove", px, py, prevX, prevY) || defaultPrevented;
    prevX = px; prevY = py;
    await sleepPage(rand(4, 18));
  }
  state.pointer = { x, y, t: performance.now() };
  return defaultPrevented;
}

function humanClickPoint(point) {
  if (!point.rect) return { x: point.x, y: point.y };
  const rect = point.rect;
  const insetX = Math.min(rect.width * 0.35, Math.max(2, rect.width / 2 - 1));
  const insetY = Math.min(rect.height * 0.35, Math.max(2, rect.height / 2 - 1));
  return {
    x: rect.left + rect.width / 2 + rand(-insetX, insetX),
    y: rect.top + rect.height / 2 + rand(-insetY, insetY),
  };
}

function installPiChromeInstrumentation() {
  const state = getPiChromeState();
  if (state.instrumentationInstalled) return;
  state.instrumentationInstalled = true;
  const pushConsole = (level, args) => {
    state.console.push({
      id: state.console.length + 1,
      level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map((arg) => {
        try {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          return JSON.parse(JSON.stringify(arg));
        } catch {
          return String(arg);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  };
  for (const level of ["debug", "log", "info", "warn", "error"]){
    const original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    const wrapped = function(...args) {
      pushConsole(level, args);
      return original.apply(this, args);
    };
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", (event) => pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]));
  window.addEventListener("unhandledrejection", (event) => pushConsole("unhandledrejection", [event.reason]));

  const trimBody = (text) => typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + `\n[truncated ${text.length - 200000} chars]` : text;
  const record = (entry) => {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    const originalFetch = window.fetch.bind(window);
    const wrappedFetch = async (...args) => {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const input = args[0];
      const init = args[1] || {};
      const url = typeof input === "string" ? input : input?.url;
      const method = (init.method || input?.method || "GET").toUpperCase();
      const entry = record({ id, type: "fetch", method, url: String(url || ""), startedAt, pageUrl: location.href, status: "pending" });
      try {
        const response = await originalFetch(...args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then((text) => {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch((error) => { entry.responseBodyError = error?.message || String(error); });
        return response;
      } catch (error) {
        entry.error = error?.message || String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      const id = "req-" + state.nextRequestId++;
      const startedAt = Date.now();
      const info = this.__piChromeRequest || {};
      const entry = record({ id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", () => {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error?.message || String(error); }
      });
      this.addEventListener("error", () => { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.call(this, body);
    };
  }
}

// Early-capture version of installPiChromeInstrumentation, designed to be injected
// at document_start via webNavigation.onCommitted. Wraps console, fetch, and XHR
// before the page's own JavaScript runs, so page-load errors are captured.
// Sets __piChromeWrapped flags so the post-hoc installPiChromeInstrumentation()
// sees them and skips (idempotent).
// NOTE: This function is self-contained — it does NOT close over any outer scope
// because it gets serialized by chrome.scripting.executeScript({func: ...}).
function installEarlyCapture() {
  if (window.__piChromeEarlyCaptureInstalled) return;
  window.__piChromeEarlyCaptureInstalled = true;
  var state = window.__PI_CHROME_STATE__;
  if (!state) {
    state = {
      nextElementUid: 1,
      elements: {},
      console: [],
      network: [],
      nextRequestId: 1,
      instrumentationInstalled: false,
    };
    window.__PI_CHROME_STATE__ = state;
  }
  function pushConsole(level, args) {
    state.console.push({
      id: state.console.length + 1,
      level: level,
      timestamp: Date.now(),
      url: location.href,
      args: Array.from(args).map(function(arg) {
        try {
          if (typeof arg === "string") return arg;
          if (arg instanceof Error) return { name: arg.name, message: arg.message, stack: arg.stack };
          return JSON.parse(JSON.stringify(arg));
        } catch (e) {
          return String(arg);
        }
      }),
    });
    if (state.console.length > 500) state.console.splice(0, state.console.length - 500);
  }
  for (var i = 0; i < 5; i++) {
    var levels = ["debug", "log", "info", "warn", "error"];
    var level = levels[i];
    var original = console[level];
    if (typeof original !== "function" || original.__piChromeWrapped) continue;
    var wrapped = function(lvl, orig) {
      return function() {
        pushConsole(lvl, arguments);
        return orig.apply(this, arguments);
      };
    }(level, original);
    wrapped.__piChromeWrapped = true;
    console[level] = wrapped;
  }
  window.addEventListener("error", function(event) {
    pushConsole("pageerror", [event.message, event.filename + ":" + event.lineno + ":" + event.colno]);
  });
  window.addEventListener("unhandledrejection", function(event) {
    pushConsole("unhandledrejection", [event.reason]);
  });
  var trimBody = function(text) {
    return typeof text === "string" && text.length > 200000 ? text.slice(0, 200000) + "\n[truncated " + (text.length - 200000) + " chars]" : text;
  };
  var record = function(entry) {
    state.network.push(entry);
    if (state.network.length > 1000) state.network.splice(0, state.network.length - 1000);
    return entry;
  };
  if (window.fetch && !window.fetch.__piChromeWrapped) {
    var originalFetch = window.fetch.bind(window);
    var wrappedFetch = async function() {
      var args = [];
      for (var k = 0; k < arguments.length; k++) args.push(arguments[k]);
      var id = "req-" + state.nextRequestId++;
      var startedAt = Date.now();
      var input = args[0];
      var init = args[1] || {};
      var url = typeof input === "string" ? input : (input ? input.url : "");
      var method = (init.method || (input ? input.method : null) || "GET").toUpperCase();
      var entry = record({ id: id, type: "fetch", method: method, url: String(url || ""), startedAt: startedAt, pageUrl: location.href, status: "pending" });
      try {
        var response = await originalFetch.apply(window, args);
        entry.status = response.status;
        entry.statusText = response.statusText;
        entry.ok = response.ok;
        entry.responseUrl = response.url;
        entry.durationMs = Date.now() - startedAt;
        entry.responseHeaders = Array.from(response.headers.entries());
        response.clone().text().then(function(text) {
          entry.responseBody = trimBody(text);
          entry.responseBodyTruncated = typeof text === "string" && text.length > 200000;
        }).catch(function(error) { entry.responseBodyError = error ? error.message : String(error); });
        return response;
      } catch (error) {
        entry.error = error ? error.message : String(error);
        entry.durationMs = Date.now() - startedAt;
        throw error;
      }
    };
    wrappedFetch.__piChromeWrapped = true;
    window.fetch = wrappedFetch;
  }
  if (window.XMLHttpRequest && !XMLHttpRequest.prototype.open.__piChromeWrapped) {
    var originalOpen = XMLHttpRequest.prototype.open;
    var originalSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__piChromeRequest = { method: String(method || "GET").toUpperCase(), url: String(url || "") };
      return originalOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.open.__piChromeWrapped = true;
    XMLHttpRequest.prototype.send = function(body) {
      var id = "req-" + state.nextRequestId++;
      var startedAt = Date.now();
      var info = this.__piChromeRequest || {};
      var entry = record({ id: id, type: "xhr", method: info.method || "GET", url: info.url || "", startedAt: startedAt, pageUrl: location.href, status: "pending" });
      this.addEventListener("loadend", function() {
        entry.status = this.status;
        entry.statusText = this.statusText;
        entry.responseUrl = this.responseURL;
        entry.durationMs = Date.now() - startedAt;
        try { entry.responseHeadersText = this.getAllResponseHeaders(); } catch (e) {}
        try {
          if (typeof this.responseText === "string") {
            entry.responseBody = trimBody(this.responseText);
            entry.responseBodyTruncated = this.responseText.length > 200000;
          }
        } catch (error) { entry.responseBodyError = error ? error.message : String(error); }
      });
      this.addEventListener("error", function() { entry.error = "XMLHttpRequest error"; entry.durationMs = Date.now() - startedAt; });
      return originalSend.apply(this, arguments);
    };
  }
  state.instrumentationInstalled = true;
}

function probePage() {
  // Sanity probe used by /chrome-doctor. Returns evidence that MAIN-world execution works.
  return {
    arithmetic: 1 + 1,
    location: location.href,
    title: document.title,
    documentReady: document.readyState,
    userAgent: navigator.userAgent.slice(0, 200),
    webdriver: !!navigator.webdriver,
  };
}

function captureFullPageTiles() {
  // Returns the *plan* for tile capture; the actual chrome.tabs.captureVisibleTab calls happen
  // in the SW. We just report the scroll positions and metrics.
  const html = document.documentElement;
  const body = document.body;
  const width = Math.max(html.scrollWidth, body ? body.scrollWidth : 0, innerWidth);
  const height = Math.max(html.scrollHeight, body ? body.scrollHeight : 0, innerHeight);
  const viewportHeight = innerHeight;
  const dpr = window.devicePixelRatio || 1;
  const originalScrollY = scrollY;
  const tiles = [];
  let y = 0;
  while (y < height) {
    tiles.push({ y, scrollY: y });
    y += viewportHeight;
  }
  return { width, height, viewportHeight, dpr, originalScrollY, tiles };
}

function scrollToY(y) {
  window.scrollTo({ top: y, left: 0, behavior: "instant" });
  return { scrollY };
}

function resolvePoint(selector, uid, x, y) {
  const element = elementBySelectorOrUid(selector, uid);
  if (element) {
    element.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = element.getBoundingClientRect();
    return { element, x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, rect };
  }
  if (typeof x !== "number" || typeof y !== "number") throw new Error("Provide selector, uid, or x/y");
  return { element: document.elementFromPoint(x, y), x, y, rect: undefined };
}

async function clickPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element at click point");
  const clickPoint = humanClickPoint(point);
  point.x = clickPoint.x;
  point.y = clickPoint.y;
  point.element = document.elementFromPoint(point.x, point.y) || point.element;
  const visible = isElementVisible(point.element);
  const occluded = occluderAt(point.x, point.y, point.element);
  let defaultPrevented = await humanMoveTo(point.x, point.y);
  const state = getPiChromeState();
  const prevX = state.pointer?.x;
  const prevY = state.pointer?.y;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "pointerdown", point.x, point.y, prevX, prevY, { pressure: 0.5 }) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "mousedown", point.x, point.y, prevX, prevY) || defaultPrevented;
  if (typeof point.element.focus === "function" && /^(A|BUTTON|INPUT|TEXTAREA|SELECT|SUMMARY)$/.test(point.element.tagName)) {
    try { point.element.focus({ preventScroll: true }); } catch { try { point.element.focus(); } catch {} }
  }
  await sleepPage(rand(45, 140));
  defaultPrevented = dispatchPointerLikeEvent(point.element, "pointerup", point.x, point.y, prevX, prevY) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "mouseup", point.x, point.y, prevX, prevY) || defaultPrevented;
  defaultPrevented = dispatchPointerLikeEvent(point.element, "click", point.x, point.y, prevX, prevY) || defaultPrevented;
  state.pointer = { x: point.x, y: point.y, t: performance.now() };
  // Heuristic: if the clicked thing looks like a media play affordance and the page has paused
  // audio/video, the DOM-event click may not unlock autoplay. Surface a warning.
  let autoplayHint;
  const labelRaw = (point.element.getAttribute("aria-label") || point.element.textContent || "").trim();
  const label = labelRaw.toLowerCase();
  if (/^(play|start|begin|next|continue|unmute)/.test(label)) {
    const idleMedia = Array.from(document.querySelectorAll("audio,video")).some((m) => m.paused);
    if (idleMedia) autoplayHint = "This element looks like a media affordance and the page has paused media. DOM-event clicks do not satisfy user-activation gates; audio/video may not start.";
  }
  const pageMutated = pageHash() !== before;
  // Smart-auto retry hint: only set when DOM-event path produced no observable change AND the
  // element looks gated, OR the page just emitted a user-activation rejection. The dispatcher
  // uses this to decide whether to retry with Chrome input.
  let suggestChromeInput = false;
  let suggestReason;
  if (!pageMutated) {
    if (autoplayHint) { suggestChromeInput = true; suggestReason = "play/media affordance + idle media"; }
    else if (/copy(\s|$)|paste|share|download|fullscreen|sign in with|continue with|allow|enable/i.test(label)) {
      suggestChromeInput = true; suggestReason = `label '${labelRaw.slice(0, 40)}' looks gated`;
    } else {
      // Inspect recent console errors for activation-gate rejections.
      const recent = (state.console || []).slice(-8);
      const hit = recent.find((e) => /NotAllowedError|Document is not focused|requires transient activation|gesture is required/.test(
        (e.args || []).map((a) => typeof a === "string" ? a : (a && a.message) || JSON.stringify(a)).join(" ")
      ));
      if (hit) { suggestChromeInput = true; suggestReason = "recent console error indicates user-activation gate"; }
    }
  }
  return {
    x: point.x,
    y: point.y,
    selector,
    uid,
    tag: point.element.tagName,
    label: labelRaw.slice(0, 80) || undefined,
    input: "dom",
    defaultPrevented,
    elementVisible: visible,
    occludedBy: occluded || undefined,
    pageMutated,
    autoplayHint,
    suggestChromeInput: suggestChromeInput || undefined,
    suggestReason,
  };
}

async function hoverPage(selector, uid, x, y) {
  installPiChromeInstrumentation();
  const point = resolvePoint(selector, uid, x, y);
  if (!point.element) throw new Error("No element to hover");
  await humanMoveTo(point.x, point.y);
  const state = getPiChromeState();
  const prevX = state.pointer?.x, prevY = state.pointer?.y;
  let defaultPrevented = false;
  for (const type of ["pointerover", "mouseover", "pointerenter", "mouseenter"]) {
    defaultPrevented = dispatchPointerLikeEvent(point.element, type, point.x, point.y, prevX, prevY) || defaultPrevented;
  }
  // Small dwell so hover-intent handlers fire.
  await sleepPage(rand(80, 220));
  return { x: point.x, y: point.y, selector, uid, tag: point.element.tagName, defaultPrevented, input: "dom" };
}

async function dragPage(fromUid, fromSelector, fromX, fromY, toUid, toSelector, toX, toY, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  const from = resolvePoint(fromSelector, fromUid, fromX, fromY);
  const to = resolvePoint(toSelector, toUid, toX, toY);
  if (!from.element) throw new Error("Drag source element not found");
  if (!to.element) throw new Error("Drag target element not found");
  // Move to source.
  await humanMoveTo(from.x, from.y);
  const state = getPiChromeState();
  let prevX = state.pointer?.x, prevY = state.pointer?.y;
  // Build a shared DataTransfer so HTML5 drag-and-drop handlers can populate / read it.
  const dt = new DataTransfer();
  const dragInit = (type, target, x, y) => {
    const ev = new DragEvent(type, {
      bubbles: true, cancelable: true, composed: true,
      clientX: x, clientY: y,
      screenX: x + (window.screenX || 0), screenY: y + (window.screenY || 0),
      button: 0, buttons: 1, view: window,
      dataTransfer: dt,
    });
    target.dispatchEvent(ev);
    return ev;
  };
  dispatchPointerLikeEvent(from.element, "pointerover", from.x, from.y, prevX, prevY);
  dispatchPointerLikeEvent(from.element, "pointerdown", from.x, from.y, prevX, prevY, { pressure: 0.5 });
  dispatchPointerLikeEvent(from.element, "mousedown", from.x, from.y, prevX, prevY);
  await sleepPage(rand(40, 110));
  dragInit("dragstart", from.element, from.x, from.y);
  dragInit("drag", from.element, from.x, from.y);
  let lastOver = from.element;
  const n = steps || 18;
  for (let i = 1; i <= n; i++) {
    const t = i / n;
    const ease = t * t * (3 - 2 * t);
    const wobble = Math.sin(t * Math.PI) * 6;
    const x = from.x + (to.x - from.x) * ease + rand(-wobble, wobble);
    const y = from.y + (to.y - from.y) * ease + rand(-wobble, wobble);
    const overEl = document.elementFromPoint(x, y) || to.element;
    dispatchPointerLikeEvent(overEl, "pointermove", x, y, prevX, prevY);
    dispatchPointerLikeEvent(overEl, "mousemove", x, y, prevX, prevY);
    if (overEl !== lastOver) {
      dragInit("dragleave", lastOver, x, y);
      dragInit("dragenter", overEl, x, y);
      lastOver = overEl;
    }
    dragInit("dragover", overEl, x, y);
    dragInit("drag", from.element, x, y);
    prevX = x; prevY = y;
    await sleepPage(rand(8, 26));
  }
  dispatchPointerLikeEvent(to.element, "pointerover", to.x, to.y, prevX, prevY);
  dispatchPointerLikeEvent(to.element, "mouseover", to.x, to.y, prevX, prevY);
  dragInit("drop", to.element, to.x, to.y);
  dragInit("dragend", from.element, to.x, to.y);
  dispatchPointerLikeEvent(to.element, "pointerup", to.x, to.y, prevX, prevY);
  dispatchPointerLikeEvent(to.element, "mouseup", to.x, to.y, prevX, prevY);
  state.pointer = { x: to.x, y: to.y, t: performance.now() };
  return {
    from: { x: from.x, y: from.y },
    to: { x: to.x, y: to.y },
    steps: n,
    pageMutated: pageHash() !== before,
    note: "DOM-event drag with HTML5 DragEvent + shared DataTransfer.",
  };
}

async function scrollPage(selector, uid, deltaY, deltaX, steps) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let target;
  if (selector || uid) {
    target = elementBySelectorOrUid(selector, uid);
  } else {
    target = document.scrollingElement || document.documentElement || document.body;
  }
  if (!target) throw new Error("No scroll target");
  const rect = target.getBoundingClientRect ? target.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  const cx = Math.max(0, Math.min(innerWidth - 1, rect.left + Math.min(rect.width, innerWidth) / 2));
  const cy = Math.max(0, Math.min(innerHeight - 1, rect.top + Math.min(rect.height, innerHeight) / 2));
  const n = Math.max(3, Math.min(40, steps || Math.max(3, Math.ceil(Math.abs(deltaY || 0) / 100))));
  // Front-loaded wheel deltas, momentum-style.
  const totalY = deltaY || 0;
  const totalX = deltaX || 0;
  const weights = [];
  for (let i = 1; i <= n; i++) weights.push(1 / i);
  const sumW = weights.reduce((a, b) => a + b, 0);
  let movedY = 0, movedX = 0;
  for (let i = 0; i < n; i++) {
    const dy = totalY * (weights[i] / sumW);
    const dx = totalX * (weights[i] / sumW);
    const ev = new WheelEvent("wheel", {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy,
      deltaX: dx, deltaY: dy, deltaMode: 0,
    });
    target.dispatchEvent(ev);
    if (!ev.defaultPrevented) {
      // Apply scroll ourselves; mirrors what the browser would do.
      if (target === document.scrollingElement || target === document.documentElement || target === document.body) {
        window.scrollBy({ left: dx, top: dy, behavior: "instant" });
      } else {
        target.scrollTop += dy;
        target.scrollLeft += dx;
      }
    }
    movedY += dy; movedX += dx;
    await sleepPage(rand(12, 28));
  }
  return {
    deltaX: movedX, deltaY: movedY, steps: n,
    scrollTop: target.scrollTop, scrollLeft: target.scrollLeft,
    pageMutated: pageHash() !== before,
    input: "dom",
  };
}

function uploadFiles(selector, uid, files) {
  installPiChromeInstrumentation();
  const element = elementBySelectorOrUid(selector, uid);
  if (!element || element.tagName !== "INPUT" || element.type !== "file") {
    throw new Error("Target must be <input type=file>");
  }
  const dt = new DataTransfer();
  for (const f of files) {
    const bytes = Uint8Array.from(atob(f.base64 || ""), (c) => c.charCodeAt(0));
    dt.items.add(new File([bytes], f.name, { type: f.type || "application/octet-stream" }));
  }
  element.files = dt.files;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return { uploaded: files.map((f) => ({ name: f.name, type: f.type, size: (f.base64 || "").length })) };
}

function dispatchInputEvents(element, data, inputType = "insertText") {
  element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType, data }));
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType, data }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function setNativeValue(element, value) {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) descriptor.set.call(element, value);
  else element.value = value;
}

function printableKeyCode(ch) {
  return ch.length === 1 ? usKeyLayoutForChar(ch).keyCode : 0;
}

function dispatchKeyEvent(element, type, key, mods = {}) {
  const SPECIAL = { Enter: 13, Tab: 9, Backspace: 8, Delete: 46, Escape: 27,
    ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, " ": 32, Shift: 16, Control: 17, Alt: 18, Meta: 91 };
  const code = key.length === 1 ? usKeyLayoutForChar(key).code : (key === " " ? "Space" : key);
  const keyCode = key.length === 1 ? printableKeyCode(key) : (SPECIAL[key] ?? 0);
  const ev = new KeyboardEvent(type, {
    key,
    code,
    keyCode,
    which: keyCode,
    charCode: type === "keypress" && key.length === 1 ? key.charCodeAt(0) : 0,
    shiftKey: !!mods.shiftKey,
    ctrlKey: !!mods.ctrlKey,
    altKey: !!mods.altKey,
    metaKey: !!mods.metaKey,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: window,
  });
  element.dispatchEvent(ev);
  return ev;
}

async function typeCharacter(element, ch) {
  const needShift = ch.length === 1 && (/^[A-Z]$/.test(ch) || "~!@#$%^&*()_+{}|:\"<>?".includes(ch));
  if (needShift) {
    dispatchKeyEvent(element, "keydown", "Shift", { shiftKey: true });
    await sleepPage(rand(8, 24));
  }
  const mods = { shiftKey: needShift };
  const down = dispatchKeyEvent(element, "keydown", ch, mods);
  if (down.defaultPrevented) {
    if (needShift) dispatchKeyEvent(element, "keyup", "Shift", { shiftKey: false });
    return { defaultPrevented: true };
  }
  if (ch.length === 1) dispatchKeyEvent(element, "keypress", ch, mods);

  if (element.isContentEditable) {
    // execCommand("insertText") fires its own beforeinput + input. Don't double-dispatch.
    document.execCommand("insertText", false, ch);
  } else if ("value" in element) {
    const start = element.selectionStart ?? element.value.length;
    const end = element.selectionEnd ?? element.value.length;
    const next = element.value.slice(0, start) + ch + element.value.slice(end);
    const before = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: ch });
    element.dispatchEvent(before);
    if (!before.defaultPrevented) {
      setNativeValue(element, next);
      try { element.selectionStart = element.selectionEnd = start + ch.length; } catch {}
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch }));
    }
  } else {
    throw new Error("Focused element is not text-editable");
  }

  await sleepPage(rand(25, 95));
  dispatchKeyEvent(element, "keyup", ch, mods);
  if (needShift) {
    await sleepPage(rand(5, 18));
    dispatchKeyEvent(element, "keyup", "Shift", { shiftKey: false });
  }
  await sleepPage(rand(35, 140));
  return { defaultPrevented: false };
}

async function typeIntoPage(selector, uid, text, pressEnter) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  const initialValue = "value" in element ? element.value : (element.isContentEditable ? element.textContent : null);
  element.focus();
  if (!(element.isContentEditable || "value" in element)) throw new Error("Focused element is not text-editable");
  for (const ch of Array.from(text)) await typeCharacter(element, ch);
  if (pressEnter) await pressKeyInPage("Enter");
  const finalValue = "value" in element ? element.value : element.textContent;
  const valueMatches = "value" in element ? element.value.includes(text) : (element.textContent || "").includes(text);
  const pageMutated = pageHash() !== before;
  // Smart-auto retry hint when typing didn't land at all (e.g., editor blocks DOM-event input).
  let suggestChromeInput = false, suggestReason;
  if (text.length > 0 && initialValue === finalValue) {
    suggestChromeInput = true;
    suggestReason = "value did not change — editor likely rejects DOM-event input";
  }
  return {
    selector, uid, length: text.length, pressEnter,
    input: "dom",
    valueMatches,
    pageMutated,
    suggestChromeInput: suggestChromeInput || undefined,
    suggestReason,
  };
}

async function fillPage(selector, uid, text, submit) {
  installPiChromeInstrumentation();
  const before = pageHash();
  let element = elementBySelectorOrUid(selector, uid) || document.activeElement;
  if (!element) throw new Error(selector || uid ? `No element for ${selector || uid}` : "No active element");
  element.focus();
  if (element.isContentEditable) {
    element.textContent = "";
    document.execCommand("insertText", false, text);
  } else if ("value" in element) {
    setNativeValue(element, text);
    const length = String(text).length;
    try { element.selectionStart = element.selectionEnd = length; } catch {}
    dispatchInputEvents(element, text, "insertReplacementText");
  } else {
    throw new Error("Focused element is not text-editable");
  }
  if (submit) await pressKeyInPage("Enter");
  return {
    selector, uid, length: String(text).length, submit,
    input: "dom",
    valueMatches: "value" in element ? element.value === String(text) : undefined,
    pageMutated: pageHash() !== before,
  };
}

async function pressKeyInPage(key) {
  const normalized = normalizeKey(key);
  const target = document.activeElement || document.body;
  const before = pageHash();
  const down = dispatchKeyEvent(target, "keydown", normalized);
  if (normalized.length === 1) dispatchKeyEvent(target, "keypress", normalized);
  // Character insertion for printable keys when focus is in an editable.
  if (normalized.length === 1 && !down.defaultPrevented && (target.isContentEditable || ("value" in target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")))) {
    if (target.isContentEditable) {
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: normalized });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        document.execCommand("insertText", false, normalized);
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: normalized }));
      }
    } else {
      const start = target.selectionStart ?? target.value.length;
      const end = target.selectionEnd ?? target.value.length;
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertText", data: normalized });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        setNativeValue(target, target.value.slice(0, start) + normalized + target.value.slice(end));
        try { target.selectionStart = target.selectionEnd = start + 1; } catch {}
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: normalized }));
      }
    }
  } else if (normalized === "Backspace" && "value" in target) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? target.value.length;
    if (start > 0 || end > start) {
      const from = start === end ? start - 1 : start;
      const bi = new InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "deleteContentBackward" });
      target.dispatchEvent(bi);
      if (!bi.defaultPrevented) {
        setNativeValue(target, target.value.slice(0, from) + target.value.slice(end));
        try { target.selectionStart = target.selectionEnd = from; } catch {}
        target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
      }
    }
  }
  await sleepPage(rand(25, 95));
  const up = dispatchKeyEvent(target, "keyup", normalized);
  if (normalized === "Enter") {
    const form = target.closest?.("form");
    if (form) form.requestSubmit?.();
  }
  return {
    key: normalized,
    input: "dom",
    defaultPrevented: down.defaultPrevented || up.defaultPrevented,
    pageMutated: pageHash() !== before,
  };
}

function listConsoleMessages(clear) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const messages = state.console.slice();
  if (clear) state.console = [];
  return { messages, count: messages.length };
}

function listNetworkRequests(includePreservedRequests, clear) {
  installPiChromeInstrumentation();
  const state = getPiChromeState();
  const currentUrl = location.href;
  const requests = state.network
    .filter((request) => includePreservedRequests || request.pageUrl === currentUrl)
    .map(({ responseBody, ...summary }) => ({ ...summary, hasResponseBody: responseBody !== undefined }));
  if (clear) state.network = [];
  return { requests, count: requests.length, note: "Captures fetch/XHR after instrumentation is installed. Browser-initiated document/static asset requests are not captured." };
}

function getNetworkRequest(requestId) {
  installPiChromeInstrumentation();
  const request = getPiChromeState().network.find((entry) => entry.id === requestId);
  if (!request) throw new Error(`No network request with id ${requestId}`);
  return request;
}

function normalizeKey(key) {
  const table = {
    enter: "Enter",
    escape: "Escape",
    tab: "Tab",
    backspace: "Backspace",
    delete: "Delete",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
  };
  return table[String(key).toLowerCase()] || key;
}
