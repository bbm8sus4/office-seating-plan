// Cloudflare Pages Function at /api/state — the shared-state store behind the app's realtime sync.
// Auth is already enforced by functions/_middleware.js (it runs before this), so no auth here.
//
// Wire contract (must match dist/index.html exactly — pullShared / _sharedPushNow / _pushBundle):
//   GET  /api/state            -> 200 { ver:<int>, data:<bundle|null> }   (no state yet -> { ver:0, data:null })
//   POST /api/state {data, baseVer}
//        baseVer === currentVer -> 200 { ver:<newVer> }                    (accepted; ver incremented, KV written)
//        baseVer !== currentVer -> 409 { ver:<currentVer>, data:<currentData> }  (optimistic-lock conflict)
//        malformed JSON body    -> 400 { error }
//
// Storage: one KV key holds the whole envelope as JSON: { ver:<int>, data:<bundle> }.
// Robustness: if the KV binding is missing (not yet configured) we DEGRADE gracefully instead of 500-ing
// the whole site — GET returns an empty state, POST reports it couldn't persist. The client already has a
// local (localStorage/IndexedDB) fallback, so the app keeps working offline-of-KV.

const KEY = "shared-state";

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

// read the stored envelope; tolerate absent key / corrupt JSON by returning a clean empty envelope
async function readEnvelope(kv) {
  const raw = await kv.get(KEY);
  if (raw == null) return { ver: 0, data: null };
  try {
    const env = JSON.parse(raw);
    const ver = (env && Number.isFinite(env.ver)) ? (env.ver | 0) : 0;
    const data = (env && "data" in env) ? env.data : null;
    return { ver, data };
  } catch (e) {
    // corrupt stored value → treat as empty so a fresh POST can seed it (never throw to the client)
    return { ver: 0, data: null };
  }
}

export async function onRequestGet(context) {
  const kv = context.env && context.env.SEATMAP_KV;
  if (!kv) {
    // binding not configured yet → behave like an empty store so the client falls back to local data
    return json({ ver: 0, data: null });
  }
  try {
    const env = await readEnvelope(kv);
    return json({ ver: env.ver, data: env.data });
  } catch (e) {
    try { console.error("[api/state] GET failed", e && e.message); } catch (x) {}
    return json({ ver: 0, data: null }); // degrade, don't 500
  }
}

export async function onRequestPost(context) {
  const kv = context.env && context.env.SEATMAP_KV;
  if (!kv) {
    // can't persist without KV — tell the client clearly; it keeps its local copy. 503 (not 500) = transient/unconfigured.
    return json({ error: "shared store not configured" }, 503);
  }

  // parse body
  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return json({ error: "invalid JSON body" }, 400);
  }
  if (!body || typeof body !== "object" || !("baseVer" in body) || !("data" in body)) {
    return json({ error: "expected { data, baseVer }" }, 400);
  }
  const baseVer = body.baseVer | 0;

  try {
    const cur = await readEnvelope(kv);
    // optimistic lock: caller's baseVer must match what's stored, else it edited a stale copy
    if (baseVer !== cur.ver) {
      return json({ ver: cur.ver, data: cur.data }, 409);
    }
    const newVer = cur.ver + 1;
    await kv.put(KEY, JSON.stringify({ ver: newVer, data: body.data }));
    return json({ ver: newVer });
  } catch (e) {
    try { console.error("[api/state] POST failed", e && e.message); } catch (x) {}
    return json({ error: "write failed" }, 503); // transient — client keeps local copy, retries later
  }
}
