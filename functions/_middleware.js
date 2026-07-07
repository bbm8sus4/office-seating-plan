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

  // authenticated → let the request continue to the static asset / API function
  const res = await context.next();

  // Force the HTML entry document to always revalidate so a new deploy reaches users immediately instead of a
  // stale cached copy of the single-file app. We do this HERE (not in a _headers file) because every request
  // flows through this middleware, and Pages `_headers` rules do NOT apply to responses a Function returns —
  // context.next() makes this a Function response, so _headers would be ignored for it.
  // Scope tightly: only the HTML document. API responses (/api/*) set their own Cache-Control and are left alone.
  try {
    const url = new URL(request.url);
    const path = url.pathname;
    const isHtml =
      path === "/" ||
      path.endsWith(".html") ||
      (path.endsWith("/") && !path.startsWith("/api/")) ||
      /text\/html/i.test(res.headers.get("Content-Type") || "");
    if (isHtml && !path.startsWith("/api/")) {
      // context.next() may return an immutable Response; clone into a mutable one before editing headers
      const patched = new Response(res.body, res);
      patched.headers.set("Cache-Control", "no-cache, must-revalidate");
      return patched;
    }
  } catch (e) {
    // never let a header tweak break the site — fall through to the untouched response
    try { console.error("[gate] failed to set cache header", e && e.message); } catch (x) {}
  }
  return res;
}
