# 소개 페이지 + 패스키 (T08)

1번에서 만든 소개 페이지는 누구나 볼 수 있게 두고, 페이지 아래에 패스키로 잠그는 비공개 자리를 붙였습니다. 비밀번호는 없습니다.

- 공개: `/` 첫 화면은 소개 페이지. 로그인 없이 열림.
- 비공개: 패스키로 로그인해야 메모와 패스키 관리 화면이 보임. 내용은 로그인 뒤 서버에서만 내려옴.
- 설명서: [docs/인증-구현-설명서.md](docs/인증-구현-설명서.md)
- 제출 전 할 일: [docs/제출-체크.md](docs/제출-체크.md)

## 로컬 실행

```bash
npm install
STORE=memory PORT=3111 node server.mjs      # 메모리 저장소(키 불필요, 끄면 데이터 사라짐)
BASE_URL=http://localhost:3111 node scripts/e2e.mjs
```

Supabase를 쓰려면 `SUPABASE_URL`, `SUPABASE_SECRET_KEY` 환경변수를 설정하고 `db/schema.sql`을 먼저 실행합니다. 키는 저장소에 넣지 않습니다.

## 구조

- `public/` 정적 페이지와 `passkey.js`
- `api/auth/[action].js` 등록·로그인·로그아웃
- `api/private/[action].js` 로그인한 사람의 메모·패스키
- `lib/` 저장소와 세션 보조 코드
- `db/schema.sql` 테이블과 권한
- `scripts/e2e.mjs` 가상 인증기로 하는 끝단 확인
