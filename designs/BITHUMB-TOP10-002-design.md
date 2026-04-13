# BITHUMB-TOP10-002 설계 문서
## 빗썸 거래량 상위 10개 코인 대시보드

**작성일**: 2026-04-13  
**태스크 ID**: BITHUMB-TOP10-002  
**설계자**: Architect 🏗️  
**선행 태스크**: BITHUMB-ETH-001 (기존 ETH 추적기 기반 확장)

---

## 1. 개요

### 기능 설명
빗썸 공개 REST API의 전체 시세 조회 엔드포인트(`/public/ticker/ALL_KRW`)를 통해  
24시간 거래대금(`acc_trade_value_24H`) 기준 상위 10개 코인을 60초 주기로 갱신하고  
대시보드 형식(테이블)의 별도 페이지(`top10.html`)에 표시한다.

### 범위
- 빗썸 `GET /public/ticker/ALL_KRW` 폴링 (60초 주기)
- 거래대금 내림차순 정렬 → 상위 10개 추출
- Server-Sent Events(SSE)로 프론트엔드에 푸시
- `top10.html` 신규 페이지 (ETH `index.html`과 완전히 분리)
- `server.js`에 신규 라우트 3개 추가 (기존 라우트 변경 없음)

### 제약 조건
- **기존 코드 변경 최소화**: `server.js`에 코드 추가만 허용, ETH 관련 로직 수정 금지
- **인증 불필요**: 빗썸 공개 API만 사용
- **zero deps 유지**: npm 패키지 추가 금지
- **독립 폴러**: ETH 폴러와 TOP10 폴러는 별개의 `setInterval` 인스턴스

---

## 2. 기술 스택

기존 BITHUMB-ETH-001과 동일한 스택 유지 (변경 없음)

| 레이어 | 기술 | 선택 이유 |
|--------|------|-----------|
| 런타임 | Node.js ≥18 LTS 내장 모듈 | zero deps 원칙 유지 |
| 실시간 통신 | Server-Sent Events (SSE) | 기존 ETH SSE 패턴 재사용 |
| 프론트엔드 | Vanilla HTML/CSS/JS | 번들러, 프레임워크 없음 |
| 외부 API | Bithumb Public API v1 | 인증 불필요 |

**추가 결정**: 별도 SSE 경로 `/top10/events`를 사용해 ETH SSE(`/events`)와 네임스페이스 분리.

---

## 3. 시스템 구조

```
┌─────────────────────────────────────────────────────────────┐
│                      Browser (Client)                        │
│                                                             │
│  top10.html                          index.html (기존)      │
│  ┌─────────────────────────────┐    ┌──────────────────┐   │
│  │ EventSource('/top10/events')│    │ EventSource       │   │
│  │ 테이블 DOM 갱신 (상위 10종) │    │ ('/events')       │   │
│  └────────────┬────────────────┘    └────────┬─────────┘   │
└───────────────┼─────────────────────────────┼─────────────┘
                │ SSE GET /top10/events        │ SSE GET /events
┌───────────────▼─────────────────────────────▼─────────────┐
│              Node.js HTTP Server (:3000)                    │
│                                                             │
│  [기존 라우트 - 변경 없음]                                   │
│  GET /           → public/index.html                        │
│  GET /price      → ETH 가격 JSON                            │
│  GET /events     → ETH SSE 스트림                           │
│                                                             │
│  [신규 라우트 - 추가]                                        │
│  GET /top10          → public/top10.html                    │
│  GET /top10/data     → 상위 10개 코인 JSON (폴백용)         │
│  GET /top10/events   → TOP10 SSE 스트림                     │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  Top10Poller (setInterval, 60초) [신규]              │  │
│  │  https.get(api.bithumb.com/public/ticker/ALL_KRW)    │  │
│  │  → 거래대금 내림차순 정렬 → 상위 10개 추출           │  │
│  │  → latestTop10 메모리 캐시 업데이트                  │  │
│  │  → top10SseClients 전체에 broadcast                  │  │
│  └──────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  EthPoller (기존, 변경 없음)                         │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                          │ HTTPS
                          ▼
        api.bithumb.com/public/ticker/ALL_KRW  ← 신규
        api.bithumb.com/public/ticker/ETH_KRW  ← 기존
```

---

## 4. Bithumb API 스펙 (TOP10 조회)

### 4-1. 외부 API 호출

```
GET https://api.bithumb.com/public/ticker/ALL_KRW
```

- **인증**: 없음
- **요청 헤더**: 없음 (공개 API)
- **응답 형식**: `application/json`

**응답 구조**:
```json
{
  "status": "0000",
  "data": {
    "BTC": {
      "opening_price": "140000000",
      "closing_price": "139500000",
      "min_price": "139000000",
      "max_price": "141000000",
      "acc_trade_volume_24H": "1234.5678",
      "acc_trade_value_24H": "172345678000",
      "fluctate_rate_24H": "-0.36",
      "date": "1776092831967"
    },
    "ETH": { ... },
    "XRP": { ... },
    ...
    "BTCUSDT": { ... },
    "date": "1776092831967"
  }
}
```

**핵심 필드**:

| 필드 | 타입 | 설명 |
|------|------|------|
| `closing_price` | string | 현재가 (KRW), 숫자 변환 필요 |
| `acc_trade_value_24H` | string | 24시간 거래대금 (KRW), **정렬 기준** |
| `acc_trade_volume_24H` | string | 24시간 거래량 (코인 수) |
| `fluctate_rate_24H` | string | 24시간 등락률 (%) |
| `opening_price` | string | 시가 (KRW) |

**주의사항**:
- `data` 객체 내 `"date"` 키는 **코인 심볼이 아닌 메타데이터**. 반드시 필터링 필요.
- `BTCUSDT` 등 USDT 페어가 포함될 수 있음. KRW 페어만 필요할 경우 심볼에 "USDT" 포함 여부로 필터링 가능 (PM 결정 필요 — 기본은 전체 포함).
- 모든 숫자 필드는 **문자열**로 반환됨 → `Number()` 또는 `parseFloat()` 변환 필수.
- `status !== "0000"` 시 에러 처리.

### 4-2. TOP10 추출 알고리즘

```
1. data 객체에서 "date" 키 제거
2. 각 심볼에 대해 acc_trade_value_24H → Number 변환
3. 내림차순 정렬
4. 상위 10개 추출
5. rank 1~10 부여
```

---

## 5. 내부 서버 엔드포인트 설계 (신규)

### `GET /top10`
- **설명**: TOP10 대시보드 HTML 파일 서빙
- **Response**: `text/html`, `public/top10.html`

---

### `GET /top10/data`
- **설명**: 최신 캐시된 상위 10개 코인 즉시 반환 (SSE 폴백 / 초기 로드용)
- **Response**: `application/json`

```json
{
  "updated_at": "2026-04-13T15:47:00.000Z",
  "coins": [
    {
      "rank": 1,
      "symbol": "BTC",
      "current_price": 139500000,
      "fluctate_rate_24h": "-0.36",
      "acc_trade_value_24h": 172345678000,
      "acc_trade_volume_24h": 1234.5678
    },
    {
      "rank": 2,
      "symbol": "ETH",
      "current_price": 3307000,
      "fluctate_rate_24h": "1.63",
      "acc_trade_value_24h": 98765432100,
      "acc_trade_volume_24h": 29876.1234
    }
    // ... 총 10개
  ]
}
```

| 필드 | 타입 | 설명 |
|------|------|------|
| `updated_at` | string | 마지막 갱신 ISO 타임스탬프 |
| `coins[].rank` | number | 거래대금 기준 순위 (1~10) |
| `coins[].symbol` | string | 코인 심볼 (예: "BTC") |
| `coins[].current_price` | number | 현재가 (KRW) |
| `coins[].fluctate_rate_24h` | string | 24시간 등락률 (%) |
| `coins[].acc_trade_value_24h` | number | 24시간 거래대금 (KRW) |
| `coins[].acc_trade_volume_24h` | number | 24시간 거래량 (코인 수) |

**에러 응답** (캐시 미존재 시):
```json
{ "error": "top10 data not yet available", "code": 503 }
```

---

### `GET /top10/events`
- **설명**: TOP10 전용 SSE 스트림. 갱신 시마다 push.
- **Response**: `text/event-stream`

SSE 이벤트 형식:
```
event: top10
data: {"updated_at":"2026-04-13T15:48:00.000Z","coins":[...]}

```

| 이벤트명 | 발생 시점 | 데이터 |
|----------|-----------|--------|
| `top10` | 매 폴링 성공 시 (60초) | 상위 10개 코인 JSON |
| `error` | 빗썸 API 실패 시 | `{"message": "fetch failed"}` |

**SSE 헤더** (기존 `/events`와 동일):
```
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

---

## 6. 데이터 모델

### 서버 메모리 상태 (신규 추가)

```javascript
// 기존 (변경 없음)
let latestPrice = null;           // ETH 가격 캐시
const sseClients = new Map();     // ETH SSE 클라이언트

// 신규 추가
let latestTop10 = null;           // TOP10 캐시
const top10SseClients = new Map(); // TOP10 SSE 클라이언트
```

### `latestTop10` 구조

```javascript
{
  updated_at: "2026-04-13T15:47:00.000Z",  // string (ISO 8601)
  coins: [
    {
      rank: 1,                        // number
      symbol: "BTC",                  // string
      current_price: 139500000,       // number (KRW)
      fluctate_rate_24h: "-0.36",     // string (%)
      acc_trade_value_24h: 172345678000, // number (KRW)
      acc_trade_volume_24h: 1234.5678    // number (코인 수)
    },
    // ... 총 10개
  ]
}
```

---

## 7. 주기적 갱신 메커니즘 (TOP10)

```
서버 시작
    │
    ├─► 즉시 1회 fetchTop10() 호출 → latestTop10 초기화
    │
    └─► setInterval(fetchTop10, 60_000)
            │
            ├─► https.get(BITHUMB_ALL_URL)
            │       │ 성공
            │       ├─► JSON 파싱
            │       ├─► "date" 키 제거
            │       ├─► acc_trade_value_24H 내림차순 정렬
            │       ├─► 상위 10개 추출 + rank 부여
            │       ├─► latestTop10 업데이트
            │       └─► top10SseClients 전체에 'top10' 이벤트 broadcast
            │       │ 실패 (네트워크 오류 / status !== "0000")
            │       └─► console.error 기록
            │           top10SseClients 전체에 'error' 이벤트 broadcast
            │           latestTop10 유지 (이전 값 보존)
            │
        (60초 후 반복)
```

**설계 결정**:
- ETH 폴러(`fetchPrice`)와 TOP10 폴러(`fetchTop10`)는 **독립 실행** — 한쪽 실패가 다른 쪽에 영향 없음
- 두 폴러 모두 서버 시작 시 즉시 1회 호출 (초기 캐시 확보)
- `latestTop10` 실패 시 이전 값 보존 (ETH와 동일 원칙)

---

## 8. 디렉토리 구조 (변경 후)

```
bithumb-eth-tracker/
├── server.js               # 기존 + TOP10 관련 코드 추가
├── public/
│   ├── index.html          # 기존 ETH 페이지 (변경 없음)
│   └── top10.html          # 신규 TOP10 대시보드
└── designs/
    ├── BITHUMB-ETH-001-design.md   # 기존
    └── BITHUMB-TOP10-002-design.md # 본 설계 문서
```

**변경 파일 목록**:
| 파일 | 변경 종류 | 변경 내용 |
|------|-----------|-----------|
| `server.js` | 수정 (추가) | TOP10 상수, 변수, 함수, 라우트 추가 |
| `public/top10.html` | 신규 | TOP10 대시보드 UI |
| `public/index.html` | 변경 없음 | — |

---

## 9. 구현 가이드 (Coder용)

### 9-1. `server.js` 확장 방법

기존 코드 구조를 유지하며, **파일 끝에 TOP10 블록을 추가**하는 방식으로 구현.

#### 추가할 상수
```javascript
// TOP10 상수
const BITHUMB_ALL_URL = 'https://api.bithumb.com/public/ticker/ALL_KRW';
const TOP10_POLL_INTERVAL = 60_000;
```

#### 추가할 변수
```javascript
let latestTop10 = null;
const top10SseClients = new Map();
let top10ClientIdCounter = 0;
```

#### 추가할 함수: `fetchTop10()`
```
역할: 빗썸 ALL_KRW 조회 → 상위 10개 추출 → latestTop10 갱신 → broadcast
흐름:
  1. https.get(BITHUMB_ALL_URL, ...)
  2. 응답 청크 수집 → JSON.parse
  3. status !== "0000" → throw Error
  4. const entries = Object.entries(data).filter(([k]) => k !== 'date')
  5. entries.sort((a, b) => Number(b[1].acc_trade_value_24H) - Number(a[1].acc_trade_value_24H))
  6. const top10 = entries.slice(0, 10).map(([symbol, d], i) => ({
       rank: i + 1,
       symbol,
       current_price: Number(d.closing_price),
       fluctate_rate_24h: d.fluctate_rate_24H,
       acc_trade_value_24h: Number(d.acc_trade_value_24H),
       acc_trade_volume_24h: Number(d.acc_trade_volume_24H),
     }))
  7. latestTop10 = { updated_at: new Date().toISOString(), coins: top10 }
  8. broadcastTop10('top10', latestTop10)
  에러 시: console.error → broadcastTop10('error', { message: ... }) → latestTop10 유지
```

#### 추가할 함수: `broadcastTop10(eventName, data)`
```javascript
// ETH broadcast()와 동일한 패턴, top10SseClients 대상
top10SseClients.forEach(res =>
  res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`)
);
```

#### HTTP 라우터 확장 (기존 if-else 체인에 추가)

```
라우터 분기 추가 위치: 기존 라우트 블록 뒤에 else if 추가

else if (pathname === '/top10') {
  // public/top10.html 서빙 (index.html 서빙과 동일 패턴)
}
else if (pathname === '/top10/data') {
  // latestTop10 null 체크 → 503 또는 200 JSON
}
else if (pathname === '/top10/events') {
  // SSE 헤더 설정
  // top10ClientIdCounter++ → id 부여
  // top10SseClients.set(id, res)
  // latestTop10 있으면 즉시 1회 전송
  // req.on('close', () => top10SseClients.delete(id))
}
```

#### 서버 시작 부분 추가
```javascript
// 기존 fetchPrice() 호출 아래에 추가
fetchTop10();
setInterval(fetchTop10, TOP10_POLL_INTERVAL);

// 기존 heartbeat 아래에 추가
setInterval(() => {
  top10SseClients.forEach(res => res.write(': ping\n\n'));
}, 30_000);
```

---

### 9-2. `public/top10.html` 설계

#### 레이아웃

```
┌────────────────────────────────────────────────────────────┐
│  🏆 빗썸 거래대금 TOP 10           [갱신: 15:48:00]        │
│  ──────────────────────────────────────────────────        │
│  순위  코인   현재가(KRW)    등락률    거래대금(억)  거래량  │
│  ────  ─────  ────────────  ───────   ──────────   ──────  │
│   1    BTC    139,500,000   -0.36%    1,723억      1,234   │
│   2    ETH      3,307,000   +1.63%      987억     29,876   │
│   3    ...                                                   │
│  ...                                                        │
│  10    ...                                                   │
│  ──────────────────────────────────────────────────        │
│  [ETH 상세 페이지로 →]                                      │
└────────────────────────────────────────────────────────────┘
```

#### HTML 구조
```html
<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8">
  <title>빗썸 TOP10 대시보드</title>
  <style>
    /* 다크 테마 (index.html과 유사한 스타일) */
    /* 테이블: 헤더 고정, 행 호버 강조 */
    /* 등락률: 양수 → green, 음수 → red */
    /* 거래대금: 억 단위 표시 (acc_trade_value_24h / 1e8).toFixed(0) */
  </style>
</head>
<body>
  <header>
    <h1>🏆 빗썸 거래대금 TOP 10</h1>
    <span id="updated-at">갱신 중...</span>
  </header>
  <table id="top10-table">
    <thead>
      <tr>
        <th>순위</th><th>코인</th><th>현재가(KRW)</th>
        <th>등락률</th><th>거래대금(억)</th><th>거래량</th>
      </tr>
    </thead>
    <tbody id="top10-body">
      <!-- JS로 동적 렌더링 -->
    </tbody>
  </table>
  <footer>
    <a href="/">ETH 상세 페이지</a>
  </footer>
  <script>
    // 1. fetch('/top10/data') → 초기 렌더링
    // 2. new EventSource('/top10/events')
    //    addEventListener('top10', e => renderTable(JSON.parse(e.data)))
    //    addEventListener('error', e => showError())
    // 3. renderTable(data):
    //    - tbody 초기화
    //    - data.coins.forEach → <tr> 생성
    //    - 등락률 부호에 따라 클래스 적용 (plus / minus)
    //    - updated_at → 한국 시간 포맷팅
    // 4. formatKRW(n): n.toLocaleString('ko-KR')
    // 5. formatVolume(n): n.toFixed(2)
    // 6. formatTradeValue(n): (n / 1e8).toFixed(0) + '억'
  </script>
</body>
</html>
```

#### 핵심 JS 로직 명세

| 함수명 | 역할 | 입력 | 출력 |
|--------|------|------|------|
| `renderTable(data)` | tbody에 10개 행 렌더링 | `latestTop10` 객체 | DOM 갱신 |
| `formatKRW(n)` | 한국 숫자 포맷 | `number` | `"139,500,000"` |
| `formatRate(s)` | 등락률 포맷 + 부호 | `string` | `"+1.63%"` 또는 `"-0.36%"` |
| `formatTradeValue(n)` | 거래대금 억 단위 | `number` | `"1,723억"` |
| `formatVolume(n)` | 거래량 소수 2자리 | `number` | `"1,234.57"` |
| `formatTime(iso)` | ISO → 한국시간 | `string` | `"15:48:00"` |

---

## 10. 통합 주의사항

### 10-1. 라우터 충돌 방지
- `/top10`과 `/top10/events`, `/top10/data`는 **경로 전방 일치(`startsWith`) 방식이 아닌 정확 일치**로 분기할 것.
- 기존 라우터가 `url.parse(req.url).pathname`을 사용한다면 동일하게 `pathname` 기준으로 분기.

### 10-2. 폴러 독립성
- `fetchTop10()`은 `fetchPrice()`와 **공유 상태 없음** — 별도 변수(`latestTop10`, `top10SseClients`) 사용.
- 에러 핸들러도 분리: 한쪽 API 장애가 다른 폴러에 전파되지 않도록 각자 `try/catch` 보유.

### 10-3. `ALL_KRW` 응답의 `"date"` 키
- `data` 객체의 최상위에 `"date"` 키가 있음 (코인 심볼이 아닌 타임스탬프 문자열).
- **반드시** `Object.entries(data).filter(([k]) => k !== 'date')`로 제거 후 정렬.
- 제거하지 않으면 `acc_trade_value_24H`가 없어 `NaN`이 되어 정렬 오류 발생.

### 10-4. 숫자 변환
- 빗썸 API 전 필드가 문자열로 반환됨.
- `Number()` 변환 후 `isNaN()` 체크 권장.
- `acc_trade_value_24H` 값이 매우 큰 수(억~조 단위)이므로 `Number`(64-bit float) 범위 내 정상 처리됨.

### 10-5. SSE 클라이언트 ID 관리
- TOP10 SSE는 기존 ETH SSE의 `clientIdCounter`와 **별개의 카운터** (`top10ClientIdCounter`) 사용.
- `Map` 키 충돌 방지: 두 Map은 독립적이므로 동일 카운터 값이 각각 존재해도 무방.

### 10-6. 정적 파일 서빙 경로
- `GET /top10` → `public/top10.html`
- 기존 `GET /` → `public/index.html` 패턴을 그대로 복사.
- `__dirname` 또는 `path.join()` 기준으로 파일 경로 구성.

### 10-7. 네비게이션 연결
- `top10.html`에 `<a href="/">ETH 상세</a>` 링크 추가.
- `index.html`에 `<a href="/top10">TOP 10 대시보드</a>` 링크 추가 (기존 파일 최소 수정).

---

## 11. 완료 기준 (Definition of Done)

| # | 검증 항목 | 검증 방법 |
|---|-----------|-----------|
| 1 | `node server.js` 단일 명령으로 서버 정상 시작 | 오류 없이 `Listening on :3000` 출력 |
| 2 | `/top10` 페이지 접속 | 브라우저에서 `http://localhost:3000/top10` → 테이블 렌더링 확인 |
| 3 | `/top10/data` JSON 정상 응답 | `curl http://localhost:3000/top10/data` → `coins` 배열 10개 항목 확인 |
| 4 | 상위 10개가 거래대금 내림차순인지 확인 | `coins[0].acc_trade_value_24h >= coins[9].acc_trade_value_24h` |
| 5 | `/top10/events` SSE 연결 및 이벤트 수신 | `curl -N http://localhost:3000/top10/events` → 60초 이내 `event: top10` 수신 |
| 6 | 60초 주기 자동 갱신 | 1분 대기 후 `updated_at` 타임스탬프 변경 확인 |
| 7 | 기존 ETH 기능 정상 동작 | `/price`, `/events`, `/` 모두 TOP10 추가 후에도 동일하게 동작 |
| 8 | `"date"` 키 필터링 정상 | `coins` 배열 내 `symbol: "date"` 항목 없음 |
| 9 | 에러 내성: 한 폴러 실패 시 다른 폴러 미영향 | 네트워크 차단 후 두 페이지 모두 마지막 캐시 유지 |
| 10 | npm 의존성 0개 유지 | 프로젝트 루트에 `node_modules/` 없음 |
