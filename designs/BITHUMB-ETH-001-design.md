# BITHUMB-ETH-001 설계 문서
## 빗썸 이더리움 가격 추적 시스템

**작성일**: 2026-04-13  
**태스크 ID**: BITHUMB-ETH-001  
**설계자**: Architect 🏗️

---

## 1. 개요

### 기능 설명
빗썸 공개 REST API를 통해 ETH/KRW 현재가를 주기적으로 조회하고,  
브라우저 프론트엔드에서 실시간으로 표시하는 시스템.

### 범위
- 빗썸 `GET /public/ticker/ETH_KRW` 폴링 (1분 주기)
- Server-Sent Events(SSE)로 프론트엔드에 가격 푸시
- 단일 페이지 UI에서 현재가, 등락률, 고/저가 표시

### 제약 조건
- **인증 불필요**: 빗썸 공개 API만 사용
- **AI 토큰 최소화**: npm 패키지 0개, 외부 프레임워크 없음
- **단순 배포**: `node server.js` 한 줄 실행

---

## 2. 기술 스택

| 레이어 | 기술 | 버전 | 선택 이유 |
|--------|------|------|-----------|
| 런타임 | Node.js | ≥18 LTS | 내장 `https`, `http` 모듈로 외부 의존성 0 |
| 백엔드 | Node.js stdlib (`http`, `https`) | 내장 | 프레임워크 없이 SSE + 정적 파일 서빙 가능 |
| 스케줄러 | `setInterval` | 내장 | cron 라이브러리 불필요 |
| 실시간 통신 | Server-Sent Events (SSE) | 브라우저 표준 | WebSocket 라이브러리 없이 단방향 푸시 구현 |
| 프론트엔드 | Vanilla HTML/CSS/JS | 없음 | 번들러, 프레임워크, npm 패키지 전부 불필요 |
| 패키지 관리 | 없음 (zero deps) | — | `package.json` 자체 불필요 |

**결론**: `node server.js` 실행 시 즉시 동작. `npm install` 없음.

---

## 3. 시스템 구조

```
┌─────────────────────────────────────────────────────────┐
│                     Browser (Client)                     │
│  index.html                                              │
│  ┌──────────────────────────────────────────────────┐   │
│  │  EventSource('/events')  ──────────────────────┐ │   │
│  │  DOM 업데이트 (현재가 / 등락률 / 고가 / 저가)   │ │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────┬───────────────────────────┘
                              │ SSE (HTTP/1.1 keep-alive)
                              │ GET /events
┌─────────────────────────────▼───────────────────────────┐
│                 Node.js HTTP Server (:3000)               │
│                                                          │
│  GET /          → index.html 정적 서빙                   │
│  GET /events    → SSE 스트림 (가격 push)                 │
│  GET /price     → 최신 가격 JSON (폴백용)                │
│                                                          │
│  ┌─────────────────────────────────────────────────┐    │
│  │  PricePoller (setInterval, 60초)                │    │
│  │  ┌───────────────────────────────────────────┐  │    │
│  │  │  https.get(api.bithumb.com/public/ticker/ │  │    │
│  │  │            ETH_KRW)                        │  │    │
│  │  └───────────────────────────────────────────┘  │    │
│  │  → latestPrice 메모리 캐시 업데이트              │    │
│  │  → 등록된 SSE 클라이언트 전체에 broadcast       │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
                              │ HTTPS
                              ▼
            api.bithumb.com/public/ticker/ETH_KRW
```

---

## 4. API 엔드포인트 설계

### 4-1. 내부 서버 엔드포인트

#### `GET /`
- **설명**: 프론트엔드 HTML 파일 서빙
- **Response**: `text/html`, `public/index.html`

---

#### `GET /price`
- **설명**: 최신 캐시된 ETH 가격 즉시 반환 (SSE 폴백 / 초기 로드용)
- **Response**: `application/json`

```json
{
  "symbol": "ETH_KRW",
  "current_price": 3307000,
  "opening_price": 3320000,
  "min_price": 3305000,
  "max_price": 3323000,
  "fluctate_rate_24h": "1.63",
  "updated_at": "2026-04-13T15:07:11.977Z"
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `symbol` | string | 거래 페어 |
| `current_price` | number | 현재가 (KRW) |
| `opening_price` | number | 시가 |
| `min_price` | number | 저가 |
| `max_price` | number | 고가 |
| `fluctate_rate_24h` | string | 24시간 등락률 (%) |
| `updated_at` | string | 마지막 갱신 ISO 타임스탬프 |

**에러 응답** (캐시 미존재 시):
```json
{ "error": "price not yet available", "code": 503 }
```

---

#### `GET /events`
- **설명**: SSE 스트림. 가격 갱신 시 자동 push.
- **Response**: `text/event-stream`

SSE 이벤트 형식:
```
event: price
data: {"current_price":3307000,"fluctate_rate_24h":"1.63","updated_at":"2026-04-13T15:08:00.000Z"}

```

| 이벤트명 | 발생 시점 | 데이터 |
|----------|-----------|--------|
| `price` | 매 폴링 성공 시 (60초) | 가격 JSON |
| `error` | 빗썸 API 실패 시 | `{"message": "fetch failed"}` |

---

### 4-2. 빗썸 외부 API 호출

```
GET https://api.bithumb.com/public/ticker/ETH_KRW
```

- 인증: 없음
- 사용 필드: `data.closing_price`, `data.opening_price`, `data.min_price`, `data.max_price`, `data.fluctate_rate_24H`
- 성공 상태: `status === "0000"`

**실제 응답 예시** (2026-04-13 실측):
```json
{
  "status": "0000",
  "data": {
    "opening_price": "3320000",
    "closing_price": "3307000",
    "min_price": "3305000",
    "max_price": "3323000",
    "fluctate_rate_24H": "1.63",
    "date": "1776092831967"
  }
}
```

---

## 5. 주기적 갱신 메커니즘

```
서버 시작
    │
    ├─► 즉시 1회 빗썸 API 호출 → latestPrice 초기화
    │
    └─► setInterval(fetchPrice, 60_000)
            │
            ├─► https.get(BITHUMB_URL)
            │       │ 성공
            │       ├─► JSON 파싱 → latestPrice 업데이트
            │       └─► sseClients 전체에 'price' 이벤트 broadcast
            │       │ 실패 (네트워크 오류 / status !== "0000")
            │       └─► console.error 기록
            │           sseClients 전체에 'error' 이벤트 broadcast
            │           latestPrice 유지 (이전 값 보존)
            │
        (60초 후 반복)
```

**설계 결정사항**:
- `setInterval` 선택 이유: cron 라이브러리 불필요, 단순 60초 주기에 충분
- API 실패 시 `latestPrice`를 초기화하지 않음 → 프론트엔드가 마지막 유효 가격 유지
- SSE 클라이언트는 `Map<id, res>`으로 관리
- 클라이언트 연결 해제 시 `close` 이벤트로 Map에서 자동 제거
- SSE heartbeat: 30초마다 `: ping\n\n` 전송 → 프록시 타임아웃 방지

---

## 6. 디렉토리 구조

```
bithumb-eth-tracker/
├── server.js          # 백엔드 전체 (HTTP 서버 + 폴러 + SSE)
├── public/
│   └── index.html     # 프론트엔드 전체 (HTML + CSS + JS 인라인)
└── designs/
    └── BITHUMB-ETH-001-design.md  # 본 설계 문서
```

**총 파일 수**: 2개 (server.js, index.html)  
**npm 패키지**: 0개  
**빌드 도구**: 없음

---

## 7. 핵심 파일 목록 및 구현 책임

### `server.js`
```
역할: 백엔드 전체
- Node.js 내장 'http', 'https', 'fs', 'path' 모듈만 사용
- HTTP 라우팅:
    GET /        → fs.readFile('public/index.html') 서빙
    GET /price   → JSON.stringify(latestPrice) 반환
    GET /events  → SSE 헤더 설정 후 sseClients Map에 등록
- PricePoller:
    fetchPrice() → https.get → JSON 파싱 → latestPrice 갱신 → broadcast()
    setInterval(fetchPrice, 60_000)
    서버 시작 시 fetchPrice() 즉시 1회 호출
- broadcast(eventName, data):
    sseClients.forEach(res => res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`))
- heartbeat:
    setInterval(() => sseClients.forEach(res => res.write(': ping\n\n')), 30_000)
- 포트: process.env.PORT || 3000
```

### `public/index.html`
```
역할: 프론트엔드 전체 (단일 파일)
- <head>: 인라인 CSS (다크 테마, 가격 카드 레이아웃)
- <body>: 현재가, 등락률, 고가, 저가, 마지막 갱신 시각 표시 DOM
- <script> (인라인 Vanilla JS):
    1. fetch('/price') → 초기 렌더링
    2. new EventSource('/events')
       addEventListener('price', e => updateDOM(JSON.parse(e.data)))
       addEventListener('error', e => showConnectionError())
    3. updateDOM(): textContent 직접 갱신, 등락률 색상 조건부 적용
- 의존 라이브러리: 없음
```

---

## 8. 구현 가이드 (Coder용)

### 구현 순서
1. `public/` 디렉토리 생성
2. `server.js` 작성 순서:
   a. 상수 정의 (`BITHUMB_URL`, `PORT`, `POLL_INTERVAL`)
   b. `latestPrice` 변수 선언 (`null` 초기값)
   c. `sseClients` Map 생성
   d. `fetchPrice()` 함수 구현
   e. `broadcast()` 함수 구현
   f. `http.createServer()` 핸들러 구현
   g. 서버 시작, `fetchPrice()` 즉시 호출, `setInterval` 등록
3. `public/index.html` 작성

### 주의사항
- **CORS**: 빗썸 API를 브라우저에서 직접 호출 금지. 서버 사이드에서만 호출.
- **숫자 변환**: 빗썸 API는 가격 필드를 **문자열**로 반환 (`"3307000"`). `Number()` 변환 필수.
- **SSE 헤더**: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, `X-Accel-Buffering: no` (nginx 프록시 버퍼링 방지)
- **SSE 이벤트 종결자**: 각 이벤트는 반드시 `\n\n`으로 종료
- **`closing_price`가 현재가**: 빗썸 API에서 현재 체결가는 `closing_price` 필드

---

## 9. 완료 기준 (Definition of Done)

| # | 검증 항목 | 검증 방법 |
|---|-----------|-----------|
| 1 | `node server.js` 단일 명령으로 서버 시작 | 오류 없이 `Listening on :3000` 출력 |
| 2 | `/price` 엔드포인트 정상 응답 | `curl http://localhost:3000/price` → `current_price > 0` JSON 확인 |
| 3 | `/events` SSE 스트림 연결 및 이벤트 수신 | `curl -N http://localhost:3000/events` → 60초 이내 `event: price` 수신 |
| 4 | 브라우저 UI 현재가 표시 | `http://localhost:3000` 접속 후 ETH 현재가 숫자 렌더링 확인 |
| 5 | 60초 주기 자동 갱신 | 1분 대기 후 `updated_at` 타임스탬프 변경 확인 |
| 6 | npm 의존성 0개 | 프로젝트 루트에 `node_modules/` 없음 |
| 7 | API 장애 시 서버 지속 동작 | 네트워크 차단 후 서버 크래시 없이 이전 가격 유지 |
| 8 | SSE heartbeat 동작 | 30초마다 `: ping` 주석 전송 확인 |
