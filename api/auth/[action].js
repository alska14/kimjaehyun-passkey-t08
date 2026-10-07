import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { randomUUID } from 'node:crypto';
import { db } from '../../lib/db.mjs';
import {
  send, log, rp, sameOriginJson, body, currentUser, startSession, clearCookie,
  readCookie, sha256, clientChallenge, normalizeInvite, CHALLENGE_MS,
} from '../../lib/http.mjs';

const RP_NAME = '김재현 포트폴리오';

const SEED_ITEMS = [
  ['준비 중인 프로젝트 메모', '예시 메모: 포트폴리오에 넣을 작은 앱 아이디어 두 가지를 비교해 본다.'],
  ['지원하려는 곳 목록', '예시 목록: 관심 있는 팀 세 곳과 마감일을 적어 둔다. (가상 내용)'],
  ['스스로 쓰는 회고', '예시 회고: 이번 주에 막혔던 점과 해결한 방법을 한 줄씩 남긴다.'],
];

const KINDS = { local: 'localDevice', phone: 'remoteDevice', key: 'securityKey' };

const clean = (v, max) => String(v ?? '').trim().slice(0, max);
const expiry = () => new Date(Date.now() + CHALLENGE_MS).toISOString();

async function registerOptions(req, res) {
  const { rpID } = rp(req);
  const b = body(req);
  const label = clean(b.label, 30) || `패스키 ${new Date().toLocaleDateString('ko-KR')}`;
  let user = await currentUser(req);

  // 다른 기기에서 만든 연결 링크로 온 경우: 링크가 유효하면 그 계정에 패스키를 추가한다.
  // 링크는 여기서 소모하지 않고, 등록 검증이 끝날 때 한 번만 소모한다(중간에 취소해도 다시 시도 가능).
  let inviteKey = null;
  if (b.invite) {
    inviteKey = 'invite:' + sha256(normalizeInvite(b.invite));
    const inv = await db().peekChallenge(inviteKey, 'register');
    user = inv ? await db().getUser(inv.userId) : null;
    if (!user) return send(res, 400, { error: 'INVITE_INVALID' });
  }

  let userId, userName, existing = [];
  if (user) {
    // 이미 로그인한 계정(또는 연결 링크의 계정)에 패스키 추가
    userId = user.id; userName = user.name;
    existing = await db().listPasskeys(user.id);
  } else {
    userName = clean(b.name, 30);
    if (!userName) return send(res, 400, { error: 'NAME_REQUIRED' });
    userId = randomUUID();
  }

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName,
    userID: new TextEncoder().encode(userId),
    attestationType: 'none',
    excludeCredentials: existing.map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    // 저장 위치 선택: 이 기기(Windows Hello·지문·PIN) / 휴대폰(QR) / USB 보안 키. 없으면 브라우저가 고름.
    preferredAuthenticatorType: KINDS[b.kind],
  });

  // 휴대폰(QR)은 'cross-platform'으로 제한하면 Windows가 USB 보안 키 창만 띄운다. 힌트만 남긴다.
  if (b.kind === 'phone') delete options.authenticatorSelection.authenticatorAttachment;

  await db().saveChallenge({
    challenge: options.challenge, kind: 'register', expiresAt: expiry(),
    userId: user ? user.id : null,
    // 새 계정이면 표시 이름, 연결 링크면 링크 키를 담는다.
    userName: inviteKey || (user ? null : userName),
    // 새 계정이면 미리 정한 ID, 연결 링크면 계정 ID(= userId와 같으면 링크로 온 것으로 판단)
    pendingUserId: inviteKey ? user.id : user ? null : userId,
  });
  log('register_challenge_issued', { mode: inviteKey ? 'invite' : user ? 'add' : 'new' });
  send(res, 200, { options, label });
}

async function registerVerify(req, res) {
  const { rpID, origin } = rp(req);
  const b = body(req);
  const response = b.response;
  const challenge = response && clientChallenge(response);
  if (!challenge) return send(res, 400, { error: 'BAD_REQUEST' });

  // 질문을 먼저 '사용 처리'한다. 같은 질문으로 두 번째 시도는 여기서 막힌다.
  const row = await db().consumeChallenge(challenge, 'register');
  if (!row) {
    log('register_rejected', { reason: 'CHALLENGE_INVALID_OR_REUSED' });
    return send(res, 400, { error: 'CHALLENGE_INVALID' });
  }

  let info;
  try {
    const v = await verifyRegistrationResponse({
      response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false,
    });
    if (!v.verified) throw new Error('not verified');
    info = v.registrationInfo;
  } catch (e) {
    log('register_rejected', { reason: 'VERIFY_FAILED' });
    return send(res, 400, { error: 'VERIFY_FAILED' });
  }

  const label = clean(b.label, 30) || '내 패스키';
  const pk = {
    id: info.credential.id,
    publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
    counter: info.credential.counter,
    transports: response.response.transports ?? info.credential.transports,
    label, deviceType: info.credentialDeviceType, backedUp: info.credentialBackedUp,
  };

  if (row.userId && row.pendingUserId === row.userId) {
    // 연결 링크로 온 등록: 링크를 지금 한 번만 소모한다. 이미 쓴 링크면 거절.
    const used = await db().consumeChallenge(row.userName, 'register');
    if (!used) {
      log('register_rejected', { reason: 'INVITE_INVALID_OR_REUSED' });
      return send(res, 400, { error: 'INVITE_INVALID' });
    }
    const user = await db().getUser(row.userId);
    await db().addPasskey({ ...pk, userId: user.id });
    await startSession(req, res, user.id);
    log('passkey_added_by_invite', { deviceType: pk.deviceType, backedUp: pk.backedUp });
    return send(res, 200, { ok: true, added: true, name: user.name });
  }

  if (row.userId) {
    // 기존 계정에 추가: 지금도 그 계정으로 로그인한 상태여야 한다.
    const user = await currentUser(req);
    if (!user || user.id !== row.userId) return send(res, 401, { error: 'UNAUTHENTICATED' });
    await db().addPasskey({ ...pk, userId: user.id });
    log('passkey_added', { deviceType: pk.deviceType, backedUp: pk.backedUp });
    return send(res, 200, { ok: true, added: true });
  }

  // 새 계정: 검증이 끝난 지금에서야 계정과 패스키를 저장한다.
  const user = { id: row.pendingUserId, name: row.userName };
  await db().createUserWithPasskey(user, { ...pk, userId: user.id });
  for (const [title, text] of SEED_ITEMS) await db().addItem(user.id, title, text);
  await startSession(req, res, user.id);
  log('account_created', { deviceType: pk.deviceType, backedUp: pk.backedUp });
  send(res, 200, { ok: true, created: true, name: user.name });
}

async function loginOptions(req, res) {
  const { rpID } = rp(req);
  // 로그인 요청마다 새 질문. 계정 이름을 받지 않아 존재 여부도 알려 주지 않는다.
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'preferred' });
  await db().saveChallenge({ challenge: options.challenge, kind: 'login', expiresAt: expiry() });
  log('login_challenge_issued');
  send(res, 200, { options });
}

async function loginVerify(req, res) {
  const { rpID, origin } = rp(req);
  const response = body(req).response;
  const challenge = response && clientChallenge(response);
  if (!challenge || typeof response.id !== 'string') return send(res, 400, { error: 'BAD_REQUEST' });

  const row = await db().consumeChallenge(challenge, 'login');
  if (!row) {
    log('login_rejected', { reason: 'CHALLENGE_INVALID_OR_REUSED' });
    return send(res, 400, { error: 'CHALLENGE_INVALID' });
  }

  const pk = await db().getPasskey(response.id);
  if (!pk) {
    log('login_rejected', { reason: 'UNKNOWN_PASSKEY' });
    return send(res, 401, { error: 'LOGIN_FAILED' });
  }

  try {
    const v = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: pk.id,
        publicKey: new Uint8Array(Buffer.from(pk.publicKey, 'base64url')),
        counter: pk.counter,
        transports: pk.transports,
      },
    });
    if (!v.verified) throw new Error('not verified');
    await db().touchPasskey(pk.id, v.authenticationInfo.newCounter);
  } catch (e) {
    log('login_rejected', { reason: 'SIGNATURE_INVALID' });
    return send(res, 401, { error: 'LOGIN_FAILED' });
  }

  const user = await db().getUser(pk.userId);
  await startSession(req, res, user.id);
  log('login_ok');
  send(res, 200, { ok: true, name: user.name });
}

async function logout(req, res) {
  const token = readCookie(req);
  if (token) await db().deleteSession(sha256(token));
  clearCookie(req, res);
  log('logout');
  send(res, 200, { ok: true });
}

async function session(req, res) {
  const user = await currentUser(req);
  send(res, 200, user ? { authenticated: true, name: user.name } : { authenticated: false });
}

const routes = {
  'register-options': ['POST', registerOptions],
  'register-verify': ['POST', registerVerify],
  'login-options': ['POST', loginOptions],
  'login-verify': ['POST', loginVerify],
  logout: ['POST', logout],
  session: ['GET', session],
};

export default async function handler(req, res) {
  try {
    const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();
    const route = routes[action];
    if (!route) return send(res, 404, { error: 'NOT_FOUND' });
    const [method, fn] = route;
    if (req.method !== method) return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    if (method === 'POST' && !sameOriginJson(req)) return send(res, 403, { error: 'BAD_ORIGIN' });
    await fn(req, res);
  } catch (e) {
    log('server_error', { message: String(e.message).slice(0, 200) });
    send(res, 500, { error: 'SERVER_ERROR' });
  }
}
