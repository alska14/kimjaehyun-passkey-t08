-- T08 패스키 소개 페이지 저장소. Supabase SQL Editor에서 한 번 실행합니다.
-- 서버 함수만 서버 전용 키(service_role)로 읽고 씁니다. 브라우저는 이 테이블을 직접 부르지 않습니다.

create table if not exists app_users (
  id uuid primary key,
  name text not null check (char_length(name) between 1 and 30),
  created_at timestamptz not null default now()
);

create table if not exists passkeys (
  id text primary key,                          -- credential ID (base64url)
  user_id uuid not null references app_users(id) on delete cascade,
  public_key text not null,                     -- 공개키만 저장 (base64url). 개인키는 기기 밖으로 나오지 않음
  counter bigint not null default 0,
  transports text[],
  label text not null check (char_length(label) between 1 and 30),
  device_type text,                             -- singleDevice | multiDevice
  backed_up boolean not null default false,     -- 클라우드 동기화(구글 비밀번호 관리자·iCloud 등) 여부
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index if not exists passkeys_user_idx on passkeys(user_id);

-- 한 번만 쓰는 질문(challenge). 등록·로그인 요청마다 새로 만들고, 쓰면 used_at을 채웁니다.
create table if not exists challenges (
  challenge text primary key,
  kind text not null check (kind in ('register', 'login')),
  user_id uuid,                                 -- 기존 계정에 패스키를 추가할 때만 채움
  user_name text,                               -- 새 계정 등록 중에만 채움 (검증 전에는 계정을 만들지 않음)
  pending_user_id uuid,                         -- 새 계정 등록 때 미리 정해 둔 ID
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

-- 세션 토큰 원문은 저장하지 않고 해시만 저장합니다.
create table if not exists sessions (
  token_hash text primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists private_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  title text not null check (char_length(title) between 1 and 60),
  body text not null check (char_length(body) <= 500),
  created_at timestamptz not null default now()
);
create index if not exists private_items_user_idx on private_items(user_id);

-- 행 단위 보안을 켜고 공개 역할의 권한을 모두 회수합니다. 정책이 없으므로 service_role만 접근합니다.
alter table app_users enable row level security;
alter table passkeys enable row level security;
alter table challenges enable row level security;
alter table sessions enable row level security;
alter table private_items enable row level security;

revoke all on app_users, passkeys, challenges, sessions, private_items from public, anon, authenticated;
