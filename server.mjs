// 로컬 확인용 서버. 배포(Vercel)에서는 쓰지 않고 public/과 api/를 그대로 올린다.
// 실행: STORE=memory node server.mjs  (Supabase 키가 있으면 그 DB를 씀)
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import auth from './api/auth/[action].js';
import priv from './api/private/[action].js';

const root = fileURLToPath(new URL('./public/', import.meta.url));
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };

export function createServer() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const m = url.pathname.match(/^\/api\/(auth|private)\/([\w-]+)$/);
    if (m) {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      try { req.body = raw ? JSON.parse(raw) : undefined; } catch { req.body = undefined; }
      req.query = { action: m[2] };
      return (m[1] === 'auth' ? auth : priv)(req, res);
    }
    const rel = url.pathname === '/' ? 'index.html' : normalize(url.pathname).replace(/^([/\\])+/, '');
    try {
      const data = await readFile(join(root, rel));
      res.setHeader('Content-Type', types[extname(rel)] || 'application/octet-stream');
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, () => console.log(`http://localhost:${port}`));
}
