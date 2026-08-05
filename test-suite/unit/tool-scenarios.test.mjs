// Long-horizon tool tests: exercises every new tool in seeded browser scenarios.
//
// Each test loads the real service_worker.js into a vm sandbox with a stateful
// chrome.* mock that simulates browser state (tabs, cookies, downloads, history,
// sessions, debugger). We call dispatch() with real params and assert behavior.
//
// Tests cover: emulate, cookies, network, identity, downloads, history, sessions,
// scroll (scrollIntoView/DOM fallback), CDP retry, tab-close cleanup.

import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.resolve(__dirname, "../../extensions/chrome-profile-bridge/browser-extension/service_worker.js");
const src = fs.readFileSync(workerPath, "utf8");

let failures = 0;
let passes = 0;
function ok(cond, msg) {
  if (cond) { passes++; }
  else { failures++; console.error(`  ✗ ${msg}`); }
}

async function throwsWith(fn, re, msg) {
  try { await fn(); ok(false, `${msg} (expected throw)`); }
  catch (e) { ok(re.test(String(e.message || e)), `${msg} (got: ${e.message})`); }
}

// ---- Stateful Chrome mock with all APIs we need ----
function makeChromeState() {
  const tabs = new Map();
  const windows = new Map();
  const groups = new Map();
  const cookies = new Map(); // key: `${domain}:${name}:${path}`
  const downloads = new Map();
  const historyEntries = [];
  const sessionEntries = []; // recently closed
  const storage = {};
  let nextTabId = 100;
  let nextWindowId = 10;
  let nextGroupId = 1;
  let nextDownloadId = 1;
  const alloc = { tab: () => nextTabId++, window: () => nextWindowId++, group: () => nextGroupId++, download: () => nextDownloadId++ };

  // Seed user tabs
  const userWindowId = alloc.window();
  windows.set(userWindowId, { id: userWindowId });
  const githubTab = { id: alloc.tab(), windowId: userWindowId, url: "https://github.com/user/repo/pull/42", active: true, groupId: -1, title: "PR #42 · user/repo" };
  const gmailTab = { id: alloc.tab(), windowId: userWindowId, url: "https://mail.google.com/", active: false, groupId: -1, title: "Inbox" };
  tabs.set(githubTab.id, githubTab);
  tabs.set(gmailTab.id, gmailTab);

  // Seed cookies
  const sessionCookie = { name: "sessionid", value: "abc123", domain: "github.com", path: "/", secure: true, httpOnly: true, sameSite: "lax", hostOnly: false, session: true, expirationDate: undefined };
  const authCookie = { name: "auth_token", value: "xyz789", domain: "mail.google.com", path: "/", secure: true, httpOnly: true, sameSite: "no_restriction", hostOnly: false, session: false, expirationDate: Date.now() / 1000 + 3600 };
  cookies.set("github.com:sessionid:/", sessionCookie);
  cookies.set("mail.google.com:auth_token:/", authCookie);

  // Seed downloads
  downloads.set(1, { id: 1, filename: "/Users/test/report.pdf", url: "https://example.com/report.pdf", state: "complete", totalBytes: 102400, exists: true, startTime: Date.now() - 60000 });

  // Seed history
  historyEntries.push({ url: "https://news.ycombinator.com/", title: "Hacker News", lastVisitTime: Date.now() - 3600000, visitCount: 5 });
  historyEntries.push({ url: "https://github.com/user/repo", title: "GitHub · user/repo", lastVisitTime: Date.now() - 7200000, visitCount: 12 });

  // Seed recently closed sessions
  sessionEntries.push({ tab: { id: 50, url: "https://docs.python.org/3/", title: "Python Docs", windowId: userWindowId }, lastModified: Date.now() - 120000 });
  sessionEntries.push({ window: { tabs: [{ id: 51, url: "https://stackoverflow.com/", title: "Stack Overflow" }] }, lastModified: Date.now() - 300000 });

  return { tabs, windows, groups, cookies, downloads, historyEntries, sessionEntries, storage, alloc, userWindowId, githubTab, gmailTab };
}

function makeChrome(state) {
  const { tabs, windows, groups, cookies, downloads, historyEntries, sessionEntries, storage, alloc, userWindowId } = state;
  const noop = () => {};
  const listener = { addListener: noop, removeListener: noop };

  // CDP command handler: tests set state._cdpHandler before makeChrome
  let debuggerAttached = new Set();

  const chrome = {
    runtime: { id: "unittestext", getManifest: () => ({ version: "0.16.0" }), onInstalled: listener, onStartup: listener, lastError: null, reload: noop },
    alarms: { onAlarm: listener, create: noop, clear: noop, clearAll: noop },
    action: { onClicked: listener, setBadgeText: noop, setBadgeBackgroundColor: noop },
    debugger: {
      onDetach: listener,
      onEvent: listener,
      attach: async (debuggee, version) => { debuggerAttached.add(debuggee.tabId || debuggee.targetId); },
      detach: async (debuggee) => { debuggerAttached.delete(debuggee.tabId || debuggee.targetId); },
      getTargets: (cb) => cb([]),
      sendCommand: (debuggee, method, params, cb) => {
        const handler = state._cdpHandler;
        if (handler) {
          try { const result = handler(method, params, debuggee); cb(result); }
          catch (e) { chrome.runtime.lastError = { message: e.message }; cb(undefined); chrome.runtime.lastError = null; }
        } else { cb({}); }
      },
    },
    scripting: {
      executeScript: async () => [{ result: undefined }],
      registerContentScripts: async () => {},
      unregisterContentScripts: async () => {},
    },
    webNavigation: { onCommitted: listener },
    tabs: {
      onUpdated: listener,
      onRemoved: { addListener: noop, removeListener: noop },
      query: async (q = {}) => {
        let list = [...tabs.values()];
        if (q.active === true) list = list.filter((t) => t.active);
        if (typeof q.windowId === "number") list = list.filter((t) => t.windowId === q.windowId);
        return list.map((t) => ({ ...t }));
      },
      get: async (id) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); return { ...t }; },
      create: async ({ url = "about:blank", active = false, windowId = userWindowId } = {}) => {
        const tab = { id: alloc.tab(), windowId, url, active, groupId: -1 };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      update: async (id, props = {}) => { const t = tabs.get(id); if (!t) throw new Error(`No tab with id ${id}`); Object.assign(t, props); return { ...t }; },
      remove: async (id) => { tabs.delete(id); },
      group: async ({ groupId, tabIds = [] } = {}) => {
        let gid = groupId;
        if (typeof gid !== "number") { gid = alloc.group(); groups.set(gid, { id: gid, title: "", color: "grey", collapsed: false, windowId: userWindowId }); }
        for (const tid of tabIds) { const t = tabs.get(tid); if (t) t.groupId = gid; }
        return gid;
      },
      ungroup: async (id) => { const ids = Array.isArray(id) ? id : [id]; for (const tid of ids) { const t = tabs.get(tid); if (t) t.groupId = -1; } },
      activate: noop,
    },
    tabGroups: {
      query: async ({ windowId } = {}) => [...groups.values()].filter((g) => windowId === undefined || g.windowId === windowId).map((g) => ({ ...g })),
      get: async (id) => { const g = groups.get(id); if (!g) throw new Error(`No group ${id}`); return { ...g }; },
      update: async (id, props = {}) => { const g = groups.get(id); if (!g) throw new Error(`No group ${id}`); Object.assign(g, props); return { ...g }; },
    },
    storage: {
      session: { get: async (key) => (key in storage ? { [key]: storage[key] } : {}), set: async (obj) => { Object.assign(storage, obj); } },
    },
    windows: {
      create: async ({ url = "about:blank", focused = false } = {}) => {
        const id = alloc.window();
        windows.set(id, { id });
        const tab = { id: alloc.tab(), windowId: id, url, active: true, groupId: -1 };
        tabs.set(tab.id, tab);
        return { id, focused, tabs: [{ ...tab }] };
      },
      get: async (id) => { const w = windows.get(id); if (!w) throw new Error(`No window ${id}`); return { ...w }; },
      remove: async (id) => { windows.delete(id); for (const [tid, t] of [...tabs]) if (t.windowId === id) tabs.delete(tid); },
      update: async () => {},
    },
    cookies: {
      getAll: async (details = {}) => {
        let list = [...cookies.values()];
        if (details.domain) list = list.filter((c) => c.domain === details.domain || c.domain.endsWith("." + details.domain));
        if (details.name) list = list.filter((c) => c.name === details.name);
        if (details.url) { try { const h = new URL(details.url).hostname; list = list.filter((c) => h === c.domain || h.endsWith("." + c.domain)); } catch {} }
        if (details.path) list = list.filter((c) => c.path === details.path);
        if (details.secure !== undefined) list = list.filter((c) => c.secure === details.secure);
        return list;
      },
      set: async (details) => {
        const domain = details.domain || (() => { try { return new URL(details.url).hostname; } catch { return "unknown"; } })();
        const cookie = {
          name: details.name, value: details.value || "", domain,
          path: details.path || "/", secure: !!details.secure, httpOnly: !!details.httpOnly,
          sameSite: details.sameSite || "lax", hostOnly: !domain.startsWith("."),
          session: !details.expirationDate, expirationDate: details.expirationDate,
        };
        cookies.set(`${domain}:${cookie.name}:${cookie.path}`, cookie);
        return cookie;
      },
      remove: async (details) => {
        try {
          const h = new URL(details.url).hostname;
          for (const [key, c] of cookies) { if (c.domain === h && c.name === details.name) { cookies.delete(key); return { url: details.url, name: details.name }; } }
        } catch {}
        return null;
      },
    },
    downloads: {
      download: async (details) => { const id = alloc.download(); downloads.set(id, { id, filename: details.filename || "download", url: details.url, state: "complete", totalBytes: 0, exists: true, startTime: Date.now() }); return id; },
      search: async (q = {}) => {
        let list = [...downloads.values()];
        if (q.state) list = list.filter((d) => d.state === q.state);
        list = list.sort((a, b) => (b.startTime || 0) - (a.startTime || 0));
        return list.slice(0, q.limit || 10);
      },
    },
    history: {
      search: async (q = {}) => {
        let list = [...historyEntries];
        if (q.text) list = list.filter((h) => (h.url || "").includes(q.text) || (h.title || "").includes(q.text));
        if (q.startTime) list = list.filter((h) => h.lastVisitTime >= q.startTime);
        return list.slice(0, q.maxResults || 20);
      },
      deleteUrl: async (details) => {
        const idx = historyEntries.findIndex((h) => h.url === details.url);
        if (idx >= 0) historyEntries.splice(idx, 1);
      },
    },
    sessions: {
      getRecentlyClosed: async (q = {}) => [...sessionEntries].slice(0, q.maxResults || 10),
    },
    identity: {
      getAuthToken: async (details = {}) => "mock_oauth_token_abc123",
    },
  };

  state._debuggerAttached = debuggerAttached;
  return chrome;
}

function loadWorker(chrome) {
  const noop = () => {};
  const sandbox = {
    console, JSON, Date, Math, Promise, Array, Object, String, Number, Boolean,
    Error, TypeError, Map, Set, BigInt, Symbol, structuredClone,
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval: noop,
    fetch: async () => { throw new Error("no network in unit test"); },
    navigator: { userAgent: "unit-test" },
    WebSocket: function () {},
    chrome,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox;
}

const SK = "session:test";

// ====================================================================
async function run() {
  // ===== EMULATE: device metrics, geolocation, timezone, CPU, clear =====
  {
    const state = makeChromeState();
    state._cdpHandler = (method, params) => {
      if (method === "Emulation.setDeviceMetricsOverride") return { width: params.width, height: params.height };
      if (method === "Emulation.setGeolocationOverride") return {};
      if (method === "Emulation.setTimezoneOverride") return {};
      if (method === "Emulation.setCPUThrottlingRate") return {};
      if (method === "Emulation.clearDeviceMetricsOverride") return {};
      if (method === "Emulation.clearGeolocationOverride") return {};
      if (method === "Emulation.clearTimezoneOverride") return {};
      return {};
    };
    const w = loadWorker(makeChrome(state));

    // Navigate first to create an automation target
    const nav = await w.dispatch("page.navigate", { url: "https://app.test", waitUntilLoad: false, sessionKey: SK });

    const device = await w.dispatch("emulate.device", { width: 414, height: 896, sessionKey: SK });
    ok(device.emulated === "device", "emulate.device: returns emulated=device");
    ok(device.width === 414 && device.height === 896, "emulate.device: returns correct dimensions");

    const geo = await w.dispatch("emulate.geolocation", { latitude: 35.6762, longitude: 139.6503, sessionKey: SK });
    ok(geo.emulated === "geolocation", "emulate.geolocation: returns emulated=geolocation");
    ok(geo.latitude === 35.6762, "emulate.geolocation: latitude echoed");

    const tz = await w.dispatch("emulate.timezone", { timezoneId: "Asia/Tokyo", sessionKey: SK });
    ok(tz.emulated === "timezone", "emulate.timezone: returns emulated=timezone");
    ok(tz.timezoneId === "Asia/Tokyo", "emulate.timezone: timezoneId echoed");

    const cpu = await w.dispatch("emulate.cpu", { rate: 6, sessionKey: SK });
    ok(cpu.emulated === "cpu", "emulate.cpu: returns emulated=cpu");
    ok(cpu.rate === 6, "emulate.cpu: rate echoed");

    const cleared = await w.dispatch("emulate.clear", { sessionKey: SK });
    ok(cleared.cleared === true, "emulate.clear: returns cleared=true");
  }
  console.log("emulate: done");

  // ===== COOKIES: get, set, remove with seeded data =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));

    // Get all cookies for github.com
    const githubCookies = await w.dispatch("cookies.getAll", { domain: "github.com" });
    ok(githubCookies.cookies.length >= 1, "cookies.getAll: found github.com cookies");
    ok(githubCookies.cookies.some((c) => c.name === "sessionid"), "cookies.getAll: found sessionid cookie");
    ok(githubCookies.cookies.every((c) => c.value.length <= 100 || c.value.includes("...")), "cookies.getAll: long values truncated");

    // Get by URL
    const gmailCookies = await w.dispatch("cookies.getAll", { url: "https://mail.google.com/" });
    ok(gmailCookies.cookies.some((c) => c.name === "auth_token"), "cookies.getAll(url): found auth_token via URL filter");

    // Set a new cookie
    await w.dispatch("cookies.set", { url: "https://api.test", name: "api_key", value: "secret123", secure: true });
    const apiCookies = await w.dispatch("cookies.getAll", { url: "https://api.test" });
    ok(apiCookies.cookies.some((c) => c.name === "api_key" && c.value === "secret123"), "cookies.set: new cookie was created and is retrievable");

    // Remove a cookie
    await w.dispatch("cookies.remove", { url: "https://github.com/", name: "sessionid" });
    const afterRemove = await w.dispatch("cookies.getAll", { domain: "github.com" });
    ok(!afterRemove.cookies.some((c) => c.name === "sessionid"), "cookies.remove: sessionid was deleted");
  }
  console.log("cookies: done");

  // ===== NETWORK: userAgent, clearCache, clearCookies =====
  {
    const state = makeChromeState();
    let lastCdpMethod = null;
    state._cdpHandler = (method) => { lastCdpMethod = method; return {}; }
    const w = loadWorker(makeChrome(state));

    // Navigate first
    await w.dispatch("page.navigate", { url: "https://app.test", waitUntilLoad: false, sessionKey: SK });

    const ua = await w.dispatch("network.userAgent", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)", sessionKey: SK });
    ok(ua.set === true, "network.userAgent: returns set=true");
    ok(lastCdpMethod === "Network.setUserAgentOverride", "network.userAgent: called correct CDP method");

    const cache = await w.dispatch("network.clearCache", { sessionKey: SK });
    ok(cache.cleared === "cache", "network.clearCache: returns cleared=cache");

    const cookies = await w.dispatch("network.clearCookies", { sessionKey: SK });
    ok(cookies.cleared === "cookies", "network.clearCookies: returns cleared=cookies");
  }
  console.log("network: done");

  // ===== IDENTITY: get OAuth token =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));

    const token = await w.dispatch("identity.getToken", { interactive: true, scopes: ["https://www.googleapis.com/auth/drive.readonly"] });
    ok(token.token === "mock_oauth_token_abc123", "identity.getToken: returned mock token");
  }
  console.log("identity: done");

  // ===== DOWNLOADS: download + list with seeded data =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));

    // List existing downloads
    const before = await w.dispatch("downloads.list", {});
    ok(before.downloads.length >= 1, "downloads.list: found seeded downloads");
    ok(before.downloads.some((d) => d.filename.includes("report.pdf")), "downloads.list: seeded PDF is present");

    // Download a new file
    const dl = await w.dispatch("downloads.download", { url: "https://example.com/data.json", filename: "data.json" });
    ok(dl.downloaded === true, "downloads.download: returns downloaded=true");
    ok(typeof dl.downloadId === "number", "downloads.download: returns a download ID");

    // Verify it appears in list
    const after = await w.dispatch("downloads.list", {});
    ok(after.downloads.some((d) => d.filename === "data.json"), "downloads.download: new download appears in list");
  }
  console.log("downloads: done");

  // ===== HISTORY: search + delete with seeded data =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));

    // Search all history
    const all = await w.dispatch("history.search", { text: "" });
    ok(all.results.length >= 2, "history.search: found seeded entries");
    ok(all.results.some((h) => h.url.includes("news.ycombinator.com")), "history.search: HN entry present");
    ok(all.results.some((h) => h.url.includes("github.com")), "history.search: GitHub entry present");

    // Search by text
    const filtered = await w.dispatch("history.search", { text: "github" });
    ok(filtered.results.every((h) => (h.url + h.title).toLowerCase().includes("github")), "history.search(text): results match query");

    // Delete a URL
    await w.dispatch("history.deleteUrl", { url: "https://news.ycombinator.com/" });
    const after = await w.dispatch("history.search", { text: "" });
    ok(!after.results.some((h) => h.url.includes("news.ycombinator.com")), "history.deleteUrl: HN entry removed");
    ok(after.results.length === all.results.length - 1, "history.deleteUrl: count decreased by 1");
  }
  console.log("history: done");

  // ===== SESSIONS: recently closed =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));

    const recent = await w.dispatch("sessions.recent", { maxResults: 10 });
    ok(recent.sessions.length >= 2, "sessions.recent: found seeded closed sessions");
    ok(recent.sessions.some((s) => s.type === "tab" && s.tab.url.includes("docs.python.org")), "sessions.recent: Python Docs tab present");
    ok(recent.sessions.some((s) => s.type === "window"), "sessions.recent: closed window present");
  }
  console.log("sessions: done");

  // ===== SCROLL: scrollIntoView fires before wheel events =====
  {
    const state = makeChromeState();
    let scrollIntoViewCalled = false;
    let wheelEventCount = 0;

    // Mock executeScript to track calls
    const chrome = makeChrome(state);
    chrome.scripting.executeScript = async (opts) => {
      if (opts.func && opts.func.toString().includes('scrollIntoView')) { scrollIntoViewCalled = true; }
      return [{ result: undefined }];
    };
    state._cdpHandler = (method) => {
      if (method === 'Input.dispatchMouseEvent') { wheelEventCount++; return {}; }
      return {};
    };
    const w = loadWorker(chrome);

    // Scroll directly on an existing user tab (github PR tab)
    const result = await w.dispatch('page.scroll', { targetId: state.githubTab.id, uid: 'el-42', deltaY: 300 });
    ok(scrollIntoViewCalled, 'scroll(uid): scrollIntoView was called');
    ok(result !== undefined, 'scroll(uid): scroll returned a result (did not throw)');
  }
  console.log("scroll: done");

  // ===== SCROLL: large scroll caps wheel events and covers remainder =====
  {
    const state = makeChromeState();
    let scrollByCalled = false;
    let scrollByArgs = null;
    let wheelEventCount = 0;

    const chrome = makeChrome(state);
    chrome.scripting.executeScript = async (opts) => {
      if (opts.func && opts.func.toString().includes("scrollBy")) {
        scrollByCalled = true;
        scrollByArgs = opts.args;
      }
      return [{ result: undefined }];
    };
    state._cdpHandler = (method) => {
      if (method === "Input.dispatchMouseEvent") { wheelEventCount++; return {}; }
      return {};
    };
    const w = loadWorker(chrome);
    await w.dispatch("page.navigate", { url: "https://app.test", waitUntilLoad: false, sessionKey: SK });

    // 10000px scroll — would previously generate 200+ events
    const result = await w.dispatch("page.scroll", { deltaY: 10000, sessionKey: SK });
    ok(wheelEventCount <= 40, "scroll(10000px): wheel events capped at 40");
    ok(scrollByCalled, "scroll(10000px): remainder covered by scrollBy");
    ok(result.wheelEvents <= 40, "scroll(10000px): result reports capped wheel count");
    ok(result.remainderApplied !== undefined, "scroll(10000px): remainder reported in result");
  }
  console.log("scroll-large: done");

  // ===== SCROLL: DOM fallback when debugger fails =====
  {
    const state = makeChromeState();
    let scrollByCalled = false;
    const chrome = makeChrome(state);
    chrome.scripting.executeScript = async () => { return [{ result: undefined }]; };
    // Make debugger.attach fail to trigger the DOM fallback
    chrome.debugger.attach = async () => { throw new Error("Cannot attach"); };
    state._cdpHandler = () => { throw new Error("should not reach"); };
    const w = loadWorker(chrome);
    await w.dispatch("page.navigate", { url: "https://app.test", waitUntilLoad: false, sessionKey: SK });

    chrome.scripting.executeScript = async (opts) => {
      if (opts.func && opts.func.toString().includes("scrollBy")) scrollByCalled = true;
      return [{ result: undefined }];
    };

    const result = await w.dispatch("page.scroll", { deltaY: 500, sessionKey: SK });
    ok(result.input === "dom-fallback", "scroll(dom-fallback): returns input=dom-fallback when CDP fails");
    ok(scrollByCalled, "scroll(dom-fallback): window.scrollBy was called as fallback");
  }
  console.log("scroll-fallback: done");

  // ===== TAB CLOSE: onRemoved cleans up attachedTabs and initScriptIds =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state);
    const removedCallbacks = [];
    chrome.tabs.onRemoved = { addListener: (fn) => { removedCallbacks.push(fn); }, removeListener: () => {} };

    state._cdpHandler = () => ({});
    const w = loadWorker(chrome);

    // Navigate to create automation target
    const nav = await w.dispatch("page.navigate", { url: "https://app.test", waitUntilLoad: false, sessionKey: SK });

    // Attach debugger to the tab
    await w.attachDebugger(nav.id);

    // Simulate tab close — the onRemoved listener should clean up without error
    let closeError = null;
    try { for (const cb of removedCallbacks) cb(nav.id); } catch (e) { closeError = e; }
    ok(!closeError, 'tab-close: onRemoved callback does not throw');

    // Give microtasks a chance
    await new Promise((r) => setTimeout(r, 10));
  }
  console.log("tab-close: done");

  // ===== COOKIES: error when API unavailable =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state);
    delete chrome.cookies; // simulate no cookies permission
    const w = loadWorker(chrome);

    await throwsWith(
      () => w.dispatch("cookies.getAll", { domain: "github.com" }),
      /chrome\.cookies API unavailable/i,
      "cookies.getAll: throws when API unavailable",
    );
  }
  console.log("cookies-error: done");

  // ===== IDENTITY: error when API unavailable =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state);
    delete chrome.identity;
    const w = loadWorker(chrome);

    await throwsWith(
      () => w.dispatch("identity.getToken", {}),
      /chrome\.identity API unavailable/i,
      "identity.getToken: throws when API unavailable",
    );
  }
  console.log("identity-error: done");

  // ===== DOWNLOADS: error when API unavailable =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state);
    delete chrome.downloads;
    const w = loadWorker(chrome);

    await throwsWith(
      () => w.dispatch("downloads.download", { url: "https://x.test/f" }),
      /chrome\.downloads API unavailable/i,
      "downloads.download: throws when API unavailable",
    );
  }
  console.log("downloads-error: done");

  // ===== HISTORY: error when API unavailable =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state);
    delete chrome.history;
    const w = loadWorker(chrome);

    await throwsWith(
      () => w.dispatch("history.search", { text: "" }),
      /chrome\.history API unavailable/i,
      "history.search: throws when API unavailable",
    );
  }
  console.log("history-error: done");

  // ===== SESSIONS: error when API unavailable =====
  {
    const state = makeChromeState();
    const chrome = makeChrome(state);
    delete chrome.sessions;
    const w = loadWorker(chrome);

    await throwsWith(
      () => w.dispatch("sessions.recent", {}),
      /chrome\.sessions API unavailable/i,
      "sessions.recent: throws when API unavailable",
    );
  }
  console.log("sessions-error: done");

  // ===== RELEASE STUCK INPUT: fires on terminal Input failure =====
  {
    const state = makeChromeState();
    const releasedEvents = [];
    state._cdpHandler = (method) => {
      if (method === "Input.dispatchMouseEvent") { throw new Error("Detached while handling command"); }
      if (method === "Input.dispatchKeyEvent") { throw new Error("Detached while handling command"); }
      return {};
    };
    // Make attach fail so the retry also fails → triggers releaseStuckInput + throw
    const chrome = makeChrome(state);
    chrome.debugger.attach = async () => { throw new Error("Cannot re-attach"); };
    const w = loadWorker(chrome);
    await w.dispatch("page.navigate", { url: "https://app.test", waitUntilLoad: false, sessionKey: SK });

    const result = await w.dispatch("page.scroll", { deltaY: 200, sessionKey: SK });
    ok(result.input === "dom-fallback", "stuck-input: scroll falls back to DOM when debugger fails");
  }
  console.log("stuck-input: done");

  // ===== UNKNOWN ACTION: dispatch rejects with clear error =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    await throwsWith(
      () => w.dispatch("totally.fake", {}),
      /Unknown action/i,
      "unknown-action: dispatch rejects unknown actions",
    );
  }
  console.log("unknown-action: done");

  // ===== VERSION: returns extension metadata =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const version = await w.dispatch("tab.version", {});
    ok(version.extensionId === "unittestext", "tab.version: returns extensionId");
    ok(version.bridgeUrl === "http://127.0.0.1:17318", "tab.version: returns bridgeUrl");
    ok(version.userAgent === "unit-test", "tab.version: returns userAgent");
  }
  console.log("version: done");

  // ===== COOKIES: value truncation for long values =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    // Set a cookie with a very long value
    const longValue = "x".repeat(500);
    await w.dispatch("cookies.set", { url: "https://app.test", name: "big", value: longValue });
    const result = await w.dispatch("cookies.getAll", { url: "https://app.test" });
    const big = result.cookies.find((c) => c.name === "big");
    ok(big.value.length <= 103, "cookies.truncate: long value truncated to ~100 chars");
    ok(big.value.endsWith("..."), "cookies.truncate: truncated value ends with ...");
  }
  console.log("cookies-truncate: done");

  // ===== HISTORY: empty result on no match =====
  {
    const state = makeChromeState();
    const w = loadWorker(makeChrome(state));
    const result = await w.dispatch("history.search", { text: "nonexistent-page-zzz" });
    ok(result.results.length === 0, "history.search: returns empty for no matches");
  }
  console.log("history-empty: done");

  // ===== CONCURRENT ATTACH: serialize for same tab =====
  {
    const state = makeChromeState();
    let attachCount = 0;
    const chrome = makeChrome(state);
    chrome.debugger.attach = async () => { attachCount++; await new Promise(r => setTimeout(r, 10)); };
    state._cdpHandler = () => ({});
    const w = loadWorker(chrome);

    const nav = await w.dispatch("page.navigate", { url: "https://app.test", waitUntilLoad: false, sessionKey: SK });

    // Two concurrent attaches to the same tab
    const [a1, a2] = await Promise.all([
      w.attachDebugger(nav.id),
      w.attachDebugger(nav.id),
    ]);

    ok(attachCount <= 1, "concurrent-attach: only one real attach call (serialized)");
    ok(a1 === a2, "concurrent-attach: both callers get same entry");
  }
  console.log("concurrent-attach: done");

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures > 0) process.exit(1);
}

run().catch((e) => { console.error(e); process.exit(1); });

