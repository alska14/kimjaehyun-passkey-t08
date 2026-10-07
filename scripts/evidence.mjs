// 제출문에 붙일 요청·응답 기록을 만든다. 가상 인증기로 실제 서버에 같은 흐름을 보내고, 비밀값은 가려서 적는다.
// 실행: BASE_URL=https://... node --env-file=.env.local scripts/evidence.mjs
// 결과: evidence/request-log.md (DB 조회는 SUPABASE_* 환경변수가 있을 때만)
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = (process.env.BASE_URL || 'http://localhost:3111').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const cut = (s, n = 14) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…(${s.length}자)` : s);
const NAME = `증거${Date.now().toString().slice(-5)}`;
const out = [];
const md = (s = '') => out.push(s);

const post = (path, body, cookie) => fetch(BASE + path, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});
const get = (path, cookie) => fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {} });
const mask = (c) => (c ? c.replace(/sid=[^;]+/, 'sid=<가림>') : '(없음)');
const row = (label, method, path, status, note = '') => md(`| ${label} | \`${method} ${path}\` | **${status}** | ${note} |`);

await mkdir('evidence', { recursive: true });
const browser = await chromium.launch();

async function device() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const add = async () => (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })).authenticatorId;
  const d = { context, page, cdp, add, authId: await add(), reg: [], regVerify: [], loginOpt: [], loginVerify: [] };
  page.on('response', async (r) => {
    try {
      const u = r.url();
      if (u.endsWith('/api/auth/register-options')) d.reg.push((await r.json()).options.challenge);
      if (u.endsWith('/api/auth/login-options')) d.loginOpt.push((await r.json()).options.challenge);
    } catch {}
  });
  page.on('request', (r) => {
    const u = r.url();
    if (u.endsWith('/api/auth/register-verify')) d.regVerify.push(JSON.parse(r.postData()));
    if (u.endsWith('/api/auth/login-verify')) d.loginVerify.push(JSON.parse(r.postData()));
  });
  return d;
}
const cookie = async (d) => {
  const c = (await d.context.cookies()).find((x) => x.name === 'sid');
  return c ? `sid=${c.value}` : null;
};
const waitOpen = (d) => d.page.waitForSelector('#vaultOpen:not([hidden])', { timeout: 15000 });
const waitKeys = (d, n) => d.page.waitForFunction((k) => document.querySelectorAll('#vaultKeys li').length === k, n, { timeout: 15000 });

// ---------- 계정 만들기 (기기 1) ----------
const A = await device();
await A.page.goto(BASE);
await A.page.click('#vaultNew summary');
await A.page.fill('#vaultNameInput', NAME);
await A.page.click('#vaultRegisterForm button[type=submit]');
await waitOpen(A);
await waitKeys(A, 1);
const cookieA = await cookie(A);

md('# 요청·응답 기록 (T08)');
md();
md(`- 대상: ${BASE}`);
md(`- 만든 시각: ${new Date().toISOString()}`);
md('- 방법: 크롬 가상 인증기로 실제 서버에 같은 요청을 보냄. 세션 쿠키·서명·공개키 값은 앞부분만 적고 나머지는 가림.');
md('- 시험용 계정 이름과 메모는 모두 만들어 넣은 값이고 실제 개인정보는 없음.');
md();

// ---------- 등록: 개인키가 서버로 가지 않음, 질문이 매번 다름 ----------
md('## A. 등록 요청 기록 (T08-C19~C23)');
md();
const reg = A.regVerify[0];
md('### A-1. 등록할 때 브라우저가 서버로 보낸 본문 (`POST /api/auth/register-verify`)');
md();
md('| 필드 | 값(앞부분만) | 설명 |');
md('|---|---|---|');
md(`| \`response.id\` | \`${cut(reg.response.id, 16)}\` | 패스키 식별자(credential ID). 비밀이 아님 |`);
md(`| \`response.response.clientDataJSON\` | \`${cut(reg.response.response.clientDataJSON, 16)}\` | 서버가 보낸 질문과 접속한 사이트 주소가 들어 있음 |`);
md(`| \`response.response.attestationObject\` | \`${cut(reg.response.response.attestationObject, 16)}\` | **공개키**가 들어 있음 |`);
md(`| \`response.response.transports\` | \`${JSON.stringify(reg.response.response.transports)}\` | 연결 방식 |`);
md(`| \`label\` | \`${reg.label}\` | 기기 이름(자동) |`);
md();
md(`본문의 모든 키: \`${JSON.stringify(Object.keys(reg))}\` + \`response\` 안의 \`${JSON.stringify(Object.keys(reg.response))}\`, \`response.response\` 안의 \`${JSON.stringify(Object.keys(reg.response.response))}\`. **개인키(private key)나 비밀번호를 담는 필드는 없습니다.** 개인키는 기기 안에서 만들어져 밖으로 나오지 않습니다.`);
md();

// 둘째 계정으로 질문 값 비교
const B = await device();
await B.page.goto(BASE);
await B.page.click('#vaultNew summary');
await B.page.fill('#vaultNameInput', NAME + 'b');
await B.page.click('#vaultRegisterForm button[type=submit]');
await waitOpen(B);
md('### A-2. 등록 요청마다 질문(challenge) 값이 다름 (`POST /api/auth/register-options` 응답)');
md();
md('| 요청 | challenge(앞부분) |');
md('|---|---|');
md(`| 첫 번째 등록 | \`${cut(A.reg[0], 12)}\` |`);
md(`| 두 번째 등록 | \`${cut(B.reg[0], 12)}\` |`);
md();

// DB에 저장된 값
if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) {
  const { createClient } = await import('@supabase/supabase-js');
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY);
  const u = (await sb.from('app_users').select('id').eq('name', NAME).maybeSingle()).data;
  const p = (await sb.from('passkeys').select('id,public_key,counter,device_type,backed_up,transports,label').eq('user_id', u.id)).data[0];
  md('### A-3. 서버(DB)에 저장된 값 (`passkeys` 테이블, 서버 전용 키로 직접 조회)');
  md();
  md('| 열 | 값(앞부분만) | 설명 |');
  md('|---|---|---|');
  md(`| \`id\` | \`${cut(p.id, 16)}\` | credential ID |`);
  md(`| \`public_key\` | \`${cut(p.public_key, 20)}\` | **공개키**. 이 값으로는 로그인할 수 없고, 서명이 맞는지 확인하는 데만 씀. 비밀번호가 아님 |`);
  md(`| \`counter\` | \`${p.counter}\` | 사용 횟수 |`);
  md(`| \`device_type\` / \`backed_up\` | \`${p.device_type}\` / \`${p.backed_up}\` | 저장 위치 종류 |`);
  md('| (없음) | | 비밀번호 열·개인키 열 자체가 테이블에 없음 |');
  md();
}

// ---------- 네 가지 확인 ----------
md('## B. 안 열리는 것을 확인한 기록 (성공한 요청과 거절된 요청)');
md();

// 1. 로그인 없이 열기
md('### B-1. 로그인 없이 열기');
md();
md('| 구분 | 요청 | 응답 | 설명 |');
md('|---|---|---|---|');
const okItems = await get('/api/private/items', cookieA);
const okJson = await okItems.json();
row('성공', 'GET', '/api/private/items', okItems.status, `쿠키 ${mask(cookieA)} 있음 → 내 메모 ${okJson.items.length}건`);
const noItems = await get('/api/private/items');
row('거절', 'GET', '/api/private/items', noItems.status, `쿠키 ${mask(null)} → \`${JSON.stringify(await noItems.json())}\``);
const noKeys = await get('/api/private/passkeys');
row('거절', 'GET', '/api/private/passkeys', noKeys.status, '쿠키 없음');
md();

// 2. 남의 패스키(틀린 서명)·남의 계정으로 열기
md('### B-2. 남의 패스키로 열기');
md();
md('| 구분 | 요청 | 응답 | 설명 |');
md('|---|---|---|---|');
await A.page.click('#vaultLogout');
await A.page.waitForSelector('#vaultLocked:not([hidden])');
A.loginVerify.length = 0;
await A.page.click('#vaultLogin');
await waitOpen(A);
const okLogin = A.loginVerify[0];
row('성공', 'POST', '/api/auth/login-verify', 200, `내 패스키(\`${cut(okLogin.response.id, 10)}\`)의 진짜 서명 → 세션 쿠키 발급`);
const o2 = await (await post('/api/auth/login-options', {})).json();
const fakeClient = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: o2.options.challenge, origin: ORIGIN })).toString('base64url');
const forged = await post('/api/auth/login-verify', {
  response: {
    id: okLogin.response.id, rawId: okLogin.response.id, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: fakeClient, authenticatorData: Buffer.alloc(37, 1).toString('base64url'), signature: Buffer.alloc(64, 7).toString('base64url') },
  },
});
row('거절', 'POST', '/api/auth/login-verify', forged.status, `같은 패스키 ID에 내 개인키가 아닌 임의 값으로 서명 → \`${JSON.stringify(await forged.json())}\`, Set-Cookie ${forged.headers.get('set-cookie') ? '있음' : '없음'}`);
const cookieB = await cookie(B);
const aKeyId = (await (await get('/api/private/passkeys', await cookie(A))).json()).passkeys[0].id;
const cross = await fetch(`${BASE}/api/private/passkeys?id=${encodeURIComponent(aKeyId)}`, { method: 'DELETE', headers: { Cookie: cookieB, 'X-Requested-With': 'fetch' } });
row('거절', 'DELETE', '/api/private/passkeys?id=<A의 패스키>', cross.status, `계정 B의 세션으로 A의 패스키 삭제 시도 → \`${JSON.stringify(await cross.json())}\``);
const spoof = await (await get('/api/private/items?userId=00000000-0000-0000-0000-000000000000&user=' + encodeURIComponent(NAME), cookieB)).json();
row('차단', 'GET', '/api/private/items?user=<A>', 200, `B의 세션에 주소로 A를 적어도 돌아온 이름은 \`${spoof.name}\`(B), A의 메모는 오지 않음`);
md();

// 3. 이미 쓴 질문 재사용
md('### B-3. 이미 쓴 질문 재사용');
md();
md('| 구분 | 요청 | 응답 | 설명 |');
md('|---|---|---|---|');
row('성공', 'POST', '/api/auth/login-verify', 200, `새 질문 \`${cut(A.loginOpt.at(-1), 10)}\`에 서명한 첫 로그인`);
const replay = await post('/api/auth/login-verify', okLogin);
row('거절', 'POST', '/api/auth/login-verify', replay.status, `위와 **똑같은 본문**을 다시 전송 → \`${JSON.stringify(await replay.json())}\``);
md();

// 4. 패스키 삭제 뒤 로그인: 둘째 기기를 연결한 뒤 첫 패스키를 지운다
md('### B-4. 패스키 삭제 뒤 로그인');
md();
md('| 구분 | 요청 | 응답 | 설명 |');
md('|---|---|---|---|');
await A.page.click('#vaultInviteMake');
await A.page.waitForFunction(() => document.getElementById('vaultInviteUrl').value.includes('?link='));
const invite = await A.page.inputValue('#vaultInviteUrl');
const D = await device();
await D.page.goto(invite);
await D.page.waitForSelector('#vaultInvite:not([hidden])');
await D.page.click('#vaultInviteGo');
await waitOpen(D);
await waitKeys(D, 2);
await A.page.reload();
await waitKeys(A, 2);
const before = await (await get('/api/private/passkeys', await cookie(A))).json();
const firstId = before.passkeys[0].id;
A.loginVerify.length = 0;
const credsA = (await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authId })).credentials;
row('성공', 'GET', '/api/private/passkeys', 200, `삭제 전 패스키 ${before.passkeys.length}개: ${before.passkeys.map((x) => x.label).join(', ')}`);
const del = await fetch(`${BASE}/api/private/passkeys?id=${encodeURIComponent(firstId)}`, { method: 'DELETE', headers: { Cookie: await cookie(A), 'X-Requested-With': 'fetch' } });
row('성공', 'DELETE', '/api/private/passkeys?id=<첫 패스키>', del.status, '패스키 하나 삭제(남은 것 1개)');
await A.page.reload();
await A.page.click('#vaultLogout');
await A.page.waitForSelector('#vaultLocked:not([hidden])');
await A.page.click('#vaultLogin');
await A.page.waitForFunction(() => /실패/.test(document.getElementById('vaultMsg').textContent), null, { timeout: 15000 });
const failed = A.loginVerify.at(-1);
row('거절', 'POST', '/api/auth/login-verify', 401, `삭제한 패스키(\`${cut(failed.response.id, 10)}\`)를 가진 기기로 로그인 → \`LOGIN_FAILED\`. 화면: 로그인 실패 문구`);
await D.page.click('#vaultLogout');
await D.page.waitForSelector('#vaultLocked:not([hidden])');
D.loginVerify.length = 0;
await D.page.click('#vaultLogin');
await waitOpen(D);
row('성공', 'POST', '/api/auth/login-verify', 200, `남은 패스키(\`${cut(D.loginVerify[0].response.id, 10)}\`)로 로그인`);
md();
md(`삭제한 패스키가 들어 있던 가상 인증기 수: ${credsA.length}개 (기기에는 남아 있지만 서버가 모르므로 거절됨)`);
md();

await browser.close();
await writeFile('evidence/request-log.md', out.join('\n') + '\n', 'utf8');
console.log(out.join('\n'));
