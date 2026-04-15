# BITHUMB-RATE-005 설계 문서: 실시간 USD/KRW 환율 조회

## 1. 개요

### 기능 설명
고정 상수(`USD_KRW_RATE = 1380`)로 김프를 계산하던 방식을 제거하고,
`exchangerate-api.com` 무료 API에서 실시간 USD/KRW 환율을 조회하여 정확한 김치 프리미엄(kimchi_rate)을 계산한다.

### 범위
- **포함**: 환율 API 연동, 10초 주기 갱신, 조회 실패 시 이전값 유지, 기존 김프 계산 연동
- **제외**: 다중 소스 자동 페일오버, 캐싱 전략 최적화

### 제약 조건
- Node.js 내장 `https` 모듈만 사용 (외부 패키지 추가 금지)
- 환경변수 불필요 (초기 fallback 값 `1380` 하드코딩 유지)
- 기존 코드 변경 최소화 (변수명 `USD_KRW_RATE`는 `currentUsdKrwRate`로 전환하되, 사용 위치 최소 수정)

---

## 2. 기술 스택

| 항목 | 선택 | 이유 |
|------|------|------|
| 언어/런타임 | Node.js (기존 유지) | 기존 프로젝트 환경 |
| HTTP 클라이언트 | `https` (Node.js 내장) | SRS 제약: 외부 패키지 추가 금지 |
| 환율 API | `exchangerate-api.com` Free tier | SRS에서 명시, 인증 불필요, 응답 구조 단순 |

### 외부 API 정보

| 항목 | 내용 |
|------|------|
| URL | `https://api.exchangerate-api.com/v4/latest/USD` |
| Method | GET |
| 인증 | 없음 (Free tier) |
| Rate limit | 월 1,500회 (10초 주기 × 8,640회/일 → ⚠️ Free tier 한도 초과 가능) |
| 응답 구조 | `{ "rates": { "KRW": 1380.5, ... } }` |

> **⚠️ Rate Limit 주의**: Free tier 한도(월 1,500회)는 10초 주기(월 약 259,200회)를 감당하지 못한다.  
> **해결 방안**: 환율은 분 단위로 크게 변하지 않으므로, **환율 갱신 주기를 ETH 가격(10초)과 독립적으로 별도 관리**하되, SRS FR-002("ETH 가격 조회 주기(10초)와 동일하게")를 준수하기 위해 동일한 10초 setInterval에서 함께 호출한다. 단, **실제 HTTP 요청은 매 60초마다 1회**로 throttle하여 API 한도를 보호한다.  
>
> **Throttle 구현**: `lastFetchedAt` 타임스탬프를 관리하여 60초 미만이면 HTTP 요청을 스킵하고 기존 `currentUsdKrwRate` 값을 그대로 유지한다.

---

## 3. 시스템 구조

### 컴포넌트 관계

```
server.js
├── [변수] currentUsdKrwRate: number          ← 기존 const USD_KRW_RATE 대체
├── [변수] exchangeRateLastFetchedAt: number  ← 마지막 HTTP 실제 요청 시각 (Date.now())
│
├── fetchExchangeRate()                        ← [신규 함수]
│   ├── 60초 미경과 시: HTTP 스킵, 기존값 반환
│   ├── https.get → exchangerate-api.com
│   ├── 성공: currentUsdKrwRate 갱신, 로그 출력
│   └── 실패(타임아웃/파싱오류): currentUsdKrwRate 유지, 에러 로그
│
├── calcKimchiRate(bithumbKrw, binanceUsdt)    ← [수정] USD_KRW_RATE → currentUsdKrwRate 참조
│
└── fetchPrice()                               ← [수정] fetchExchangeRate() 병렬 호출 추가
    ├── fetchBinancePrice() [기존]
    ├── fetchExchangeRate() [신규 병렬 호출]
    └── latestKimchi.usd_krw_rate = currentUsdKrwRate [기존값 반영]
```

### 데이터 흐름

```
setInterval(fetchPrice, 10초)
  └─ fetchPrice()
       ├─ fetchBinancePrice()    → binanceUsdt
       ├─ fetchExchangeRate()    → currentUsdKrwRate 갱신 (60초 throttle)
       └─ calcKimchiRate(bithumbKrw, binanceUsdt)
            └─ base = binanceUsdt * currentUsdKrwRate   ← 실시간 환율 반영
```

---

## 4. API 스펙

### 외부 API 호출 (신규)

| 항목 | 내용 |
|------|------|
| Method | GET |
| URL | `https://api.exchangerate-api.com/v4/latest/USD` |
| Timeout | 2,000ms (NFR-001: 2초 이내 응답) |
| 성공 응답 | `{ "rates": { "KRW": <number> } }` |
| 실패 처리 | 이전 `currentUsdKrwRate` 값 유지 |

### 기존 엔드포인트 변경 영향

| 엔드포인트 | 변경 내용 |
|-----------|---------|
| `GET /gimme` | `usd_krw_rate` 필드가 실시간 환율 반영 |
| `GET /price` | `usd_krw_rate` 필드가 실시간 환율 반영 |
| `GET /events` (SSE) | broadcast payload의 `usd_krw_rate` 실시간 반영 |
| `GET /top10`, `GET /top10/data`, `GET /top10/events` | 변경 없음 (환율 미사용) |

---

## 5. 데이터 모델

### 변수 변경

| 기존 | 변경 후 | 타입 | 초기값 |
|------|---------|------|-------|
| `const USD_KRW_RATE` | `let currentUsdKrwRate` | `number` | `Number(process.env.USD_KRW_RATE) \|\| 1380` |
| (없음) | `let exchangeRateLastFetchedAt` | `number` | `0` |

### `latestKimchi` 객체 (변경 없음, 값만 동적화)

```js
{
  bithumb_krw:   number,   // Bithumb ETH/KRW
  binance_usdt:  number,   // Binance ETH/USDT
  usd_krw_rate:  number,   // ← currentUsdKrwRate (실시간 갱신)
  kimchi_rate:   number,   // 실시간 환율 기반 재계산
  updated_at:    string    // ISO 8601
}
```

---

## 6. 구현 가이드

### 6-1. 변수 선언 수정 (상단 Constants 영역)

```js
// 기존
const USD_KRW_RATE = Number(process.env.USD_KRW_RATE) || 1380;

// 변경 후
let currentUsdKrwRate = Number(process.env.USD_KRW_RATE) || 1380;
let exchangeRateLastFetchedAt = 0; // Date.now() 기준, 0 = 한 번도 성공 안 함
const EXCHANGE_RATE_URL = 'https://api.exchangerate-api.com/v4/latest/USD';
const EXCHANGE_RATE_THROTTLE_MS = 60000; // 실제 HTTP 요청 간격 최소 60초
```

### 6-2. `fetchExchangeRate()` 신규 함수

`fetchBinancePrice()` 다음에 추가한다.

```js
/**
 * Fetch USD/KRW exchange rate from exchangerate-api.com
 * Throttled: actual HTTP request at most once per EXCHANGE_RATE_THROTTLE_MS.
 * On failure: retains previous currentUsdKrwRate.
 * @returns {Promise<void>}
 */
function fetchExchangeRate() {
  const now = Date.now();
  if (now - exchangeRateLastFetchedAt < EXCHANGE_RATE_THROTTLE_MS) {
    return Promise.resolve(); // throttle: 이전값 유지
  }

  return new Promise((resolve) => {
    const req = https.get(EXCHANGE_RATE_URL, { timeout: 2000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const rate = parsed?.rates?.KRW;
          if (typeof rate === 'number' && rate > 0) {
            currentUsdKrwRate = rate;
            exchangeRateLastFetchedAt = Date.now();
            console.log(`[ExchangeRate] USD/KRW 갱신: ${currentUsdKrwRate}`);
          } else {
            console.error('[ExchangeRate] 유효하지 않은 환율 응답, 이전값 유지:', currentUsdKrwRate);
          }
        } catch (err) {
          console.error('[ExchangeRate] 파싱 오류, 이전값 유지:', err.message);
        }
        resolve();
      });
    });
    req.on('error', (err) => {
      console.error('[ExchangeRate] 요청 오류, 이전값 유지:', err.message);
      resolve();
    });
    req.on('timeout', () => {
      console.error('[ExchangeRate] 타임아웃, 이전값 유지');
      req.destroy();
      resolve();
    });
  });
}
```

### 6-3. `calcKimchiRate()` 수정

```js
// 기존
const base = binanceUsdt * USD_KRW_RATE;

// 변경 후
const base = binanceUsdt * currentUsdKrwRate;
```

### 6-4. `fetchPrice()` 수정 — `fetchExchangeRate()` 병렬 호출

`fetchBinancePrice()`와 `fetchExchangeRate()`를 `Promise.all`로 병렬 실행하여 지연을 최소화한다.

```js
// 기존
const binancePrice = await fetchBinancePrice();

// 변경 후
const [binancePrice] = await Promise.all([
  fetchBinancePrice(),
  fetchExchangeRate()   // currentUsdKrwRate를 갱신 (throttle 적용)
]);
```

이후 `latestKimchi.usd_krw_rate` 할당은 기존 코드 그대로 유지하되, 값이 `currentUsdKrwRate`를 참조하도록 한다:

```js
latestKimchi = {
  bithumb_krw:  latestPrice.current_price,
  binance_usdt: binancePrice ?? latestKimchi?.binance_usdt ?? null,
  usd_krw_rate: currentUsdKrwRate,   // ← 실시간 환율
  kimchi_rate:  kimchiRate ?? latestKimchi?.kimchi_rate ?? null,
  updated_at:   latestPrice.updated_at
};

latestPrice.usd_krw_rate = currentUsdKrwRate;  // ← 실시간 환율
```

### 6-5. 구현 순서

1. `const USD_KRW_RATE` → `let currentUsdKrwRate` + `exchangeRateLastFetchedAt` + `EXCHANGE_RATE_URL` + `EXCHANGE_RATE_THROTTLE_MS` 선언 수정
2. `fetchExchangeRate()` 함수 추가 (fetchBinancePrice 바로 뒤)
3. `calcKimchiRate()` 내 `USD_KRW_RATE` → `currentUsdKrwRate` 교체
4. `fetchPrice()` 내 `await fetchBinancePrice()` → `Promise.all([fetchBinancePrice(), fetchExchangeRate()])` 교체
5. `latestKimchi`/`latestPrice` 할당부의 `USD_KRW_RATE` → `currentUsdKrwRate` 교체 확인

---

## 7. 완료 기준 (DoD)

모든 항목은 직접 검증 가능한 형태로 작성한다.

| # | 검증 항목 | 검증 방법 |
|---|---------|---------|
| 1 | `fetchExchangeRate()` 함수 존재, Promise 반환 | 코드 리뷰: 함수 선언 및 `return new Promise(...)` 확인 |
| 2 | 서버 시작 후 최초 `fetchPrice()` 호출 시 환율 API 실제 요청 발생 | 서버 로그에 `[ExchangeRate] USD/KRW 갱신: <숫자>` 출력 확인 |
| 3 | 두 번째 `fetchPrice()` 호출(10초 후)에서 HTTP 요청 스킵 (throttle) | 로그에 두 번째 갱신 메시지 없음 확인 (60초 이내) |
| 4 | 60초 후 `fetchPrice()` 호출 시 환율 재갱신 | 로그에 다시 `[ExchangeRate] USD/KRW 갱신:` 출력 확인 |
| 5 | API 실패 시 이전 환율값 유지, 서버 미크래시 | EXCHANGE_RATE_URL을 임시 변조하여 오류 유도 → 로그에 이전값 유지 메시지, 서버 정상 운영 |
| 6 | `/gimme` 응답의 `usd_krw_rate`가 실시간 환율 반영 | `curl http://localhost:3000/gimme` → `usd_krw_rate`가 1380이 아닌 실제 환율 값 |
| 7 | `/price` 응답의 `usd_krw_rate`가 실시간 환율 반영 | `curl http://localhost:3000/price` → `usd_krw_rate` 확인 |
| 8 | SSE `/events` 페이로드의 `usd_krw_rate`가 실시간 환율 반영 | `curl -N http://localhost:3000/events` → price 이벤트의 `usd_krw_rate` 확인 |
| 9 | `kimchi_rate` 계산이 실시간 환율 기반 | `(bithumb_krw / (binance_usdt * usd_krw_rate) - 1) × 100` 수동 계산과 일치 |
| 10 | ETH 가격, TOP10 등 기존 기능 정상 작동 | `/price`, `/top10/data`, `/events`, `/top10/events` 정상 응답 확인 |
| 11 | `USD_KRW_RATE` 상수가 코드에 남아있지 않음 | `grep -n "USD_KRW_RATE" server.js` → 결과 없음 |
