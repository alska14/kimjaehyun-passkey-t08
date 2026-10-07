// 패스키 등록·로그인 화면 코드. 비공개 내용은 이 파일에도 HTML에도 없고, 로그인 뒤 서버에서 받아 옵니다.
(() => {
  const $ = (id) => document.getElementById(id);
  const box = $('vaultBox');
  if (!box) return;

  const b64uToBuf = (s) => {
    const pad = '='.repeat((4 - (s.length % 4)) % 4);
    const bin = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer;
  };
  const bufToB64u = (buf) => {
    let s = '';
    new Uint8Array(buf).forEach((b) => (s += String.fromCharCode(b)));
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  };

  async function api(path, { method = 'GET', data, headers = {} } = {}) {
    const res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: { ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: data ? JSON.stringify(data) : undefined,
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, ok: res.ok, json };
  }

  function say(text, kind = 'info') {
    const el = $('vaultMsg');
    el.textContent = text;
    el.dataset.kind = kind;
  }

  function setBusy(busy) {
    box.querySelectorAll('button').forEach((b) => (b.disabled = busy));
  }

  async function run(fn) {
    setBusy(true);
    try { return await fn(); } finally { setBusy(false); }
  }

  // 패스키 이름은 묻지 않고 기기에서 자동으로 붙인다. 예: "Windows · Chrome"
  function deviceLabel() {
    const ua = navigator.userAgent;
    const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android'
      : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '기기';
    const browser = /Whale/.test(ua) ? 'Whale' : /Edg\//.test(ua) ? 'Edge' : /CriOS|Chrome/.test(ua) ? 'Chrome'
      : /FxiOS|Firefox/.test(ua) ? 'Firefox' : /Safari/.test(ua) ? 'Safari' : '브라우저';
    return `${os} · ${browser}`;
  }

  const ERRORS = {
    NAME_REQUIRED: '이름을 입력해 주세요.',
    CHALLENGE_INVALID: '확인 시간이 지났거나 이미 쓴 요청입니다. 처음부터 다시 눌러 주세요.',
    INVITE_INVALID: '연결 링크가 만료되었거나 이미 사용되었습니다. 로그인한 기기에서 새 링크를 만들어 주세요.',
    VERIFY_FAILED: '패스키를 확인하지 못했습니다. 다시 시도해 주세요.',
    LOGIN_FAILED: '로그인에 실패했습니다. 고른 패스키가 이 사이트에 등록된 것이 아닐 수 있습니다(지워진 계정의 예전 패스키 등). 다른 패스키를 고르거나, 처음이면 "계정 만들기"를, 다른 기기에서 쓰려면 연결 링크를 쓰세요.',
    LAST_PASSKEY: '마지막 패스키는 지울 수 없습니다. 먼저 다른 패스키를 추가해 주세요.',
    UNAUTHENTICATED: '로그인이 필요합니다.',
    SERVER_ERROR: '서버에 문제가 있습니다. 잠시 뒤 다시 시도해 주세요.',
  };
  const errText = (r) => ERRORS[r.json?.error] || `요청이 거절되었습니다 (${r.status}).`;

  function cancelled(e) {
    return e && (e.name === 'NotAllowedError' || e.name === 'AbortError');
  }

  // ----- 등록 -----
  function creationOptions(o) {
    return {
      ...o,
      challenge: b64uToBuf(o.challenge),
      user: { ...o.user, id: b64uToBuf(o.user.id) },
      excludeCredentials: (o.excludeCredentials || []).map((c) => ({ ...c, id: b64uToBuf(c.id) })),
    };
  }

  function serializeCreation(cred) {
    const r = cred.response;
    return {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64u(r.clientDataJSON),
        attestationObject: bufToB64u(r.attestationObject),
        transports: r.getTransports ? r.getTransports() : [],
      },
    };
  }

  async function register({ name, kind, invite }) {
    const label = deviceLabel();
    const start = await api('/api/auth/register-options', { method: 'POST', data: { name, label, kind, invite } });
    if (!start.ok) {
      if (start.json?.error === 'INVITE_INVALID') store.clear(); // 만료된 링크로 계속 같은 화면에 갇히지 않게
      return say(errText(start), 'error');
    }
    let cred;
    try {
      cred = await navigator.credentials.create({ publicKey: creationOptions(start.json.options) });
    } catch (e) {
      if (cancelled(e)) {
        return say('등록이 취소되었거나 이 기기에서 쓸 수 없는 저장 위치입니다. 서버에는 아무것도 저장되지 않았습니다. 창이 안 뜨면 "창이 안 뜨거나 오류가 나요"에서 저장할 곳을 바꿔 보세요.', 'info');
      }
      if (e && e.name === 'InvalidStateError') return say('이 기기의 패스키가 이미 이 계정에 등록되어 있습니다. 다른 기기에서 연결하세요.', 'error');
      return say('이 기기나 브라우저에서 패스키를 만들 수 없습니다.', 'error');
    }
    const done = await api('/api/auth/register-verify', {
      method: 'POST',
      data: { response: serializeCreation(cred), label: start.json.label },
    });
    if (!done.ok) return say(errText(done), 'error');
    return true;
  }

  // ----- 로그인 -----
  function requestOptions(o) {
    return { ...o, challenge: b64uToBuf(o.challenge) };
  }

  function serializeAssertion(cred) {
    const r = cred.response;
    return {
      id: cred.id,
      rawId: bufToB64u(cred.rawId),
      type: cred.type,
      authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults(),
      response: {
        clientDataJSON: bufToB64u(r.clientDataJSON),
        authenticatorData: bufToB64u(r.authenticatorData),
        signature: bufToB64u(r.signature),
        userHandle: r.userHandle ? bufToB64u(r.userHandle) : undefined,
      },
    };
  }

  async function login() {
    const start = await api('/api/auth/login-options', { method: 'POST', data: {} });
    if (!start.ok) return say(errText(start), 'error');
    let cred;
    try {
      cred = await navigator.credentials.get({ publicKey: requestOptions(start.json.options) });
    } catch (e) {
      if (cancelled(e)) return say('로그인을 취소했습니다. 이 기기에 패스키가 없다면 "계정 만들기"를 하거나, 다른 기기에서 연결 링크를 받으세요.', 'info');
      return say('이 기기나 브라우저에서 패스키를 쓸 수 없습니다.', 'error');
    }
    const done = await api('/api/auth/login-verify', { method: 'POST', data: { response: serializeAssertion(cred) } });
    if (!done.ok) return say(errText(done), 'error');
    return true;
  }

  // ----- 화면 -----
  function el(tag, props = {}, ...kids) {
    const n = document.createElement(tag);
    Object.assign(n, props);
    kids.forEach((k) => n.append(k));
    return n;
  }

  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }) : '아직 없음');

  function where(p) {
    if (p.backedUp) return '동기화됨 · 구글/iCloud 계정에 백업되어 같은 계정의 다른 기기에서도 보입니다';
    if (p.deviceType === 'multiDevice') return '동기화 가능 · 아직 백업 전';
    return '이 기기에만 저장 · 다른 기기에서는 쓸 수 없습니다';
  }

  async function loadOpen() {
    const [items, keys] = await Promise.all([api('/api/private/items'), api('/api/private/passkeys')]);
    if (items.status === 401) return showLocked();
    $('vaultName').textContent = items.json.name;

    $('vaultItems').replaceChildren(...items.json.items.map((i) =>
      el('li', {}, el('strong', { textContent: i.title }), el('p', { textContent: i.body }))));

    const list = keys.json.passkeys;
    $('vaultKeyHint').hidden = list.length > 1;
    $('vaultKeys').replaceChildren(...list.map((p) => {
      const del = el('button', { type: 'button', className: 'vault-btn ghost', textContent: '삭제' });
      del.addEventListener('click', async () => {
        if (!confirm(`'${p.label}' 패스키를 지울까요? 이 패스키로는 더 이상 들어올 수 없습니다.`)) return;
        const r = await api(`/api/private/passkeys?id=${encodeURIComponent(p.id)}`, {
          method: 'DELETE', headers: { 'X-Requested-With': 'fetch' },
        });
        say(r.ok ? '패스키를 지웠습니다.' : errText(r), r.ok ? 'ok' : 'error');
        if (r.ok) loadOpen();
      });
      return el('li', {},
        el('strong', { textContent: p.label }),
        el('span', { className: 'meta', textContent: `등록 ${fmt(p.createdAt)} · 마지막 사용 ${fmt(p.lastUsedAt)}` }),
        el('span', { className: 'meta', textContent: where(p) }),
        del);
    }));
  }

  function panel(name) {
    box.dataset.state = name === 'open' ? 'open' : 'locked';
    $('vaultLocked').hidden = name !== 'locked';
    $('vaultInvite').hidden = name !== 'invite';
    $('vaultOpen').hidden = name !== 'open';
  }

  function showLocked() {
    panel('locked');
    $('vaultItems').replaceChildren();
    $('vaultKeys').replaceChildren();
    $('vaultInviteResult').hidden = true;
    $('vaultInviteUrl').value = '';
    $('vaultInviteCode').textContent = '';
  }

  async function showOpen() {
    panel('open');
    await loadOpen();
  }

  // ----- 이벤트 -----
  if (!window.PublicKeyCredential) {
    say('이 브라우저는 패스키를 지원하지 않습니다. 최신 Chrome·Safari·Edge·Firefox에서 열어 주세요.', 'error');
    setBusy(true);
    return;
  }

  $('vaultLogin').addEventListener('click', () => run(async () => {
    say('기기의 패스키 확인 창을 기다리는 중…');
    if (await login()) { say('로그인했습니다.', 'ok'); await showOpen(); }
  }));

  $('vaultRegisterForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('vaultNameInput').value.trim();
    run(async () => {
      say('기기의 패스키 만들기 창을 기다리는 중…');
      if (await register({ name, kind: $('vaultKindInput').value })) { say('계정과 패스키를 만들었습니다.', 'ok'); await showOpen(); }
    });
  });

  $('vaultCodeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = $('vaultCodeInput').value.trim();
    run(async () => {
      say('기기의 패스키 만들기 창을 기다리는 중…');
      if (await register({ invite: code })) { say('이 기기를 내 계정에 연결했습니다.', 'ok'); await showOpen(); }
    });
  });

  $('vaultInviteMake').addEventListener('click', () => run(async () => {
    const r = await api('/api/private/invite', { method: 'POST', data: {} });
    if (!r.ok) return say(errText(r), 'error');
    $('vaultInviteUrl').value = r.json.url;
    $('vaultInviteCode').textContent = r.json.code;
    $('vaultInviteResult').hidden = false;
    say('연결 링크를 만들었습니다. 연결할 기기에서 열어 주세요.', 'ok');
  }));

  $('vaultInviteCopy').addEventListener('click', async () => {
    const input = $('vaultInviteUrl');
    try { await navigator.clipboard.writeText(input.value); say('링크를 복사했습니다.', 'ok'); }
    catch { input.select(); say('링크를 선택했습니다. 직접 복사해 주세요.', 'info'); }
  });

  $('vaultItemForm').addEventListener('submit', (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api('/api/private/items', {
        method: 'POST', data: { title: $('vaultItemTitle').value, body: $('vaultItemBody').value },
      });
      if (!r.ok) return say(errText(r), 'error');
      $('vaultItemForm').reset();
      say('항목을 저장했습니다.', 'ok');
      await loadOpen();
    });
  });

  $('vaultLogout').addEventListener('click', () => run(async () => {
    await api('/api/auth/logout', { method: 'POST', data: {} });
    showLocked();
    say('로그아웃했습니다. 비공개 자리가 다시 잠겼습니다.', 'ok');
  }));

  // 연결 링크(#link=...)로 열린 경우: 주소창에서 토큰을 지우고 연결 안내를 보여 준다.
  // 새로고침해도 연결 화면이 유지되도록 토큰은 이 탭의 sessionStorage에만 잠깐 둔다.
  const store = {
    get() { try { return sessionStorage.getItem('t08-invite'); } catch { return null; } },
    set(v) { try { sessionStorage.setItem('t08-invite', v); } catch { /* 저장 못 해도 이번 화면은 동작 */ } },
    clear() { try { sessionStorage.removeItem('t08-invite'); } catch { /* 무시 */ } },
  };
  // 새 형식은 ?link=토큰 (카카오톡 등이 # 뒤를 잘라내는 일이 있어서). 예전 #link=토큰도 받는다.
  const fromUrl = new URLSearchParams(location.search).get('link')
    || (location.hash.match(/^#link=([\w-]+)$/) || [])[1];
  const validLink = fromUrl && /^[\w-]+$/.test(fromUrl) ? fromUrl : null;
  if (validLink) store.set(validLink);
  const invite = validLink || store.get();
  if (invite) {
    history.replaceState(null, '', location.pathname + '#vault');
    panel('invite');
    $('vaultInviteGo').addEventListener('click', () => run(async () => {
      say('기기의 패스키 만들기 창을 기다리는 중…');
      if (await register({ invite })) { store.clear(); say('이 기기를 내 계정에 연결했습니다.', 'ok'); await showOpen(); }
    }));
    document.getElementById('vault').scrollIntoView();
  } else {
    // 새로고침해도 세션이 남아 있으면 바로 열기 (세션 확인은 내용을 주지 않는 가벼운 요청)
    api('/api/auth/session').then((r) => { if (r.json.authenticated) showOpen(); });
  }
})();
