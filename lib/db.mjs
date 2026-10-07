// 저장소. SUPABASE_URL + SUPABASE_SECRET_KEY가 있으면 Supabase, 없고 STORE=memory면 메모리(시험용).
import { createClient } from '@supabase/supabase-js';

const nowIso = () => new Date().toISOString();

function supabaseStore() {
  const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const ok = ({ data, error }) => {
    if (error) throw new Error(`DB_ERROR: ${error.message}`);
    return data;
  };
  return {
    async saveChallenge(c) {
      ok(await sb.from('challenges').insert({
        challenge: c.challenge, kind: c.kind, user_id: c.userId ?? null,
        user_name: c.userName ?? null, pending_user_id: c.pendingUserId ?? null,
        expires_at: c.expiresAt,
      }));
    },
    // 안 쓴 것·안 만료된 것만 한 번의 UPDATE로 사용 처리. 동시에 두 번 와도 한쪽만 성공.
    async consumeChallenge(challenge, kind) {
      const rows = ok(await sb.from('challenges')
        .update({ used_at: nowIso() })
        .eq('challenge', challenge).eq('kind', kind)
        .is('used_at', null).gt('expires_at', nowIso())
        .select());
      const r = rows[0];
      return r ? { userId: r.user_id, userName: r.user_name, pendingUserId: r.pending_user_id } : null;
    },
    async createUserWithPasskey(user, pk) {
      ok(await sb.from('app_users').insert({ id: user.id, name: user.name }));
      try {
        await this.addPasskey(pk);
      } catch (e) {
        await sb.from('app_users').delete().eq('id', user.id);
        throw e;
      }
    },
    async addPasskey(pk) {
      ok(await sb.from('passkeys').insert({
        id: pk.id, user_id: pk.userId, public_key: pk.publicKey, counter: pk.counter,
        transports: pk.transports ?? null, label: pk.label,
        device_type: pk.deviceType ?? null, backed_up: !!pk.backedUp,
      }));
    },
    async getPasskey(id) {
      const r = ok(await sb.from('passkeys').select('*').eq('id', id).maybeSingle());
      return r ? mapPasskey(r) : null;
    },
    async listPasskeys(userId) {
      const rows = ok(await sb.from('passkeys').select('*').eq('user_id', userId).order('created_at'));
      return rows.map(mapPasskey);
    },
    async touchPasskey(id, counter) {
      ok(await sb.from('passkeys').update({ counter, last_used_at: nowIso() }).eq('id', id));
    },
    // 소유자 조건을 SQL에 넣어 남의 패스키는 0건으로 처리
    async deletePasskey(userId, id) {
      const rows = ok(await sb.from('passkeys').delete().eq('id', id).eq('user_id', userId).select('id'));
      return rows.length === 1;
    },
    async getUser(id) {
      return ok(await sb.from('app_users').select('id,name').eq('id', id).maybeSingle());
    },
    async createSession(tokenHash, userId, expiresAt) {
      ok(await sb.from('sessions').insert({ token_hash: tokenHash, user_id: userId, expires_at: expiresAt }));
    },
    async getSession(tokenHash) {
      const r = ok(await sb.from('sessions').select('user_id').eq('token_hash', tokenHash)
        .gt('expires_at', nowIso()).maybeSingle());
      return r ? { userId: r.user_id } : null;
    },
    async deleteSession(tokenHash) {
      ok(await sb.from('sessions').delete().eq('token_hash', tokenHash));
    },
    async listItems(userId) {
      return ok(await sb.from('private_items').select('id,title,body,created_at')
        .eq('user_id', userId).order('created_at'));
    },
    async addItem(userId, title, body) {
      return ok(await sb.from('private_items').insert({ user_id: userId, title, body })
        .select('id,title,body,created_at').single());
    },
  };
}

function mapPasskey(r) {
  return {
    id: r.id, userId: r.user_id, publicKey: r.public_key, counter: Number(r.counter),
    transports: r.transports ?? undefined, label: r.label, deviceType: r.device_type,
    backedUp: r.backed_up, createdAt: r.created_at, lastUsedAt: r.last_used_at,
  };
}

function memoryStore() {
  const challenges = new Map();
  const users = new Map();
  const passkeys = new Map();
  const sessions = new Map();
  const items = [];
  let seq = 0;
  return {
    async saveChallenge(c) { challenges.set(c.challenge, { ...c, usedAt: null }); },
    async consumeChallenge(challenge, kind) {
      const c = challenges.get(challenge);
      if (!c || c.kind !== kind || c.usedAt || new Date(c.expiresAt) <= new Date()) return null;
      c.usedAt = nowIso();
      return { userId: c.userId ?? null, userName: c.userName ?? null, pendingUserId: c.pendingUserId ?? null };
    },
    async createUserWithPasskey(user, pk) { users.set(user.id, { ...user }); await this.addPasskey(pk); },
    async addPasskey(pk) {
      if (passkeys.has(pk.id)) throw new Error('DB_ERROR: duplicate passkey');
      passkeys.set(pk.id, { ...pk, createdAt: nowIso(), lastUsedAt: null, seq: seq++ });
    },
    async getPasskey(id) { return passkeys.get(id) ?? null; },
    async listPasskeys(userId) {
      return [...passkeys.values()].filter((p) => p.userId === userId).sort((a, b) => a.seq - b.seq);
    },
    async touchPasskey(id, counter) { Object.assign(passkeys.get(id), { counter, lastUsedAt: nowIso() }); },
    async deletePasskey(userId, id) {
      const p = passkeys.get(id);
      if (!p || p.userId !== userId) return false;
      passkeys.delete(id);
      return true;
    },
    async getUser(id) { return users.get(id) ?? null; },
    async createSession(h, userId, expiresAt) { sessions.set(h, { userId, expiresAt }); },
    async getSession(h) {
      const s = sessions.get(h);
      return s && new Date(s.expiresAt) > new Date() ? { userId: s.userId } : null;
    },
    async deleteSession(h) { sessions.delete(h); },
    async listItems(userId) { return items.filter((i) => i.user_id === userId); },
    async addItem(userId, title, body) {
      const row = { id: crypto.randomUUID(), user_id: userId, title, body, created_at: nowIso() };
      items.push(row);
      return row;
    },
  };
}

let store;
export function db() {
  if (!store) {
    if (process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY) store = supabaseStore();
    else if (process.env.STORE === 'memory') store = memoryStore();
    else throw new Error('CONFIG_MISSING: SUPABASE_URL / SUPABASE_SECRET_KEY');
  }
  return store;
}
