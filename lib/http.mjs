import { createHash, randomBytes } from 'node:crypto';
import { db } from './db.mjs';

export const SESSION_MS = 60 * 60 * 1000;
export const CHALLENGE_MS = 5 * 60 * 1000;
const COOKIE = 'sid';

export function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

export function log(event, detail = {}) {
  // 비밀값(토큰, 서명, 질문 원문)은 찍지 않는다.
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));
}

export function rp(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const local = /^(localhost|127\.0\.0\.1)(:|$)/.test(host);
  const proto = local ? 'http' : 'https';
  return {
    rpID: process.env.RP_ID || host.replace(/:\d+$/, ''),
    origin: process.env.ORIGIN || `${proto}://${host}`,
    secure: !local,
  };
}

// 상태를 바꾸는 요청은 같은 사이트에서 온 JSON만 받는다.
export function sameOriginJson(req) {
  if (req.headers.origin !== rp(req).origin) return false;
  return String(req.headers['content-type'] || '').startsWith('application/json');
}

export function sha256(s) {
  return createHash('sha256').update(s).digest('hex');
}

export function newToken() {
  return randomBytes(32).toString('base64url');
}

export function readCookie(req, name = COOKIE) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

export async function startSession(req, res, userId) {
  const token = newToken();
  await db().createSession(sha256(token), userId, new Date(Date.now() + SESSION_MS).toISOString());
  const { secure } = rp(req);
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
}

export function clearCookie(req, res) {
  const { secure } = rp(req);
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
}

// 쿠키의 세션만 믿는다. 주소·본문에 적힌 사용자 ID는 읽지 않는다.
export async function currentUser(req) {
  const token = readCookie(req);
  if (!token) return null;
  const s = await db().getSession(sha256(token));
  if (!s) return null;
  return db().getUser(s.userId);
}

export function body(req) {
  const b = req.body;
  if (b && typeof b === 'object') return b;
  try { return JSON.parse(b || '{}'); } catch { return {}; }
}

export function clientChallenge(response) {
  try {
    const json = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'));
    return typeof json.challenge === 'string' ? json.challenge : null;
  } catch {
    return null;
  }
}
