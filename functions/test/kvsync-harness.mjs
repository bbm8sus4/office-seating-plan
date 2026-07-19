// Integration harness for the KV-sync optimistic-lock slice.
//
// This is a REAL integration test, not a mock-the-logic unit test:
//   - The actual client <script> block from dist/index.html is eval'd inside a vm sandbox.
//     Every target function (_scheduleSharedPush, _sharedPushNow, _pushBundle, _gatherShared,
//     _saveInactiveOrg, _resolveConflictKeepMine/UseTheirs, _applyShared, pullShared, the 4 inactive-org
//     actions) runs for real — NONE are stubbed out.
//   - Only the *environment* is shimmed: localStorage (real in-memory, per device/VM), timers
//     (controllable fake so the 700ms debounce is driven explicitly), and fetch (a fake /api/state
//     endpoint that enforces baseVer exactly like functions/api/state.js: version match → commit +1,
//     mismatch → 409 with {ver,data}).
//   - Two devices (A, B) are two separate VM sandboxes with SEPARATE localStorage but a SHARED server,
//     so cross-device 409 ordering is exercised end-to-end.
//
// Run: node functions/test/kvsync-harness.mjs
// Exit 0 = all pass, non-zero = failure (verification gate: fail-closed).

import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// DIST_OVERRIDE lets a mutation test point the harness at a deliberately-broken copy to confirm the tests fail-closed.
const DIST = process.env.DIST_OVERRIDE || path.join(__dirname, '..', '..', 'dist', 'index.html');

// ---- extract the big client <script> block (the second one; first is the theme bootstrap) ----
function extractClientScript() {
  const html = fs.readFileSync(DIST, 'utf8');
  const lines = html.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    // the real app block opens with a bare "<script>" on its own line near L1852
    if (i >= 1800 && lines[i].trim() === '<script>') { start = i; break; }
  }
  if (start < 0) throw new Error('could not locate client <script> block');
  let end = -1;
  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j].includes('</script>')) { end = j; break; }
  }
  if (end < 0) throw new Error('could not locate closing </script>');
  return lines.slice(start + 1, end).join('\n');
}

// ---- a deep no-op proxy for DOM nodes / document — every access returns another no-op, every call returns one ----
function makeNoop() {
  const fn = function () { return noop; };
  const noop = new Proxy(fn, {
    get(_t, prop) {
      if (prop === Symbol.toPrimitive) return () => '';
      if (prop === 'style' || prop === 'classList' || prop === 'dataset') return noop;
      if (prop === 'length') return 0;
      if (prop === 'value') return '';
      if (prop === 'nodeType') return 1;
      if (prop === 'children' || prop === 'childNodes') return [];
      if (prop === 'parentNode' || prop === 'firstChild') return null;
      if (prop === 'textContent' || prop === 'innerHTML' || prop === 'className') return '';
      if (prop === 'getAttribute') return () => null;
      if (prop === 'appendChild' || prop === 'removeChild') return (x) => x;
      if (prop === Symbol.iterator) return [][Symbol.iterator].bind([]);
      return noop;
    },
    set() { return true; },
    apply() { return noop; },
  });
  return noop;
}

// ---- controllable fake timers (only setTimeout/clearTimeout matter for the 700ms debounce) ----
function makeTimers() {
  let seq = 1;
  const pending = new Map(); // id -> {fn, delay}
  return {
    api: {
      setTimeout(fn, delay) { const id = seq++; pending.set(id, { fn, delay: delay || 0 }); return id; },
      clearTimeout(id) { pending.delete(id); },
      setInterval() { return 0; },      // polling intervals: never auto-fire in tests
      clearInterval() {},
      requestAnimationFrame() { return 0; },
      cancelAnimationFrame() {},
    },
    // fire every currently-pending timeout (order by id = scheduling order)
    flush() {
      const ids = [...pending.keys()].sort((a, b) => a - b);
      for (const id of ids) { const t = pending.get(id); if (t) { pending.delete(id); t.fn(); } }
    },
    count() { return pending.size; },
  };
}

// ---- a real in-memory localStorage per device ----
function makeLocalStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    _dump: () => Object.fromEntries(m),
  };
}

// ---- shared fake server: mirrors functions/api/state.js optimistic-lock contract ----
function makeServer() {
  const srv = { ver: 0, data: null, posts: [] };
  // returns a {status, json} shaped like the real endpoint
  srv.post = (body) => {
    srv.posts.push({ baseVer: body.baseVer, ver: srv.ver });
    if ((body.baseVer | 0) !== srv.ver) {
      return { status: 409, json: { ver: srv.ver, data: srv.data } };
    }
    srv.ver += 1;
    srv.data = body.data;
    return { status: 200, json: { ver: srv.ver, data: srv.data } };
  };
  srv.get = () => ({ status: 200, json: { ver: srv.ver, data: srv.data } });
  return srv;
}

// ---- fetch shim wired to the shared server; returns a Promise resolved on the microtask queue ----
// controllable: mode 'normal' | 'network-fail'; failNext lets a single call reject (network failure test)
function makeFetch(server, ctrl) {
  return function fetch(url, opts) {
    const call = (async () => {
      if (ctrl.failNext) { ctrl.failNext = false; throw new Error('network down (injected)'); }
      let body = {};
      try { body = JSON.parse((opts && opts.body) || '{}'); } catch (e) {}
      const method = (opts && opts.method) || 'GET';
      // beforePost: a hook to interleave another device's write between a POST being issued and being evaluated
      // by the server — reproduces the deferred-push-hits-409 race deterministically. The hook inspects the
      // outgoing body and returns true when it has fired (so it consumes itself only on the POST it targets).
      if (method === 'POST' && ctrl.beforePost) { if (ctrl.beforePost(body) === true) ctrl.beforePost = null; }
      const res = method === 'POST' ? server.post(body) : server.get();
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        json: async () => res.json,
      };
    })();
    return call;
  };
}

// ---- build one device sandbox and eval the real client script into it ----
function makeDevice(name, clientSrc, server, ctrl) {
  const timers = makeTimers();
  const localStorage = makeLocalStorage();
  // document: mostly no-op, but getElementById returns real settable elements from a registry so tests can drive
  // DOM-reading code paths (e.g. confirmLinkOrg reads company/node <select> .value) without a full DOM.
  // element registry: each element carries a settable .value but is otherwise a no-op node (addEventListener,
  // style, classList, etc. all no-op) so boot code that wires listeners on real ids doesn't blow up.
  const elValues = new Map(); // id -> string value
  function makeEl(id) {
    const store = elValues;
    return new Proxy(function () {}, {
      get(_t, prop) {
        if (prop === 'value') return store.has(id) ? store.get(id) : '';
        if (prop === Symbol.toPrimitive) return () => '';
        return makeNoop();
      },
      set(_t, prop, val) { if (prop === 'value') store.set(id, String(val)); return true; },
      apply() { return makeNoop(); },
    });
  }
  const baseDoc = makeNoop();
  const doc = new Proxy(baseDoc, {
    get(_t, prop) {
      if (prop === 'getElementById') return (id) => makeEl(id);
      if (prop === 'visibilityState') return 'visible';
      return baseDoc[prop];
    },
  });
  const win = makeNoop();
  const sandbox = {
    console: { log() {}, error() {}, warn() {}, info() {} },
    localStorage,
    sessionStorage: makeLocalStorage(),
    document: doc,
    window: win,
    navigator: { userAgent: 'harness', language: 'th', onLine: true },
    location: { href: 'http://test/', reload() {}, search: '' },
    history: makeNoop(),
    screen: {},
    performance: { now: () => 0 },
    fetch: makeFetch(server, ctrl),
    setTimeout: timers.api.setTimeout,
    clearTimeout: timers.api.clearTimeout,
    setInterval: timers.api.setInterval,
    clearInterval: timers.api.clearInterval,
    requestAnimationFrame: timers.api.requestAnimationFrame,
    cancelAnimationFrame: timers.api.cancelAnimationFrame,
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    getComputedStyle: () => makeNoop(),
    alert() {}, confirm: () => true, prompt: () => null,
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    indexedDB: null,           // idb guarded by `if(!idb)` everywhere → backup paths safely skip
    FileReader: makeNoop(), Image: makeNoop(), Blob: makeNoop(),
    URL: { createObjectURL: () => '', revokeObjectURL() {} },
    IntersectionObserver: class { observe() {} unobserve() {} disconnect() {} },
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    MutationObserver: class { observe() {} disconnect() {} },
  };
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.dispatchEvent = () => true;
  sandbox.window = sandbox; // let `window.foo` resolve to sandbox globals where used
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  // eval the real client code. Top-level boot touches DOM (all no-op) — harmless.
  try {
    vm.runInContext(clientSrc, ctx, { filename: `client-${name}.js`, timeout: 10000 });
  } catch (e) {
    throw new Error(`[device ${name}] client eval failed: ${e.message}`);
  }
  return {
    name, ctx, timers, localStorage,
    run: (code) => vm.runInContext(code, ctx),
    setInput: (id, value) => { elValues.set(id, String(value)); },
  };
}

// ---- tiny assert / test runner ----
const results = [];
function test(name, fn) { results.push({ name, fn }); }
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg || 'eq'}: expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`); }
function ok(c, msg) { if (!c) throw new Error(msg || 'expected truthy'); }
// drain the microtask queue so fetch .then chains settle before we assert
const drain = () => new Promise((r) => setImmediate(r));

export { extractClientScript, makeDevice, makeServer, test, eq, ok, drain, results };
