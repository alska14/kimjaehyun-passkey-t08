// 끝에서 끝까지 확인. 가상 인증기(Chrome DevTools WebAuthn)로 패스키 등록·로그인을 실제 서버에 보냅니다.
// 실행: BASE_URL=http://localhost:3111 node scripts/e2e.mjs
// 결과: evidence/e2e-result.json, evidence/*.png
// 주의: 가상 인증기는 실제 기기 패스키가 아닙니다. 실제 기기 등록 증거는 사람이 따로 남깁니다.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const BASE = (process.env.BASE_URL || 'http://localhost:3111').replace(/\/$/, '');
const ORIGIN = new URL(BASE).origin;
const SEED_TEXT = '준비 중인 프로젝트 메모';
const results = [];
const check = (id, desc, pass, detail = '') => {
  results.push({ id, desc, pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${id} ${desc}${detail ? ' — ' + detail : ''}`);
};

const post = (path, body, cookie) => fetch(BASE + path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(body),
});
const get = (path, cookie) => fetch(BASE + path, { headers: cookie ? { Cookie: cookie } : {} });
const b64u = (buf) => Buffer.from(buf).toString('base64url');

await mkdir('evidence', { recursive: true });
const browser = await chromium.launch();

async function newDevice(label) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const add = async () => (await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
  })).authenticatorId;
  const dev = { label, context, page, cdp, authId: await add(), add, log: { regChallenges: [], loginChallenges: [], loginVerifyBodies: [] } };
  page.on('response', async (r) => {
    try {
      if (r.url().endsWith('/api/auth/register-options')) dev.log.regChallenges.push((await r.json()).options.challenge);
      if (r.url().endsWith('/api/auth/login-options')) dev.log.loginChallenges.push((await r.json()).options.challenge);
    } catch {}
  });
  page.on('request', (r) => {
    if (r.url().endsWith('/api/auth/login-verify')) dev.log.loginVerifyBodies.push(r.postData());
  });
  return dev;
}

const cookieOf = async (dev) => {
  const c = (await dev.context.cookies()).find((x) => x.name === 'sid');
  return c ? `sid=${c.value}` : null;
};
const msg = (dev) => dev.page.locator('#vaultMsg').innerText();
const waitOpen = (dev) => dev.page.waitForSelector('#vaultOpen:not([hidden])', { timeout: 15000 });

async function register(dev, name, label) {
  await dev.page.fill('#vaultNameInput', name);
  await dev.page.fill('#vaultLabelInput', label);
  await dev.page.click('#vaultRegisterForm button[type=submit]');
  await waitOpen(dev);
}
async function login(dev) {
  await dev.page.click('#vaultLogin');
  await waitOpen(dev);
}
async function logout(dev) {
  await dev.page.click('#vaultLogout');
  await dev.page.waitForSelector('#vaultLocked:not([hidden])');
}

// ---------- 0. 로그인 없이 ----------
const home = await (await get('/')).text();
check('T08-C18', '로그인 안 한 상태로 받은 페이지 소스에 비공개 내용이 없음', !home.includes(SEED_TEXT));
const kept = ['서버를 직접 만들고,', '네 가지 성향으로 읽는 활동', '경험은 공개하고,', '현재의 작업과 관심', 'record-04'];
check('T08-C11', '1번 소개 페이지의 공개 내용이 그대로 남아 있음', kept.every((s) => home.includes(s)));
for (const p of ['/api/private/items', '/api/private/passkeys']) {
  const r = await get(p);
  check('T08-C16', `로그인 없이 ${p} 요청 거절`, r.status === 401, `HTTP ${r.status}`);
}
for (const [kind, hint, attach] of [['local', 'client-device', 'platform'], ['phone', 'hybrid', 'cross-platform'], ['key', 'security-key', 'cross-platform'], ['auto', undefined, undefined]]) {
  const o = (await (await post('/api/auth/register-options', { name: '옵션확인', kind })).json()).options;
  const ok = o.authenticatorSelection.authenticatorAttachment === attach && (hint ? o.hints.includes(hint) : o.hints.length === 0);
  check('extra-kind', `저장 위치 '${kind}' 선택이 등록 옵션에 반영됨`, ok, `attachment=${o.authenticatorSelection.authenticatorAttachment ?? '없음'} hints=${o.hints.join(',') || '없음'}`);
}
const asset = await (await get('/passkey.js')).text();
check('extra-js', '화면 코드(passkey.js)에도 비공개 내용 없음', !asset.includes(SEED_TEXT));

// ---------- 1. 계정 A: 등록 ----------
const A = await newDevice('A-노트북');
await A.page.goto(BASE);
await A.page.waitForTimeout(3000);
await A.page.screenshot({ path: 'evidence/01-locked-desktop.png' });
await A.page.locator('#vault').scrollIntoViewIfNeeded();
await A.page.screenshot({ path: 'evidence/02-vault-locked.png' });
await register(A, '테스트A', '가상 노트북');
await A.page.waitForSelector('#vaultItems li', { timeout: 15000 });
await A.page.waitForSelector('#vaultKeys li', { timeout: 15000 });
const itemsA = await A.page.locator('#vaultItems li').count();
check('T08-C14', '등록 직후 비공개 항목이 3개 이상 보임', itemsA >= 3, `${itemsA}개`);
check('T08-C21/C24', '등록한 패스키에 이름이 붙고 목록에 보임', (await A.page.locator('#vaultKeys li').first().innerText()).includes('가상 노트북'));
check('T08-C26', '패스키 저장 위치 표시가 목록에 있음', (await A.page.locator('#vaultKeys li').first().innerText()).includes('저장 위치'));
await A.page.screenshot({ path: 'evidence/03-vault-open-A.png' });
const cookieA1 = await cookieOf(A);
check('T08-C34', '세션 쿠키는 HttpOnly(스크립트로 못 읽음)', (await A.context.cookies()).find((c) => c.name === 'sid')?.httpOnly === true);
const apiItemsA = await (await get('/api/private/items', cookieA1)).json();
check('extra-api', '쿠키로 비공개 API 요청이 성공(200)', apiItemsA.items?.length >= 3);

// ---------- 2. 로그아웃 후 같은 값 재사용 ----------
await logout(A);
const r2 = await get('/api/private/items', cookieA1);
check('T08-C33', '로그아웃 뒤 같은 세션 값으로 다시 요청하면 거절', r2.status === 401, `HTTP ${r2.status}`);
check('T08-C15', '로그아웃하면 화면에서 비공개 내용이 사라짐', (await A.page.locator('#vaultItems li').count()) === 0);

// ---------- 3. 로그인 2회: 질문이 매번 다름, 재사용 거절 ----------
await login(A);
await logout(A);
await login(A);
check('T08-C27/C28', '로그인 요청마다 질문이 다름', A.log.loginChallenges.length >= 2 && new Set(A.log.loginChallenges).size === A.log.loginChallenges.length, `${A.log.loginChallenges.length}회, 모두 다름`);
check('T08-C20', '등록 요청 질문 값 기록 (이후 두 번째 등록과 비교)', A.log.regChallenges.length === 1);
const replay = await post('/api/auth/login-verify', JSON.parse(A.log.loginVerifyBodies[0]));
const replayJson = await replay.json();
check('T08-C31', '이미 쓴 질문으로 다시 로그인 시도하면 거절', replay.status === 400 && replayJson.error === 'CHALLENGE_INVALID', `HTTP ${replay.status} ${replayJson.error}`);

// ---------- 4. 위조 서명 ----------
const opt = await (await post('/api/auth/login-options', {})).json();
const credId = JSON.parse(A.log.loginVerifyBodies[0]).response.id;
const forgedClient = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: opt.options.challenge, origin: ORIGIN }));
const forged = await post('/api/auth/login-verify', {
  response: {
    id: credId, rawId: credId, type: 'public-key', clientExtensionResults: {},
    response: { clientDataJSON: b64u(forgedClient), authenticatorData: b64u(Buffer.alloc(37, 1)), signature: b64u(Buffer.alloc(64, 7)) },
  },
});
check('T08-C30', '서명이 틀린 로그인 요청은 거절', forged.status === 401, `HTTP ${forged.status}`);
check('T08-C29', '그 거절 응답에 세션 쿠키가 없음', !forged.headers.get('set-cookie'));

// ---------- 5. 두 번째 패스키 추가, 첫 번째 삭제 ----------
const credsBefore = (await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authId })).credentials;
await A.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: A.authId });
A.authId = await A.add();
await A.page.fill('#vaultAddLabel', '가상 휴대폰');
await A.page.click('#vaultAddKeyForm button[type=submit]');
await A.page.waitForFunction(() => document.querySelectorAll('#vaultKeys li').length === 2, null, { timeout: 15000 });
check('T08-C42', '한 계정에 패스키가 두 개 등록됨', true, '목록 2개');
const keyTexts = await A.page.locator('#vaultKeys li').allInnerTexts();
check('T08-C43', '목록에 이름과 등록 날짜 표시', keyTexts.every((t) => t.includes('등록')) && keyTexts.some((t) => t.includes('가상 휴대폰')));
await A.page.screenshot({ path: 'evidence/04-two-passkeys.png' });

const keysApi = await (await get('/api/private/passkeys', await cookieOf(A))).json();
const firstId = keysApi.passkeys[0].id;
const secondId = keysApi.passkeys[1].id;
A.page.once('dialog', (d) => d.accept());
await A.page.locator('#vaultKeys li').first().locator('button').click();
await A.page.waitForFunction(() => document.querySelectorAll('#vaultKeys li').length === 1);
check('T08-C44', '패스키 하나를 지운 뒤 목록에서 사라짐', true);

const last = await fetch(`${BASE}/api/private/passkeys?id=${encodeURIComponent(secondId)}`, {
  method: 'DELETE', headers: { Cookie: await cookieOf(A), 'X-Requested-With': 'fetch' },
});
check('T08-C46', '마지막 패스키는 못 지움(409). 하나도 안 남는 상태를 막음', last.status === 409, `HTTP ${last.status}`);

await logout(A);
await login(A);
check('T08-C44', '남은 두 번째 패스키로 로그인됨', await A.page.locator('#vaultOpen').isVisible());
await logout(A);

// 지운 첫 번째 패스키를 가진 기기로 로그인 시도 -> 거절
const credsSecond = (await A.cdp.send('WebAuthn.getCredentials', { authenticatorId: A.authId })).credentials;
await A.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: A.authId });
A.authId = await A.add();
for (const c of credsBefore) await A.cdp.send('WebAuthn.addCredential', { authenticatorId: A.authId, credential: c });
await A.page.click('#vaultLogin');
await A.page.waitForFunction(() => /실패|취소|쓸 수 없/.test(document.getElementById('vaultMsg').textContent), null, { timeout: 15000 });
check('T08-C45', '지운 패스키로는 더 이상 로그인할 수 없음', !(await A.page.locator('#vaultOpen').isVisible()), await msg(A));

// ---------- 6. 등록 취소 ----------
const C = await newDevice('취소-시험');
await C.page.goto(BASE);
await C.page.evaluate(() => {
  navigator.credentials.create = () => Promise.reject(Object.assign(new Error('x'), { name: 'NotAllowedError' }));
});
await C.page.fill('#vaultNameInput', '취소시험');
await C.page.click('#vaultRegisterForm button[type=submit]');
await C.page.waitForFunction(() => document.getElementById('vaultMsg').textContent.includes('취소'));
check('T08-C25', '등록 중 취소하면 안내가 나오고 로그인 상태가 되지 않음', !(await C.page.locator('#vaultOpen').isVisible()), await msg(C));
const cookieC = await cookieOf(C);
check('T08-C25', '취소한 뒤 세션 쿠키 없음', cookieC === null);

// ---------- 7. 계정 B: 분리 ----------
const B = await newDevice('B-휴대폰');
await B.page.goto(BASE);
await register(B, '테스트B', '가상 B 기기');
check('T08-C36', '두 번째 계정도 등록됨', true);
check('T08-C20', '등록 요청마다 질문 값이 서로 다름', A.log.regChallenges[0] !== B.log.regChallenges[0], '계정 A 등록 질문 ≠ 계정 B 등록 질문');
const cookieB = await cookieOf(B);
// B가 A의 패스키 ID를 알아도 지울 수 없음
const cross = await fetch(`${BASE}/api/private/passkeys?id=${encodeURIComponent(secondId)}`, {
  method: 'DELETE', headers: { Cookie: cookieB, 'X-Requested-With': 'fetch' },
});
check('T08-C37', 'B가 A의 패스키 삭제를 요청하면 거절(404)', cross.status === 404, `HTTP ${cross.status}`);
const own = await (await get('/api/private/items', cookieB)).json();
const spoof = await (await get(`/api/private/items?userId=00000000-0000-0000-0000-000000000000&user=테스트A`, cookieB)).json();
check('T08-C38', '주소에 다른 계정을 적어도 B 자료만 옴', spoof.name === '테스트B' && spoof.items.length === own.items.length, `B ${own.items.length}건, 위조 요청 ${spoof.items.length}건`);
const spoofBody = await fetch(`${BASE}/api/private/items`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN, Cookie: cookieB },
  body: JSON.stringify({ title: 'B가 쓴 메모', body: 'x', user_id: 'A', userId: 'A' }),
});
const afterB = await (await get('/api/private/items', cookieB)).json();
check('T08-C40', '본문에 다른 계정 ID를 적어 보내도 B 자료로만 저장', spoofBody.status === 201 && afterB.items.length === own.items.length + 1);
await A.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: A.authId });
A.authId = await A.add();
for (const c of credsSecond) await A.cdp.send('WebAuthn.addCredential', { authenticatorId: A.authId, credential: c });
await A.page.reload();
await login(A);
const aItems = await (await get('/api/private/items', await cookieOf(A))).json();
check('T08-C39', 'A 자료에 B가 쓴 메모가 섞이지 않음', !aItems.items.some((i) => i.title === 'B가 쓴 메모'), `A ${aItems.items.length}건`);
await B.page.screenshot({ path: 'evidence/05-account-B.png' });

// ---------- 8. 다른 오리진 거절 ----------
const evil = await fetch(`${BASE}/api/auth/login-options`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' }, body: '{}',
});
check('extra-origin', '다른 사이트에서 온 POST 요청 거절(403)', evil.status === 403, `HTTP ${evil.status}`);

// ---------- 9. 모바일 폭 화면 ----------
const M = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
const mp = await M.newPage();
await mp.goto(BASE);
await mp.waitForTimeout(3000);
await mp.locator('#vault').scrollIntoViewIfNeeded();
const overflow = await mp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
check('모바일', '390px 폭에서 가로 넘침 없음', !overflow);
await mp.screenshot({ path: 'evidence/06-mobile-locked.png' });

await browser.close();
const failed = results.filter((r) => !r.pass);
await writeFile('evidence/e2e-result.json', JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
