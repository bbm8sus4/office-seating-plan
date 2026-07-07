// Cloudflare Pages Function middleware — gates the ENTIRE site (static assets + /api/*) behind HTTP Basic Auth.
// The password comes ONLY from env.SITE_PASSWORD (Pages > Settings > Environment variables). It is never
// hard-coded here, so this file is safe to commit and auto-deploy from GitHub.
//
// Design notes:
//  - Fail-CLOSED: if SITE_PASSWORD is unset/empty we return 401, never an open site.
//  - Timing-safe: we SHA-256 both the provided password and the expected one and compare the digests
//    byte-by-byte in constant time (relative to a fixed-length 32-byte digest), so response time doesn't
//    leak how many leading characters matched. We never use `===` on the raw secrets.
//  - Username is not checked (any username is accepted) — this matches the previous gate, which only
//    verified the password.

const REALM = "SeatMap - ใส่รหัสผ่าน"; // keep this exact Thai string — it's the login prompt users already know

// HTTP header values are ISO-8859-1 (ByteString) — a raw Thai char (>255) can't be placed in a header.
// Encode the realm to its UTF-8 bytes, then map each byte to a latin1 char. With `charset="UTF-8"` the
// browser decodes those bytes back to the Thai text in its login prompt (RFC 7617).
function realmHeaderValue() {
  const utf8 = new TextEncoder().encode(REALM);
  let latin1 = "";
  for (let i = 0; i < utf8.length; i++) latin1 += String.fromCharCode(utf8[i]);
  return 'Basic realm="' + latin1 + '", charset="UTF-8"';
}

function unauthorized() {
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": realmHeaderValue(),
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}

async function sha256Bytes(str) {
  const data = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(digest);
}

// constant-time compare of two equal-length byte arrays (both are 32-byte SHA-256 digests here)
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false; // digests are always 32 bytes; length never depends on the secret
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// decode the password out of an "Authorization: Basic base64(user:pass)" header; returns null if malformed
function passwordFromHeader(authHeader) {
  if (!authHeader) return null;
  const m = /^Basic\s+(.+)$/i.exec(authHeader.trim());
  if (!m) return null;
  let decoded;
  try {
    decoded = atob(m[1]); // "user:pass" (bytes). password may itself contain ':', so split on the FIRST ':' only
  } catch (e) {
    return null;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return null;
  return decoded.slice(idx + 1);
}

export async function onRequest(context) {
  const { request, env } = context;

  const expected = env && env.SITE_PASSWORD;
  // fail-closed: treat undefined / empty / WHITESPACE-ONLY as "not configured" — a value like "   " is almost
  // certainly a mistake and must not become a login of blanks. NOTE: we only .trim() for this emptiness check;
  // the actual compare below uses `expected` untrimmed, so a password that intentionally has leading/trailing
  // spaces still works.
  if (typeof expected !== "string" || expected.trim().length === 0) {
    try { console.error("[gate] SITE_PASSWORD is not set (or blank) — refusing all requests (fail-closed)"); } catch (e) {}
    return unauthorized();
  }

  const provided = passwordFromHeader(request.headers.get("Authorization"));
  if (provided == null) return unauthorized();

  // hash both sides, then constant-time compare the digests
  const [ph, eh] = await Promise.all([sha256Bytes(provided), sha256Bytes(expected)]);
  if (!timingSafeEqual(ph, eh)) return unauthorized();

  // authenticated. Force the HTML entry document to always revalidate so a new deploy reaches users immediately
  // instead of a stale cached copy of the single-file app.
  //
  // Why not just patch context.next()? For a STATIC asset, the header we set on context.next()'s response is
  // dropped by Cloudflare's asset-serving pipeline (verified on the live edge — only genuine Function responses
  // like /api/* keep their headers). The documented fix is to fetch the asset ourselves via env.ASSETS.fetch(),
  // which yields a Function-OWNED response whose headers survive. We then set Cache-Control on that.
  try {
    const path = new URL(request.url).pathname;
    const wantsHtml =
      path === "/" ||
      path === "/index.html" ||
      path.endsWith(".html") ||
      (path.endsWith("/") && !path.startsWith("/api/"));
    if (wantsHtml && !path.startsWith("/api/") && env && env.ASSETS) {
      // fetch the SAME path (not always "/") so we never serve the wrong file; just normalize the
      // /index.html → / that Cloudflare itself redirects, so we hit the served asset directly.
      const assetUrl = new URL(request.url);
      if (assetUrl.pathname === "/index.html") assetUrl.pathname = "/";
      const assetRes = await env.ASSETS.fetch(new Request(assetUrl.toString(), request));
      const patched = new Response(assetRes.body, assetRes);
      patched.headers.set("Cache-Control", "no-cache, must-revalidate");
      return patched;
    }
  } catch (e) {
    // never let the cache tweak break the site — fall through to the normal path
    try { console.error("[gate] ASSETS cache-header path failed, falling back", e && e.message); } catch (x) {}
  }

  // non-HTML, no ASSETS binding, or any failure above → normal passthrough (static asset or API function)
  return context.next();
}
