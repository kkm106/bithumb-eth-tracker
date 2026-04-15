# BITHUMB-BANKRATE-006 설계 문서: 한국은행 공식 환율 적용

## 1. 개요

### 기능 설명
고정 상수(`const USD_KRW_RATE = 1380`)로 김프를 계산하던 방식을 제거하고,
**한국수출입은행(koreaexim.go.kr) 전시환율 공개 API**에서 USD/KRW 공식 환율을 조회한다.

갱신 주기: 서버 기동 시 1회 + 이후 **매일 오후 11시(KST = 14:00 UTC)** 1회.
API 실패 시 이전 환율값 유지, 서버는 정상 운영을 계속한다.

> **브랜치 기준**: `feature/BITHUMB-BANKRATE-006`은 `main`에서 분기되었다.  
> `main`의 현재 코드는 `const USD_KRW_RATE = 1380` 고정 상수를 사용하며,  
> BITHUMB-RATE-005(exchangerate-api.com 연동)는 아직 미병합 상태이므로  
> `fetchExchangeRate()`, `EXCHANGE_RATE_URL`, `exchangeRateLastFetchedAt` 등은 존재하지 않는다.  
> 본 설계는 **현재 main 코드베이스 기준**으로 작성한다.

### 범위
- **포함**
  - `fetchBankKoreaRate()` 신규 함수 구현
  - `const USD_KRW_RATE` 상수 → `let currentUsdKrwRate` 변수로 전환
  - `KOREA_EXIM_URL_BASE` 상수 추가
  - 서버 기동 시 초기 1회 환율 조회
  - 매일 23:00 KST(= 14:00 UTC) 자동 재조회 스케줄러
  - API 실패 시 이전값 유지(서버 미크래시)
  - 기존 `/gimme`, `/price`, SSE 페이로드에 최신 환율 자동 반영
- **제외**
  - 다중 환율 소스 자동 페일오버
  - 시간대별 환율 히스토리
  - BITHUMB-RATE-005 연동 (별도 태스크)

### 제약 조건
- Node.js 내장 `https` 모듈 사용 (외부 패키지 추가 금지)
- `authkey`는 환경변수 `KOREA_EXIM_AUTHKEY`로 주입, 기본값 빈 문자열(`""`)
  - koreaexim.go.kr에서 무료 신청 가능; SRS 제약 "authkey 없이 동작"을 위해 빈값 허용 설계
  - **운영 환경에서는 발급된 authkey 사용 권장**
- 일일 1회 갱신으로 API 호출 최소화

---

## 2. 기술 스택

| 항목 | 선택 | 이유 |
|------|------|------|
| 언어/런타임 | Node.js (기존 유지) | 기존 프로젝트 환경 |
| HTTP 클라이언트 | `https` (Node.js 내장) | SRS 제약: 외부 패키지 추가 금지 |
| 환율 API | `koreaexim.go.kr` 전시환율 공개 API | SRS 지정, 한국은행 공식 (신뢰도 최고) |
| 스케줄러 | `setTimeout` 재귀 패턴 | Node.js 내장; 매일 23:00 KST 정각 계산에 적합 |

### 외부 API 정보

| 항목 | 내용 |
|------|------|
| URL | `https://www.koreaexim.go.kr/site/program/financial/exchangeJson` |
| Query params | `authkey=<KOREA_EXIM_AUTHKEY>`, `searchdate=<YYYYMMDD>`, `data=AP01` |
| Method | GET |
| Timeout | 3,000ms (NFR-001) |
| 갱신 시각 | 매일 약 23:00 KST |
| 사용 필드 | `deal_bas_r` (거래중심환율), 예: `"1,474.50"` → `1474.50` |
| USD 식별 | `cur_unit === "USD"` |

---

## 3. 시스템 구조

### 컴포넌트 관계

```
server.js
│
├── [상수 교체] const USD_KRW_RATE = 1380
│              → const KOREA_EXIM_URL_BASE = '...'
│
├── [변수 추가] let currentUsdKrwRate: number  ← 초기값 1380 fallback
│
├── getKstDateStr(offsetDays?)                ← [신규] KST 날짜 문자열 반환
│
├── fetchBankKoreaRate(dateStr?, isRetry?)    ← [신규] 한국은행 환율 조회
│   ├── dateStr 미지정 → getKstDateStr(0) (오늘 KST)
│   ├── https.get → koreaexim.go.kr
│   ├── cur_unit === "USD" 항목 검색
│   ├── deal_bas_r 파싱 ("1,474.50" → 1474.50)
│   ├── 성공: currentUsdKrwRate 갱신, 로그 출력
│   ├── 데이터 없음(빈 배열/USD 미포함): 어제 날짜로 1회 재시도
│   └── 실패(네트워크/파싱 오류): currentUsdKrwRate 유지, 에러 로그
│
├── scheduleNextRateUpdate()                  ← [신규] 매일 23:00 KST 스케줄러
│   ├── 다음 23:00 KST(= 14:00 UTC)까지 delay 계산
│   ├── setTimeout(delay) → fetchBankKoreaRate() + scheduleNextRateUpdate()
│   └── 로그: 다음 갱신 예정 시각 출력
│
├── calcKimchiRate(bithumbKrw, binanceUsdt)   ← [수정] USD_KRW_RATE → currentUsdKrwRate
│
├── fetchPrice()                              ← [유지] 변경 없음
│   └── currentUsdKrwRate 참조는 자동 반영 (calcKimchiRate 수정으로 충분)
│
└── server.listen() 기동 블록                 ← [수정] async화
    ├── await fetchBankKoreaRate() 초기 1회 호출
    ├── scheduleNextRateUpdate() 호출
    └── 기존 fetchPrice, fetchTop10, setInterval 유지
```

### 데이터 흐름

```
서버 기동
  └─ await fetchBankKoreaRate()   → currentUsdKrwRate 초기화
  └─ scheduleNextRateUpdate()     → setTimeout(다음 23:00 KST)

매일 23:00 KST
  └─ fetchBankKoreaRate()         → currentUsdKrwRate 갱신
  └─ scheduleNextRateUpdate()     → 다음날 23:00 KST 재등록

setInterval(fetchPrice, 10초)
  └─ fetchBinancePrice()          → binanceUsdt
  └─ calcKimchiRate(bithumbKrw, binanceUsdt)
       └─ base = binanceUsdt * currentUsdKrwRate  ← 한국은행 공식 환율
```

---

## 4. API 스펙

### 외부 API 호출 — `fetchBankKoreaRate()`

| 항목 | 내용 |
|------|------|
| Method | GET |
| Base URL | `https://www.koreaexim.go.kr/site/program/financial/exchangeJson` |
| Query: authkey | `process.env.KOREA_EXIM_AUTHKEY \|\| ""` |
| Query: searchdate | 오늘 KST 날짜 (YYYYMMDD); 데이터 없으면 어제 날짜 재시도 |
| Query: data | `AP01` |
| Timeout | 3,000ms |

**성공 응답 예시**
```json
[
  {
    "result": 1,
    "cur_unit": "USD",
    "deal_bas_r": "1,474.50",
    "cur_nm": "미국 달러"
  }
]
```

**파싱 로직**
```
items = JSON.parse(body)
usdItem = items.find(item => item.cur_unit === "USD")
rate = parseFloat(usdItem.deal_bas_r.replace(/,/g, ""))
currentUsdKrwRate = rate  // 예: 1474.50
```

**실패 케이스 및 처리**

| 케이스 | 처리 |
|--------|------|
| 네트워크 오류 | 이전 `currentUsdKrwRate` 유지, `[BankRate] 요청 오류, 이전값 유지` 로그 |
| 타임아웃 (3초 초과) | `req.destroy()`, 이전값 유지 |
| JSON 파싱 실패 | 이전값 유지, 에러 로그 |
| USD 항목 없음 (오늘) | 어제 날짜로 1회 재시도 |
| 어제도 없음 | 이전값 유지, 경고 로그 |
| `deal_bas_r` NaN | 이전값 유지, 경고 로그 |

### 기존 엔드포인트 영향

| 엔드포인트 | 변경 내용 |
|-----------|---------|
| `GET /gimme` | `usd_krw_rate` 필드가 한국은행 공식 환율 반영 |
| `GET /price` | `usd_krw_rate` 필드가 한국은행 공식 환율 반영 |
| `GET /events` (SSE) | broadcast payload의 `usd_krw_rate` 한국은행 공식 환율 반영 |
| `GET /top10`, `GET /top10/data`, `GET /top10/events` | 변경 없음 |

---

## 5. 데이터 모델

### 상수/변수 변경

| 기존 | 처리 | 신규/변경 |
|------|------|---------|
| `const USD_KRW_RATE = Number(process.env.USD_KRW_RATE) \|\| 1380` | **교체** | `let currentUsdKrwRate = Number(process.env.USD_KRW_RATE) \|\| 1380` |
| (없음) | **추가** | `const KOREA_EXIM_URL_BASE = 'https://www.koreaexim.go.kr/...'` |

> `USD_KRW_RATE`가 참조되는 모든 위치를 `currentUsdKrwRate`로 교체해야 한다.  
> 현재 참조 위치: `calcKimchiRate()` 내부, `latestKimchi` 할당부, `latestPrice` 할당부.

### `latestKimchi` 객체 (구조 변경 없음, 값만 정확도 향상)

```js
{
  bithumb_krw:   number,   // Bithumb ETH/KRW
  binance_usdt:  number,   // Binance ETH/USDT
  usd_krw_rate:  number,   // ← 한국은행 공식 환율 (예: 1474.50)
  kimchi_rate:   number,   // 한국은행 환율 기반 재계산
  updated_at:    string    // ISO 8601
}
```

---

## 6. 구현 가이드

### 6-1. 상수/변수 영역 수정 (파일 상단)

```js
// [교체]
// const USD_KRW_RATE = Number(process.env.USD_KRW_RATE) || 1380;
//                         ↓
let currentUsdKrwRate = Number(process.env.USD_KRW_RATE) || 1380;

// [추가]
const KOREA_EXIM_URL_BASE = 'https://www.koreaexim.go.kr/site/program/financial/exchangeJson';
```

### 6-2. `getKstDateStr(offsetDays)` 신규 헬퍼 함수

`fetchBinancePrice()` 다음에 추가한다.

```js
/**
 * KST(UTC+9) 기준 오늘(또는 N일 전) 날짜를 YYYYMMDD 문자열로 반환
 * @param {number} offsetDays  0=오늘, -1=어제
 * @returns {string}
 */
function getKstDateStr(offsetDays = 0) {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000 + offsetDays * 86400000);
  const y = kst.getUTCFullYear();
  const m = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(kst.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}
```

### 6-3. `fetchBankKoreaRate(dateStr, isRetry)` 신규 함수

`getKstDateStr()` 바로 다음에 배치한다.

```js
/**
 * 한국수출입은행 전시환율 API에서 USD/KRW 환율 조회.
 * 오늘 데이터 없으면 어제 날짜로 1회 재시도.
 * 실패 시 이전 currentUsdKrwRate 유지.
 * @param {string}  [dateStr]   YYYYMMDD (기본: 오늘 KST)
 * @param {boolean} [isRetry]   내부 재시도 플래그 (외부에서 전달 불필요)
 * @returns {Promise<void>}
 */
function fetchBankKoreaRate(dateStr, isRetry = false) {
  const authkey = process.env.KOREA_EXIM_AUTHKEY || '';
  const date = dateStr || getKstDateStr(0);
  const url = `${KOREA_EXIM_URL_BASE}?authkey=${encodeURIComponent(authkey)}&searchdate=${date}&data=AP01`;

  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 3000 }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const items = JSON.parse(data);

          // 빈 배열 또는 비배열 → 어제 날짜 재시도
          if (!Array.isArray(items) || items.length === 0) {
            if (!isRetry) {
              console.warn(`[BankRate] ${date} 데이터 없음, 어제 날짜로 재시도`);
              fetchBankKoreaRate(getKstDateStr(-1), true).then(resolve);
            } else {
              console.error('[BankRate] 어제 데이터도 없음, 이전값 유지:', currentUsdKrwRate);
              resolve();
            }
            return;
          }

          const usdItem = items.find((item) => item.cur_unit === 'USD');
          if (!usdItem) {
            if (!isRetry) {
              console.warn(`[BankRate] ${date} USD 항목 없음, 어제 날짜로 재시도`);
              fetchBankKoreaRate(getKstDateStr(-1), true).then(resolve);
            } else {
              console.error('[BankRate] 어제도 USD 항목 없음, 이전값 유지:', currentUsdKrwRate);
              resolve();
            }
            return;
          }

          const rate = parseFloat(usdItem.deal_bas_r.replace(/,/g, ''));
          if (isNaN(rate) || rate <= 0) {
            console.error('[BankRate] deal_bas_r 파싱 실패, 이전값 유지:', usdItem.deal_bas_r);
            resolve();
            return;
          }

          currentUsdKrwRate = rate;
          console.log(`[BankRate] USD/KRW 갱신 (${date}): ${currentUsdKrwRate}`);
          resolve();

        } catch (err) {
          console.error('[BankRate] 파싱 오류, 이전값 유지:', err.message);
          resolve();
        }
      });
    });

    req.on('error', (err) => {
      console.error('[BankRate] 요청 오류, 이전값 유지:', err.message);
      resolve();
    });
    req.on('timeout', () => {
      console.error('[BankRate] 타임아웃, 이전값 유지');
      req.destroy();
      resolve();
    });
  });
}
```

### 6-4. `scheduleNextRateUpdate()` 신규 함수

`fetchBankKoreaRate()` 바로 다음에 배치한다.

```js
/**
 * 다음 23:00 KST(= 14:00 UTC)에 환율 갱신을 스케줄한다.
 * 호출 시점이 이미 14:00 UTC를 지났으면 다음날 14:00 UTC로 설정.
 */
function scheduleNextRateUpdate() {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(14, 0, 0, 0); // 14:00 UTC = 23:00 KST

  if (next <= now) {
    next.setUTCDate(next.getUTCDate() + 1);
  }

  const delayMs = next - now;
  console.log(`[BankRate] 다음 환율 갱신 예정: ${next.toISOString()} (${Math.round(delayMs / 60000)}분 후)`);

  setTimeout(async () => {
    await fetchBankKoreaRate();
    scheduleNextRateUpdate(); // 재귀 등록
  }, delayMs);
}
```

### 6-5. `calcKimchiRate()` 수정 — `USD_KRW_RATE` → `currentUsdKrwRate`

```js
// [기존]
const base = binanceUsdt * USD_KRW_RATE;

// [변경 후]
const base = binanceUsdt * currentUsdKrwRate;
```

### 6-6. `fetchPrice()` 내 USD_KRW_RATE 참조 교체

`fetchPrice()` 내부에서 `USD_KRW_RATE`를 직접 참조하는 곳은 없으나,  
`latestKimchi`와 `latestPrice` 할당부의 `usd_krw_rate: USD_KRW_RATE` 구문을 확인하여 `currentUsdKrwRate`로 교체한다.

```js
// [기존]
latestKimchi = {
  ...
  usd_krw_rate: USD_KRW_RATE,
  ...
};
latestPrice.usd_krw_rate = USD_KRW_RATE;

// [변경 후]
latestKimchi = {
  ...
  usd_krw_rate: currentUsdKrwRate,
  ...
};
latestPrice.usd_krw_rate = currentUsdKrwRate;
```

### 6-7. `server.listen()` 기동 블록 수정

```js
// [기존]
server.listen(PORT, () => {
  ...
  fetchPrice();
  setInterval(fetchPrice, POLL_INTERVAL);
  ...
});

// [변경 후] — async화 + 한국은행 환율 초기 조회 추가
server.listen(PORT, async () => {
  console.log(`\n🚀 Bithumb ETH Tracker listening on http://localhost:${PORT}`);
  console.log('Press Ctrl+C to stop\n');

  // 한국은행 환율 초기 조회 (await: 환율 확보 후 fetchPrice 실행)
  console.log('📡 한국은행 환율 초기 조회...');
  await fetchBankKoreaRate();

  // 매일 23:00 KST 갱신 스케줄러 등록
  scheduleNextRateUpdate();

  // 기존 ETH 가격 폴링 유지
  console.log('📡 Fetching initial price...');
  fetchPrice();
  setInterval(fetchPrice, POLL_INTERVAL);

  // 기존 TOP10 폴링 유지
  console.log('📡 Fetching initial TOP10...');
  fetchTop10();
  setInterval(fetchTop10, TOP10_POLL_INTERVAL);

  // 기존 heartbeat 유지
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL);
  setInterval(sendTop10Heartbeat, HEARTBEAT_INTERVAL);
});
```

> **주의**: `server.listen()` 콜백을 `async`로 선언하여 `await fetchBankKoreaRate()` 사용.  
> 이렇게 하면 환율이 확보된 상태에서 첫 번째 `fetchPrice()`가 실행된다.

### 6-8. 구현 순서 요약

| 순서 | 파일 위치 | 작업 내용 |
|-----|----------|---------|
| 1 | 상수 영역 | `const USD_KRW_RATE` → `let currentUsdKrwRate` 교체 |
| 2 | 상수 영역 | `KOREA_EXIM_URL_BASE` 상수 추가 |
| 3 | fetchBinancePrice 다음 | `getKstDateStr()` 함수 추가 |
| 4 | getKstDateStr 다음 | `fetchBankKoreaRate()` 함수 추가 |
| 5 | fetchBankKoreaRate 다음 | `scheduleNextRateUpdate()` 함수 추가 |
| 6 | `calcKimchiRate()` | `USD_KRW_RATE` → `currentUsdKrwRate` 교체 |
| 7 | `fetchPrice()` | `latestKimchi`, `latestPrice` 내 `USD_KRW_RATE` → `currentUsdKrwRate` 교체 |
| 8 | `server.listen()` | 콜백 async화, `fetchBankKoreaRate()` + `scheduleNextRateUpdate()` 추가 |

> `grep -n "USD_KRW_RATE" server.js` 로 누락 없이 전체 교체 확인.

---

## 7. 완료 기준 (DoD)

| # | 검증 항목 | 검증 방법 |
|---|---------|---------|
| 1 | `fetchBankKoreaRate()` 함수 존재, Promise 반환 | 코드 리뷰: `return new Promise(...)` 확인 |
| 2 | 서버 기동 시 한국은행 API 호출 1회 | 로그에 `[BankRate] USD/KRW 갱신 (YYYYMMDD): <숫자>` 확인 |
| 3 | 갱신된 환율이 1380이 아닌 실제 한국은행 환율 | `curl /gimme` → `usd_krw_rate`가 네이버 환율과 ±1원 이내 |
| 4 | 두 번째 `fetchPrice()` 호출에서 환율 API 추가 호출 없음 | 로그에 `[BankRate]` 메시지가 기동 직후 1회 + 23:00 KST 1회만 출력 |
| 5 | API 네트워크 오류 시 이전값 유지, 서버 미크래시 | `KOREA_EXIM_URL_BASE`를 임시 변조 → 로그에 `[BankRate] 요청 오류, 이전값 유지` + 서버 정상 운영 |
| 6 | API 타임아웃(3초) 시 이전값 유지 | timeout 값을 1ms로 임시 설정 → 타임아웃 로그 + 이전값 유지 |
| 7 | 오늘 데이터 없을 때 어제 날짜 재시도 | 미래 날짜 강제 주입 → 로그에 `어제 날짜로 재시도` 메시지 확인 |
| 8 | `deal_bas_r` 콤마 포함 문자열 파싱 정상 | `"1,474.50"` → `currentUsdKrwRate === 1474.50` 코드 리뷰 |
| 9 | `/gimme` 응답 `usd_krw_rate` 한국은행 환율 반영 | `curl http://localhost:3000/gimme` → `usd_krw_rate` 실값 확인 |
| 10 | `/price` 응답 `usd_krw_rate` 한국은행 환율 반영 | `curl http://localhost:3000/price` → `usd_krw_rate` 확인 |
| 11 | SSE `/events` 페이로드 `usd_krw_rate` 한국은행 환율 반영 | `curl -N http://localhost:3000/events` → price 이벤트 `usd_krw_rate` 확인 |
| 12 | `kimchi_rate` 계산 정확도 ±1원 이내 | `(bithumb_krw / (binance_usdt * usd_krw_rate) - 1) × 100` 수동 계산과 일치 |
| 13 | ETH 가격, TOP10 등 기존 기능 정상 | `/price`, `/top10/data`, SSE 엔드포인트 정상 응답 |
| 14 | `USD_KRW_RATE` 상수 코드에 없음 | `grep -n "USD_KRW_RATE" server.js` → 결과 없음 |
| 15 | 로그에 환율 갱신 메시지 출력 | 기동 로그에 `[BankRate] USD/KRW 갱신` 확인 |
| 16 | 매일 23:00 KST 재갱신 스케줄 등록 확인 | 로그에 `[BankRate] 다음 환율 갱신 예정: <ISO날짜>` 확인 |
| 17 | 환율 정확도 검증 | 네이버 환율 비교 ±1원 이내 |
