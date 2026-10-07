# 요청·응답 기록 (T08)

- 대상: https://kimjaehyun-passkey-t08.vercel.app
- 만든 시각: 2026-10-07T02:42:51.800Z
- 방법: 크롬 가상 인증기로 실제 서버에 같은 요청을 보냄. 세션 쿠키·서명·공개키 값은 앞부분만 적고 나머지는 가림.
- 시험용 계정 이름과 메모는 모두 만들어 넣은 값이고 실제 개인정보는 없음.

## A. 등록 요청 기록 (T08-C19~C23)

### A-1. 등록할 때 브라우저가 서버로 보낸 본문 (`POST /api/auth/register-verify`)

| 필드 | 값(앞부분만) | 설명 |
|---|---|---|
| `response.id` | `J51XpFglZXEbss1g…(43자)` | 패스키 식별자(credential ID). 비밀이 아님 |
| `response.response.clientDataJSON` | `eyJ0eXBlIjoid2Vi…(210자)` | 서버가 보낸 질문과 접속한 사이트 주소가 들어 있음 |
| `response.response.attestationObject` | `o2NmbXRkbm9uZWdh…(212자)` | **공개키**가 들어 있음 |
| `response.response.transports` | `["internal"]` | 연결 방식 |
| `label` | `Windows · Chrome` | 기기 이름(자동) |

본문의 모든 키: `["response","label"]` + `response` 안의 `["id","rawId","type","authenticatorAttachment","clientExtensionResults","response"]`, `response.response` 안의 `["clientDataJSON","attestationObject","transports"]`. **개인키(private key)나 비밀번호를 담는 필드는 없습니다.** 개인키는 기기 안에서 만들어져 밖으로 나오지 않습니다.

### A-2. 등록 요청마다 질문(challenge) 값이 다름 (`POST /api/auth/register-options` 응답)

| 요청 | challenge(앞부분) |
|---|---|
| 첫 번째 등록 | `6PYbC1RJyHze…(43자)` |
| 두 번째 등록 | `-S3XPCfltzc8…(43자)` |

### A-3. 서버(DB)에 저장된 값 (`passkeys` 테이블, 서버 전용 키로 직접 조회)

| 열 | 값(앞부분만) | 설명 |
|---|---|---|
| `id` | `J51XpFglZXEbss1g…(43자)` | credential ID |
| `public_key` | `pAEBAycgBiFYIDSam596…(56자)` | **공개키**. 이 값으로는 로그인할 수 없고, 서명이 맞는지 확인하는 데만 씀. 비밀번호가 아님 |
| `counter` | `1` | 사용 횟수 |
| `device_type` / `backed_up` | `singleDevice` / `false` | 저장 위치 종류 |
| (없음) | | 비밀번호 열·개인키 열 자체가 테이블에 없음 |

## B. 안 열리는 것을 확인한 기록 (성공한 요청과 거절된 요청)

### B-1. 로그인 없이 열기

| 구분 | 요청 | 응답 | 설명 |
|---|---|---|---|
| 성공 | `GET /api/private/items` | **200** | 쿠키 sid=<가림> 있음 → 내 메모 3건 |
| 거절 | `GET /api/private/items` | **401** | 쿠키 (없음) → `{"error":"UNAUTHENTICATED"}` |
| 거절 | `GET /api/private/passkeys` | **401** | 쿠키 없음 |

### B-2. 남의 패스키로 열기

| 구분 | 요청 | 응답 | 설명 |
|---|---|---|---|
| 성공 | `POST /api/auth/login-verify` | **200** | 내 패스키(`J51XpFglZX…(43자)`)의 진짜 서명 → 세션 쿠키 발급 |
| 거절 | `POST /api/auth/login-verify` | **401** | 같은 패스키 ID에 내 개인키가 아닌 임의 값으로 서명 → `{"error":"LOGIN_FAILED"}`, Set-Cookie 없음 |
| 거절 | `DELETE /api/private/passkeys?id=<A의 패스키>` | **404** | 계정 B의 세션으로 A의 패스키 삭제 시도 → `{"error":"NOT_FOUND"}` |
| 차단 | `GET /api/private/items?user=<A>` | **200** | B의 세션에 주소로 A를 적어도 돌아온 이름은 `증거65334b`(B), A의 메모는 오지 않음 |

### B-3. 이미 쓴 질문 재사용

| 구분 | 요청 | 응답 | 설명 |
|---|---|---|---|
| 성공 | `POST /api/auth/login-verify` | **200** | 새 질문 `wuvKaHPSFc…(43자)`에 서명한 첫 로그인 |
| 거절 | `POST /api/auth/login-verify` | **400** | 위와 **똑같은 본문**을 다시 전송 → `{"error":"CHALLENGE_INVALID"}` |

### B-4. 패스키 삭제 뒤 로그인

| 구분 | 요청 | 응답 | 설명 |
|---|---|---|---|
| 성공 | `GET /api/private/passkeys` | **200** | 삭제 전 패스키 2개: Windows · Chrome, Windows · Chrome |
| 성공 | `DELETE /api/private/passkeys?id=<첫 패스키>` | **200** | 패스키 하나 삭제(남은 것 1개) |
| 거절 | `POST /api/auth/login-verify` | **401** | 삭제한 패스키(`J51XpFglZX…(43자)`)를 가진 기기로 로그인 → `LOGIN_FAILED`. 화면: 로그인 실패 문구 |
| 성공 | `POST /api/auth/login-verify` | **200** | 남은 패스키(`ztxwBz2f-f…(43자)`)로 로그인 |

삭제한 패스키가 들어 있던 가상 인증기 수: 1개 (기기에는 남아 있지만 서버가 모르므로 거절됨)

