/**
 * Vercel Routing Middleware: Google sign-in, @finanshels.com accounts only.
 *
 * Every request (page, CSVs, /api/window) needs a signed session cookie. Without
 * one, page visits go to Google sign-in and everything else gets a 401. The
 * Google callback accepts an account only when its email is verified, its
 * Workspace domain (`hd`) is finanshels.com and the address ends in
 * @finanshels.com. Missing configuration fails closed.
 *
 * Needs GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and SESSION_SECRET in Vercel.
 * The local dashboard_server.py does not run this file.
 */

export const config = { matcher: '/:path*', runtime: 'nodejs' };

export const ALLOWED_DOMAIN = 'finanshels.com';
const CANONICAL_ORIGIN = 'https://profitability-by-project.vercel.app';
const CALLBACK_PATH = '/api/auth/callback';
const SESSION_COOKIE = '__Host-session';
const STATE_COOKIE = '__Host-oauth-state';
const SESSION_SECONDS = 12 * 60 * 60;
const STATE_SECONDS = 10 * 60;
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

const encoder = new TextEncoder();

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

function fromB64url(text) {
  return Buffer.from(text, 'base64url');
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Signed `payload.signature` token; the signature covers the payload text. */
export async function signSession(email, secret, now = Date.now()) {
  const payload = b64url(encoder.encode(JSON.stringify({ e: email, x: Math.floor(now / 1000) + SESSION_SECONDS })));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${b64url(new Uint8Array(signature))}`;
}

/** Email from a valid, unexpired session token for the allowed domain, else null. */
export async function verifySession(token, secret, now = Date.now()) {
  if (!token || !secret || typeof token !== 'string') return null;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  let valid = false;
  try {
    // crypto.subtle.verify compares in constant time.
    valid = await crypto.subtle.verify('HMAC', await hmacKey(secret), fromB64url(signature), encoder.encode(payload));
  } catch {
    return null;
  }
  if (!valid) return null;
  try {
    const { e: email, x: expires } = JSON.parse(fromB64url(payload).toString('utf8'));
    if (typeof email !== 'string' || typeof expires !== 'number') return null;
    if (expires <= Math.floor(now / 1000)) return null;
    return isAllowedEmail(email) ? email : null;
  } catch {
    return null;
  }
}

export function isAllowedEmail(email) {
  return typeof email === 'string' && email.toLowerCase().endsWith(`@${ALLOWED_DOMAIN}`);
}

/**
 * Check the ID token Google returned from the token endpoint. It came straight
 * from Google over TLS in exchange for our client secret, so its signature does
 * not need re-verifying; the claims still decide who gets in.
 */
export function checkGoogleClaims(claims, clientId, now = Date.now()) {
  if (!claims || typeof claims !== 'object') return { ok: false, reason: 'Google did not return an identity.' };
  if (!GOOGLE_ISSUERS.has(claims.iss)) return { ok: false, reason: 'The sign-in did not come from Google.' };
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId)) return { ok: false, reason: 'The sign-in was issued for a different app.' };
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(now / 1000)) return { ok: false, reason: 'The sign-in expired. Try again.' };
  if (claims.email_verified !== true && claims.email_verified !== 'true') return { ok: false, reason: 'Your Google email address is not verified.' };
  if (claims.hd !== ALLOWED_DOMAIN || !isAllowedEmail(claims.email)) {
    return { ok: false, reason: `Only @${ALLOWED_DOMAIN} Google accounts can open this dashboard.`, email: claims.email || '' };
  }
  return { ok: true, email: claims.email.toLowerCase() };
}

function decodeJwtPayload(token) {
  const part = typeof token === 'string' ? token.split('.')[1] : '';
  return part ? JSON.parse(fromB64url(part).toString('utf8')) : null;
}

function readCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const piece of header.split(';')) {
    const index = piece.indexOf('=');
    if (index > -1 && piece.slice(0, index).trim() === name) return decodeURIComponent(piece.slice(index + 1).trim());
  }
  return '';
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/** Only same-site relative paths, so `next` cannot bounce anyone off-site. */
function safeNext(value) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value : '/';
}

function redirect(location, cookies = []) {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' });
  cookies.forEach((value) => headers.append('Set-Cookie', value));
  return new Response(null, { status: 302, headers });
}

function page(status, title, message, cookies = []) {
  const escape = (text) => String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const headers = new Headers({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  cookies.forEach((value) => headers.append('Set-Cookie', value));
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#f3f5f7;color:#242932;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#fff;border:1px solid #e1e6ec;border-radius:12px;padding:32px 36px;max-width:420px;box-shadow:0 4px 12px rgba(36,41,50,.06)}
h1{font-size:20px;margin:0 0 10px}p{color:#5d6571;line-height:1.5}a{display:inline-block;margin-top:8px;background:#f58217;color:#fff;text-decoration:none;padding:9px 16px;border-radius:8px;font-weight:600}</style></head>
<body><main><h1>${escape(title)}</h1><p>${escape(message)}</p><a href="/api/auth/login?prompt=select_account">Sign in with a Finanshels Google account</a></main></body></html>`;
  return new Response(body, { status, headers });
}

async function startLogin(request, env, url) {
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  const next = safeNext(url.searchParams.get('next') || '/');
  const google = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  google.search = new URLSearchParams({
    client_id: env.clientId,
    redirect_uri: `${CANONICAL_ORIGIN}${CALLBACK_PATH}`,
    response_type: 'code',
    scope: 'openid email',
    hd: ALLOWED_DOMAIN, // a hint for Google's account picker; the callback enforces it
    state,
    prompt: 'select_account', // lets people with several Google accounts pick the work one
  }).toString();
  return redirect(google.toString(), [cookie(STATE_COOKIE, `${state}|${next}`, STATE_SECONDS)]);
}

async function finishLogin(request, env, url, fetchImpl) {
  const clearState = cookie(STATE_COOKIE, '', 0);
  const [expectedState, next] = readCookie(request, STATE_COOKIE).split('|');
  if (url.searchParams.get('error')) return page(403, 'Sign-in cancelled', 'Google did not complete the sign-in.', [clearState]);
  if (!expectedState || url.searchParams.get('state') !== expectedState) {
    return page(400, 'Sign-in expired', 'That sign-in link is no longer valid. Start again.', [clearState]);
  }
  const code = url.searchParams.get('code');
  if (!code) return page(400, 'Sign-in failed', 'Google did not return a sign-in code.', [clearState]);

  const response = await fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.clientId,
      client_secret: env.clientSecret,
      redirect_uri: `${CANONICAL_ORIGIN}${CALLBACK_PATH}`,
      grant_type: 'authorization_code',
    }).toString(),
  });
  if (!response.ok) return page(502, 'Sign-in failed', 'Google rejected the sign-in. Try again.', [clearState]);
  let claims = null;
  try {
    claims = decodeJwtPayload((await response.json()).id_token);
  } catch {
    claims = null;
  }
  const result = checkGoogleClaims(claims, env.clientId);
  if (!result.ok) {
    const who = result.email ? ` You signed in as ${result.email}.` : '';
    return page(403, 'Access restricted', `${result.reason}${who}`, [clearState]);
  }
  const session = await signSession(result.email, env.sessionSecret);
  return redirect(safeNext(next), [clearState, cookie(SESSION_COOKIE, session, SESSION_SECONDS)]);
}

export async function handle(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (!env.clientId || !env.clientSecret || !env.sessionSecret) {
    return page(503, 'Sign-in not configured', 'This dashboard is missing its Google sign-in settings, so it is closed.');
  }
  // Google only knows one callback address, so sign-in happens on one host.
  if (url.origin !== CANONICAL_ORIGIN) return redirect(`${CANONICAL_ORIGIN}${url.pathname}${url.search}`);

  if (url.pathname === '/api/auth/login') return startLogin(request, env, url);
  if (url.pathname === CALLBACK_PATH) return finishLogin(request, env, url, fetchImpl);
  if (url.pathname === '/api/auth/logout') {
    return page(200, 'Signed out', 'You have signed out of the profitability dashboard.', [cookie(SESSION_COOKIE, '', 0)]);
  }

  const email = await verifySession(readCookie(request, SESSION_COOKIE), env.sessionSecret);
  if (url.pathname === '/api/auth/me') {
    return new Response(JSON.stringify(email ? { email } : { email: null }), {
      status: email ? 200 : 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
  if (email) return undefined; // Signed in: let the request through.

  const wantsPage = request.method === 'GET' && (request.headers.get('accept') || '').includes('text/html');
  if (wantsPage) return redirect(`/api/auth/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  return new Response(JSON.stringify({ ok: false, error: 'Sign in with a Finanshels Google account.' }), {
    status: 401, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

export default function middleware(request) {
  return handle(request, {
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    sessionSecret: process.env.SESSION_SECRET,
  });
}
