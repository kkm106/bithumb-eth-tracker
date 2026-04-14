# BITHUMB-GIMME-004 설계 문서
## 해외거래소 김프 실시간 표시

---

## 1. 개요

### 기능 설명
Binance ETH/USDT 가격과 고정 환율(USD/KRW)을 사용해 **김치 프리미엄(김프)** 을 실시간 계산하고,
기존 통합 대시보드(`/`) ETH 카드 영역에 색상과 함께 표시한다.

### 범위
- **포함**
  - `server.js`: Binance API 호출 함수 추가, ETH 폴링 주기 10초로 변경, `/events` SSE 페이로드 확장, `/gimme` REST 엔드포인트 신규
  - `public/dashboard.html`: ETH 카드에 김프 % + 색상 UI 추가
- **제외**
  - USD/KRW 환율 자동 조회 (고정값 사용)
  - Binance 이외 해외 거래소 추가
  - TOP10 섹션 변경

### 제약 조건
- Node.js 기존 스택 유지 (외부 npm 패키지 추가 금지, 내장 `https` 모듈 사용)
- SSE 이벤트 이름 `price` 유지 (클라이언트 하위 호환)
- 기존 TOP10 로직·SSE 무변경

---

## 2. 기술 스택

| 항목 | 선택 | 버전 | 이유 |
|------|------|------|------|
| Runtime | Node.js | 기존 유지 | 제약 조건 |
| HTTP client | Node.js 내장 `https` | - | 외부 패키지 추가 불필요 |
| Binance API | Public REST (인증 불필요) | v3 | SRS 지정, 무료/공개 |
| 환율 | 고정값 `USD_KRW_RATE` 상수 | - | SRS 제약: 자동 환율 조회 제외 |
| 폴링 주기 | 10,000ms | - | SRS FR-005 |

---

## 3. 시스템 구조

### 컴포넌트 관계

```
┌─────────────────────────────────────────────────────────────────┐
│                          server.js                              │
│                                                                 │
│  Constants                                                      │
│  ├── BITHUMB_URL        = 'https://api.bithumb.com/...'        │
│  ├── BINANCE_URL (신규) = 'https://api.binance.com/...'        │
│  ├── USD_KRW_RATE (신규)= 1380  (환경변수 USD_KRW_RATE 우선)   │
│  └── POLL_INTERVAL      = 10000  ← 60000에서 변경              │
│                                                                 │
│  State                                                          │
│  ├── latestPrice        (기존)                                  │
│  └── latestKimchi (신규): { binance_usdt, usd_krw, rate, at } │
│                                                                 │
│  Functions                                                      │
│  ├── fetchBinancePrice() (신규) → Promise<number|null>         │
│  ├── calcKimchiRate()    (신규) → number|null                  │
│  └── fetchPrice()        (수정) → fetchBinance 결합 후 broadcast│
│                                                                 │
│  Routes                                                         │
│  ├── GET /              (무변경)                                │
│  ├── GET /price         (무변경)                                │
│  ├── GET /events SSE    (페이로드 확장: kimchi 필드 추가)       │
│  ├── GET /gimme  (신규) → latestKimchi JSON                    │
│  └── 나머지 라우트      (무변경)                                │
└─────────────────────────────────────────────────────────────────┘
           │  SSE event: price (확장 페이로드)
           ▼
┌─────────────────────────────────────────────────────────────────┐
│              public/dashboard.html                              │
│                                                                 │
│  ETH 카드 (기존 구조 유지, 김프 UI 추가)                        │
│  ┌─────────────────────────────────────┐                        │
│  │  ⟠ ETH/KRW                         │                        │
│  │  ₩4,500,000         24h: +2.31%    │                        │
│  │  ─────────────────────────────────  │                        │
│  │  🌏 김프: +1.5%  ← 신규 (녹색/빨강) │                        │
│  │  Binance: $3,250 / 환율: ₩1,380    │                        │
│  │  ─────────────────────────────────  │                        │
│  │  고가 ₩X,XXX  저가 ₩X,XXX          │                        │
│  └─────────────────────────────────────┘                        │
└─────────────────────────────────────────────────────────────────┘
```

### 데이터 플로우

```
[매 10초]
  fetchPrice()
    ├─ https.get(BITHUMB_URL)  → bithumb_krw
    └─ fetchBinancePrice()
         └─ https.get(BINANCE_URL) → binance_usdt
               │ 성공: calcKimchiRate(bithumb_krw, binance_usdt)
               │         = ((bithumb_krw / (binance_usdt * USD_KRW_RATE)) - 1) * 100
               │ 실패: 이전 latestKimchi.rate 유지 또는 null
               │
               └─ broadcast('price', { current_price, fluctate_rate_24h,
                                        binance_price, usd_krw_rate, kimchi_rate,
                                        updated_at })
```

### 김프 계산 공식

```
kimchi_rate (%) = ((bithumb_krw / (binance_usdt × usd_krw)) - 1) × 100

예시:
  bithumb_krw  = 4,500,000
  binance_usdt = 3,220.00
  usd_krw      = 1,380
  기준가        = 3,220.00 × 1,380 = 4,443,600
  김프          = ((4,500,000 / 4,443,600) - 1) × 100 = +1.27%
```

---

## 4. API 스펙

### 4-1. 기존 엔드포인트 (변경사항 명시)

#### `GET /events` — SSE 스트림 (페이로드 확장)

**이벤트명**: `price` (유지)

**Response payload 변경**

| 필드 | 기존 | 신규 | 설명 |
|------|------|------|------|
| `current_price` | ✅ | ✅ | 비트썸 현재가 (KRW) |
| `fluctate_rate_24h` | ✅ | ✅ | 24시간 등락률 (%) |
| `updated_at` | ✅ | ✅ | 갱신 ISO 시각 |
| `binance_price` | ❌ | ✅ | Binance ETH/USDT 가격 |
| `usd_krw_rate` | ❌ | ✅ | 적용된 USD/KRW 환율 |
| `kimchi_rate` | ❌ | ✅ | 김프 비율 (%, 소수점 2자리) |

**예시 payload**
```json
{
  "current_price": 4500000,
  "fluctate_rate_24h": "2.31",
  "binance_price": 3220.00,
  "usd_krw_rate": 1380,
  "kimchi_rate": 1.27,
  "updated_at": "2026-04-14T18:00:00.000Z"
}
```

**에러 시 (Binance API 실패)**
```json
{
  "current_price": 4500000,
  "fluctate_rate_24h": "2.31",
  "binance_price": null,
  "usd_krw_rate": 1380,
  "kimchi_rate": null,
  "updated_at": "2026-04-14T18:00:00.000Z"
}
```

#### `GET /price` — 현재 가격 스냅샷 (페이로드 확장)

기존 응답에 `binance_price`, `usd_krw_rate`, `kimchi_rate` 필드 추가.  
`latestPrice` 객체에 동일 필드 저장.

---

### 4-2. 신규 엔드포인트

#### `GET /gimme` — 김프 현재값 스냅샷

| 항목 | 값 |
|------|-----|
| Method | GET |
| Path | `/gimme` |
| Auth | 불필요 |
| Content-Type | `application/json; charset=utf-8` |

**성공 응답** `200 OK`
```json
{
  "bithumb_krw": 4500000,
  "binance_usdt": 3220.00,
  "usd_krw_rate": 1380,
  "kimchi_rate": 1.27,
  "updated_at": "2026-04-14T18:00:00.000Z"
}
```

**데이터 미준비** `503 Service Unavailable`
```json
{ "error": "kimchi data not yet available", "code": 503 }
```

---

### 4-3. 외부 API

#### Binance Public REST API

| 항목 | 값 |
|------|-----|
| URL | `https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT` |
| Method | GET |
| Auth | 불필요 |
| Timeout | 5,000ms |

**성공 응답**
```json
{ "symbol": "ETHUSDT", "price": "3220.00" }
```

**에러 처리**: HTTP 오류 또는 타임아웃 발생 시 `null` 반환, 이전 `latestKimchi` 유지.

---

## 5. 데이터 모델

### 서버 전역 상태 (`server.js`)

#### 기존 `latestPrice` 확장

```js
latestPrice = {
  symbol: 'ETH_KRW',
  current_price: Number,        // 비트썸 현재가 (KRW)
  opening_price: Number,
  min_price: Number,
  max_price: Number,
  fluctate_rate_24h: String,
  binance_price: Number | null, // ← 신규: Binance USDT 가격
  usd_krw_rate: Number,         // ← 신규: 적용 환율
  kimchi_rate: Number | null,   // ← 신규: 김프 비율 (%)
  updated_at: String            // ISO 8601
}
```

#### 신규 `latestKimchi`

```js
latestKimchi = {
  bithumb_krw: Number,
  binance_usdt: Number | null,
  usd_krw_rate: Number,
  kimchi_rate: Number | null,
  updated_at: String
}
```

---

## 6. 구현 가이드

> **주의**: coder는 아래 순서대로 구현한다. 각 단계를 완료 후 다음으로 진행.

### Step 1. `server.js` — 상수 추가

파일 상단 Constants 블록에 추가:

```js
const BINANCE_URL = 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT';
const USD_KRW_RATE = Number(process.env.USD_KRW_RATE) || 1380;  // 수동 설정
```

`POLL_INTERVAL` 변경:
```js
// 변경 전
const POLL_INTERVAL = 60000; // 60 seconds
// 변경 후
const POLL_INTERVAL = 10000; // 10 seconds (SRS FR-005)
```

---

### Step 2. `server.js` — 전역 상태 추가

Global state 블록에 추가:
```js
let latestKimchi = null;
```

---

### Step 3. `server.js` — `fetchBinancePrice()` 신규 함수

```js
/**
 * Fetch ETH/USDT price from Binance Public API
 * @returns {Promise<number|null>}
 */
function fetchBinancePrice() {
  return new Promise((resolve) => {
    const req = https.get(BINANCE_URL, { timeout: 5000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const price = parseFloat(parsed.price);
          resolve(isNaN(price) ? null : price);
        } catch (err) {
          console.error('Binance parse error:', err.message);
          resolve(null);
        }
      });
    });
    req.on('error', (err) => {
      console.error('Binance fetch error:', err.message);
      resolve(null);
    });
    req.on('timeout', () => {
      console.error('Binance fetch timeout');
      req.destroy();
      resolve(null);
    });
  });
}
```

---

### Step 4. `server.js` — `calcKimchiRate()` 신규 함수

```js
/**
 * Calculate Kimchi Premium rate
 * @param {number} bithumbKrw  - Bithumb ETH/KRW price
 * @param {number} binanceUsdt - Binance ETH/USDT price
 * @returns {number|null} Rate in %, rounded to 2 decimal places. null if invalid.
 */
function calcKimchiRate(bithumbKrw, binanceUsdt) {
  if (!bithumbKrw || !binanceUsdt || binanceUsdt <= 0) return null;
  const base = binanceUsdt * USD_KRW_RATE;
  if (base <= 0) return null;
  return Math.round(((bithumbKrw / base) - 1) * 10000) / 100;
}
```

---

### Step 5. `server.js` — `fetchPrice()` 수정

기존 `fetchPrice()` 내부 성공 처리 블록을 수정한다.  
`latestPrice` 할당 직후, `broadcast()` 직전에 아래 코드를 삽입:

```js
// Binance 김프 계산 (비동기, 결과 기다림)
const binancePrice = await fetchBinancePrice();
const kimchiRate = calcKimchiRate(latestPrice.current_price, binancePrice);

// latestKimchi 갱신 (Binance 실패 시 이전 kimchi_rate 유지)
latestKimchi = {
  bithumb_krw: latestPrice.current_price,
  binance_usdt: binancePrice ?? latestKimchi?.binance_usdt ?? null,
  usd_krw_rate: USD_KRW_RATE,
  kimchi_rate: kimchiRate ?? latestKimchi?.kimchi_rate ?? null,
  updated_at: latestPrice.updated_at
};

// latestPrice에도 반영
latestPrice.binance_price = latestKimchi.binance_usdt;
latestPrice.usd_krw_rate  = USD_KRW_RATE;
latestPrice.kimchi_rate   = latestKimchi.kimchi_rate;
```

**`broadcast()` 호출 페이로드 수정**:
```js
broadcast('price', {
  current_price:      latestPrice.current_price,
  fluctate_rate_24h:  latestPrice.fluctate_rate_24h,
  binance_price:      latestPrice.binance_price,   // ← 추가
  usd_krw_rate:       latestPrice.usd_krw_rate,    // ← 추가
  kimchi_rate:        latestPrice.kimchi_rate,     // ← 추가
  updated_at:         latestPrice.updated_at
});
```

> **주의**: `fetchPrice()`를 `async function`으로 선언 변경 필요 (`async function fetchPrice() { ... }`).  
> `setInterval(fetchPrice, POLL_INTERVAL)` 은 async 함수에서도 정상 동작함 (unhandled rejection 방지를 위해 내부 try/catch 유지).

---

### Step 6. `server.js` — `/gimme` 라우트 추가

기존 `/price` 라우트 아래에 삽입:
```js
// Route: GET /gimme
else if (pathname === '/gimme' && req.method === 'GET') {
  if (latestKimchi) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(latestKimchi));
  } else {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'kimchi data not yet available', code: 503 }));
  }
}
```

---

### Step 7. `public/dashboard.html` — ETH 카드 UI 수정

#### 7-1. CSS 추가 (`<style>` 블록 내)

```css
/* Kimchi Premium */
.kimchi-section {
  margin-top: 20px;
  padding-top: 20px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  text-align: center;
}

.kimchi-label {
  font-size: 0.75rem;
  color: #888;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-bottom: 6px;
}

.kimchi-rate {
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: -0.5px;
}

.kimchi-rate.positive { color: #2ed573; }  /* 양수(국내 프리미엄) = 녹색 */
.kimchi-rate.negative { color: #ff4757; }  /* 음수(역프리미엄)   = 빨강 */
.kimchi-rate.neutral  { color: #b0b0b0; }  /* N/A                = 회색 */

.kimchi-meta {
  font-size: 0.78rem;
  color: #777;
  margin-top: 6px;
}
```

> **색상 방향 결정 근거**  
> - 양수(+) = 국내가 > 해외가 → 국내 매수자에게 불리 → SRS FR-003 "긍정"은 **녹색**  
> - 음수(-) = 국내가 < 해외가 → 국내 매수자에게 유리 → SRS FR-003 "부정"은 **빨강**  
> - SRS 원문: "긍정(녹색), 부정(빨강색)" — 해석: 프리미엄 존재가 긍정(시장 활성), 역프리미엄이 부정

#### 7-2. `renderEthCard()` 함수 수정

`renderEthCard(data)` 내 HTML 템플릿에서 `.eth-connection-status` 직전에 kimchi 섹션 삽입:

```js
// kimchi_rate 렌더링 헬퍼
function renderKimchi(data) {
  if (data.kimchi_rate === null || data.kimchi_rate === undefined) {
    return `
      <div class="kimchi-section">
        <div class="kimchi-label">🌏 김치 프리미엄</div>
        <div class="kimchi-rate neutral">N/A</div>
        <div class="kimchi-meta">Binance 데이터 없음</div>
      </div>`;
  }
  const rate = Number(data.kimchi_rate);
  const cls  = rate > 0 ? 'positive' : rate < 0 ? 'negative' : 'neutral';
  const sign = rate > 0 ? '+' : '';
  const binanceStr = data.binance_price
    ? `$${Number(data.binance_price).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : '—';
  const rateStr = data.usd_krw_rate
    ? `₩${Number(data.usd_krw_rate).toLocaleString('ko-KR')}`
    : '—';
  return `
    <div class="kimchi-section">
      <div class="kimchi-label">🌏 김치 프리미엄</div>
      <div class="kimchi-rate ${cls}">${sign}${rate.toFixed(2)}%</div>
      <div class="kimchi-meta">Binance ${binanceStr} / 환율 ${rateStr}</div>
    </div>`;
}
```

기존 `renderEthCard()` 에서 `.eth-connection-status` div 직전에 `${renderKimchi(data)}` 삽입.

#### 7-3. SSE `price` 이벤트 핸들러 수정

기존 SSE 핸들러에서 `data` 객체를 그대로 `renderEthCard()`에 전달하면 신규 필드가 자동 포함됨. 추가 수정 불필요.  
단, `latestEthData` 캐시에도 신규 필드가 반영되도록 SSE 핸들러 내 `latestEthData = data` 대입이 있는지 확인.

---

## 7. 완료 기준 (DoD)

| # | 검증 항목 | 검증 명령 / 방법 |
|---|-----------|-----------------|
| 1 | Binance API 호출 성공 | `curl 'https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT'` → `{"price":"..."}` 확인 |
| 2 | `/gimme` 엔드포인트 응답 | `curl http://localhost:3000/gimme` → `kimchi_rate` 숫자 포함 JSON 반환 |
| 3 | `/price` 페이로드에 `kimchi_rate` 포함 | `curl http://localhost:3000/price \| jq '.kimchi_rate'` → 숫자 반환 |
| 4 | SSE `price` 이벤트에 `kimchi_rate` 포함 | `curl -N http://localhost:3000/events` → `kimchi_rate` 필드 확인 |
| 5 | Binance 실패 시 `kimchi_rate: null` | Binance URL 임시 차단 후 `/gimme` 조회 → `kimchi_rate: null` 반환, 서버 미크래시 확인 |
| 6 | 대시보드에 김프 % 표시 | `http://localhost:3000/` → ETH 카드에 `🌏 김치 프리미엄 +X.XX%` 표시 확인 |
| 7 | 양수 김프 = 녹색 표시 | 김프 > 0일 때 `.kimchi-rate.positive` (녹색 `#2ed573`) 적용 확인 |
| 8 | 음수 김프 = 빨강 표시 | 김프 < 0일 때 `.kimchi-rate.negative` (빨강 `#ff4757`) 적용 확인 |
| 9 | Binance 없을 때 N/A 표시 | `kimchi_rate: null` 수신 시 "N/A" 회색 텍스트 표시 |
| 10 | 10초 갱신 확인 | 대시보드 열린 상태에서 1분간 관찰 → 최소 6회 `updated_at` 변경 확인 |
| 11 | 기존 기능 정상 동작 | ETH 가격, 24h 등락률, 고가/저가, TOP10 테이블 모두 정상 표시 |
| 12 | 환율 환경변수 반영 | `USD_KRW_RATE=1400 node server.js` 기동 후 `/gimme` → `usd_krw_rate: 1400` 확인 |

---

## 부록: 파일별 변경 요약

| 파일 | 변경 유형 | 주요 변경 내용 |
|------|----------|---------------|
| `server.js` | 수정 | 상수 2개 추가, `POLL_INTERVAL` 10초 변경, 전역 변수 1개 추가, 함수 2개 신규, `fetchPrice()` async 변환+수정, `broadcast` 페이로드 확장, `/gimme` 라우트 추가 |
| `public/dashboard.html` | 수정 | CSS 6개 클래스 추가, `renderKimchi()` 함수 신규, `renderEthCard()` 내 kimchi 섹션 삽입 |
| `public/top10.html` | 무변경 | - |

---

*설계자: Architect 🏗️ | 작성일: 2026-04-14*
