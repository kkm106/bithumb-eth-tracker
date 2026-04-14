# BITHUMB-UNIFIED-003 설계 문서
## 빗썸 통합 대시보드 (단일 페이지)

---

## 1. 개요

### 기능 설명
ETH 가격 정보와 거래량 상위 10개 코인 정보를 **단일 페이지(`/`)**에 통합 표시.  
기존 두 페이지(`/`, `/top10`)를 하나의 대시보드로 합친다.

### 범위
- `public/dashboard.html` 신규 생성
- `server.js` 최소 수정 (2줄 변경)
- 기존 `/top10` 페이지 유지 (하위 호환)

### 제약 조건
- SSE 스트림 구조 변경 없음 (`/events`, `/top10/events` 그대로 사용)
- 60초 서버 폴링 주기 변경 없음
- `server.js` 라우터 로직 추가 없음 (파일 경로만 변경)

---

## 2. 기술 스택

| 항목 | 선택 | 이유 |
|------|------|------|
| HTML/CSS | Vanilla (기존 스타일 계승) | 외부 의존성 없음, 기존 코드와 일관성 |
| 레이아웃 | CSS Grid (2-column) | 반응형 대응 용이, 별도 라이브러리 불필요 |
| 데이터 수신 | SSE (기존 `/events`, `/top10/events`) | 서버 변경 없이 재사용 가능 |
| 초기 데이터 | REST (`/price`, `/top10/data`) | SSE 연결 전 즉시 렌더링 |

---

## 3. 시스템 구조

### 라우팅 변경 (server.js)

```
[변경 전]
GET /           → public/index.html   (ETH 전용)
GET /top10      → public/top10.html   (TOP10 전용)

[변경 후]
GET /           → public/dashboard.html  ← 파일명만 변경 (1줄)
GET /dashboard  → public/dashboard.html  ← 새 별칭 라우트 추가 (8줄)
GET /top10      → public/top10.html   (유지)
```

### 데이터 플로우

```
Browser (dashboard.html)
  │
  ├─── fetch('/price')          → 초기 ETH 데이터 즉시 렌더
  ├─── fetch('/top10/data')     → 초기 TOP10 데이터 즉시 렌더
  │
  ├─── EventSource('/events')
  │      └── event: price       → ETH 카드 실시간 갱신 (60초)
  │
  └─── EventSource('/top10/events')
         └── event: top10       → TOP10 테이블 실시간 갱신 (60초)
```

### 페이지 레이아웃 구조

```
┌─────────────────────────────────────────────────────┐
│  Header: 🏗️ 빗썸 통합 대시보드    [갱신시간] [상태]  │
├────────────────────┬────────────────────────────────┤
│                    │                                │
│   ETH 가격 카드     │     TOP 10 거래대금 테이블      │
│  ┌──────────────┐  │  ┌──────────────────────────┐  │
│  │ ⟠ ETH/KRW   │  │  │ 순위 코인 현재가 등락률…  │  │
│  │ ₩X,XXX,XXX  │  │  │  1   BTC  ₩...  +2.3%   │  │
│  │ 📈 +2.31%   │  │  │  2   ETH  ₩...  +1.8%   │  │
│  │             │  │  │  3   XRP  ₩...  -0.5%   │  │
│  │ 고가  저가   │  │  │  ...                     │  │
│  │ ₩XXX  ₩XXX  │  │  │  10  SOL  ₩...  +3.1%   │  │
│  └──────────────┘  │  └──────────────────────────┘  │
│                    │                                │
├────────────────────┴────────────────────────────────┤
│  Footer: 마지막 갱신 시각 | ← ETH 상세 | TOP10 상세 → │
└─────────────────────────────────────────────────────┘

[모바일: 단일 컬럼, ETH 카드 상단 / TOP10 테이블 하단]
```

---

## 4. API 스펙

기존 API 변경 없음. dashboard.html에서 사용하는 엔드포인트 목록:

| Method | Path | 용도 | Response |
|--------|------|------|----------|
| GET | `/price` | ETH 초기 가격 로드 | `{ symbol, current_price, opening_price, min_price, max_price, fluctate_rate_24h, updated_at }` |
| GET | `/top10/data` | TOP10 초기 데이터 로드 | `{ updated_at, coins: [{rank, symbol, current_price, fluctate_rate_24h, acc_trade_value_24h, acc_trade_volume_24h}] }` |
| GET | `/events` | ETH SSE 스트림 | `event: price` → `{ current_price, fluctate_rate_24h, updated_at }` |
| GET | `/top10/events` | TOP10 SSE 스트림 | `event: top10` → `{ updated_at, coins: [...] }` |

---

## 5. 데이터 모델

서버 데이터 모델 변경 없음. 기존 `latestPrice`, `latestTop10` 그대로 사용.

---

## 6. 구현 가이드

### 6-1. server.js 변경사항 (최소화)

**변경 1: `/` 라우트의 파일명 변경**

```js
// 변경 전 (약 168번째 줄)
const filePath = path.join(__dirname, 'public', 'index.html');

// 변경 후
const filePath = path.join(__dirname, 'public', 'dashboard.html');
```

**변경 2: `/dashboard` 별칭 라우트 추가 (기존 `/` 라우트 바로 아래)**

```js
// Route: GET /dashboard (alias for /)
else if (pathname === '/dashboard' && req.method === 'GET') {
  const filePath = path.join(__dirname, 'public', 'dashboard.html');
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error reading dashboard.html');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(content);
  });
}
```

> **변경 범위**: 총 2곳, 약 10줄. 기존 SSE/heartbeat/폴링 로직 무변경.

### 6-2. public/dashboard.html 신규 작성

**CSS 구조**
```css
/* 2-컬럼 그리드 레이아웃 */
.dashboard-grid {
  display: grid;
  grid-template-columns: 380px 1fr;   /* 좌: ETH 카드 고정폭, 우: TOP10 가변폭 */
  gap: 24px;
  align-items: start;
}

/* 모바일 반응형 */
@media (max-width: 900px) {
  .dashboard-grid {
    grid-template-columns: 1fr;       /* 단일 컬럼 */
  }
}
```

**JS 구조 (두 SSE 동시 연결)**
```js
// ETH SSE
const ethSSE = new EventSource('/events');
ethSSE.addEventListener('price', (e) => renderEthCard(JSON.parse(e.data)));

// TOP10 SSE
const top10SSE = new EventSource('/top10/events');
top10SSE.addEventListener('top10', (e) => renderTop10Table(JSON.parse(e.data)));

// 초기 데이터 (SSE 연결 전 즉시 렌더링)
Promise.allSettled([
  fetch('/price').then(r => r.json()).then(renderEthCard),
  fetch('/top10/data').then(r => r.json()).then(d => renderTop10Table(d))
]);
```

**ETH 카드 렌더 함수** (`renderEthCard(data)`)
- 현재가, 등락률(색상 구분: 양수=red, 음수=green), 고가, 저가 표시
- 기존 `index.html`의 `.card`, `.price-display`, `.stats-grid` 스타일 재활용

**TOP10 테이블 렌더 함수** (`renderTop10Table(data)`)
- 기존 `top10.html`의 테이블 구조 그대로 이식
- 상위 3개 금/은/동 색상 강조 유지

**연결 상태 표시**
- ETH SSE 연결 상태 인디케이터 (ETH 카드 하단)
- TOP10 SSE 연결 상태 인디케이터 (테이블 헤더)
- 재연결 로직: 3초 후 재시도 (기존 방식 동일)

### 6-3. 기존 `/top10` 페이지 처리 방안

**→ 유지 (삭제하지 않음)**

| 이유 | 설명 |
|------|------|
| 하위 호환성 | 기존 북마크/링크 유효 유지 |
| 변경 최소화 | 삭제 시 server.js 수정 필요 |
| 상세 뷰 활용 | 통합 대시보드에서 "상세 보기" 링크로 연결 가능 |

`top10.html`의 내비게이션 링크를 `/` → `/dashboard`로 업데이트 (선택적, 1줄 변경).

---

## 7. 완료 기준 (DoD)

| # | 검증 항목 | 검증 방법 |
|---|-----------|-----------|
| 1 | `GET /` 응답이 dashboard.html을 반환한다 | `curl -s http://localhost:3000/ \| grep "통합 대시보드"` |
| 2 | `GET /dashboard` 동일 HTML을 반환한다 | `curl -s http://localhost:3000/dashboard \| grep "통합 대시보드"` |
| 3 | 브라우저에서 ETH 카드가 좌측/상단에 렌더링된다 | 크롬 DevTools 레이아웃 확인 |
| 4 | 브라우저에서 TOP10 테이블이 우측/하단에 렌더링된다 | 크롬 DevTools 레이아웃 확인 |
| 5 | 페이지 로드 후 3초 내 ETH 현재가가 표시된다 | 수동 확인 |
| 6 | 페이지 로드 후 3초 내 TOP10 테이블이 채워진다 | 수동 확인 |
| 7 | ETH 데이터가 60초마다 자동 갱신된다 | 갱신 시각 변화 확인 (1~2분 대기) |
| 8 | TOP10 데이터가 60초마다 자동 갱신된다 | 상동 |
| 9 | `GET /top10` 이 기존 top10.html을 정상 반환한다 | `curl -s http://localhost:3000/top10 \| grep "TOP 10"` |
| 10 | 모바일(900px 이하)에서 ETH 카드가 TOP10 위에 표시된다 | Chrome DevTools 반응형 모드 확인 |
| 11 | SSE 연결 끊김 시 3초 후 자동 재연결된다 | DevTools Network 탭에서 강제 오프라인 테스트 |

---

*설계자: Architect 🏗️ | 작성일: 2026-04-14*
