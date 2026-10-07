import { db } from '../../lib/db.mjs';
import { send, log, sameOriginJson, body, currentUser, rp, sha256, newToken } from '../../lib/http.mjs';

const INVITE_MS = 10 * 60 * 1000;

const clean = (v, max) => String(v ?? '').trim().slice(0, max);

const publicPasskey = (p) => ({
  id: p.id, label: p.label, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt,
  deviceType: p.deviceType, backedUp: p.backedUp, transports: p.transports ?? [],
});

export default async function handler(req, res) {
  try {
    // 모든 비공개 경로: 쿠키 세션이 없으면 자료를 주지 않고 401.
    // 주소(?user=...)나 본문에 적힌 다른 계정 ID는 읽지 않는다. 항상 세션의 주인 것만 돌려준다.
    const user = await currentUser(req);
    if (!user) {
      log('private_rejected', { reason: 'NO_SESSION' });
      return send(res, 401, { error: 'UNAUTHENTICATED' });
    }
    const action = req.query?.action ?? new URL(req.url, 'http://x').pathname.split('/').pop();

    if (action === 'items') {
      if (req.method === 'GET') return send(res, 200, { name: user.name, items: await db().listItems(user.id) });
      if (req.method === 'POST') {
        if (!sameOriginJson(req)) return send(res, 403, { error: 'BAD_ORIGIN' });
        const b = body(req);
        const title = clean(b.title, 60);
        if (!title) return send(res, 400, { error: 'TITLE_REQUIRED' });
        return send(res, 201, await db().addItem(user.id, title, clean(b.body, 500)));
      }
      return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    // 다른 기기(휴대폰 등)를 이 계정에 연결하는 일회용 링크. 10분 안에 한 번만 쓸 수 있다.
    if (action === 'invite') {
      if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
      if (!sameOriginJson(req)) return send(res, 403, { error: 'BAD_ORIGIN' });
      const token = newToken();
      await db().saveChallenge({
        challenge: 'invite:' + sha256(token), kind: 'register', userId: user.id,
        expiresAt: new Date(Date.now() + INVITE_MS).toISOString(),
      });
      log('invite_created');
      return send(res, 201, { url: `${rp(req).origin}/?link=${token}#vault`, expiresInSeconds: INVITE_MS / 1000 });
    }

    if (action === 'passkeys') {
      if (req.method === 'GET') {
        return send(res, 200, { passkeys: (await db().listPasskeys(user.id)).map(publicPasskey) });
      }
      if (req.method === 'DELETE') {
        if (req.headers['x-requested-with'] !== 'fetch') return send(res, 403, { error: 'BAD_ORIGIN' });
        const id = String(new URL(req.url, 'http://x').searchParams.get('id') ?? '');
        const mine = await db().listPasskeys(user.id);
        if (!mine.some((p) => p.id === id)) return send(res, 404, { error: 'NOT_FOUND' });
        // 마지막 하나는 지울 수 없다. 지우면 이 계정으로 다시 들어올 방법이 없어진다.
        if (mine.length <= 1) return send(res, 409, { error: 'LAST_PASSKEY' });
        await db().deletePasskey(user.id, id);
        log('passkey_deleted');
        return send(res, 200, { ok: true });
      }
      return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    }

    send(res, 404, { error: 'NOT_FOUND' });
  } catch (e) {
    log('server_error', { message: String(e.message).slice(0, 200) });
    send(res, 500, { error: 'SERVER_ERROR' });
  }
}
