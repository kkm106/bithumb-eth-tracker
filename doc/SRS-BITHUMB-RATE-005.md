# SRS-BITHUMB-RATE-005: 실시간 USD/KRW 환율 조회

## 1. 개요
- **목적**: 고정 환율 대신 실시간 USD/KRW 환율을 조회하여 정확한 김프 계산
- **범위**:
  - 포함: 무료 환율 API 연동, 10초 주기 갱신, 조회 실패 시 이전값 유지
  - 제외: 환율 캐싱 전략 최적화, 다중 환율 소스 자동 페일오버

## 2. 기능 요구사항 (FR)
| ID | 요구사항 | 우선순위 |
|----|---------|---------|
| FR-001 | 무료 API(exchangerate-api.com 또는 유사)로 USD/KRW 환율 조회 | **Must** |
| FR-002 | ETH 가격 조회 주기(10초)와 동일하게 환율 갱신 | **Must** |
| FR-003 | API 조회 실패 시 이전 환율값 유지 | **Must** |
| FR-004 | 조회된 환율을 기존 김프 계산에 즉시 반영 | **Must** |

## 3. 비기능 요구사항 (NFR)
| ID | 분류 | 요구사항 |
|----|------|---------|
| NFR-001 | 성능 | API 응답 시간: 2초 이내 |
| NFR-002 | 신뢰성 | 환율 API 실패 → 이전값 유지, 서버 미크래시 |
| NFR-003 | 호환성 | 기존 코드 최소 영향 (USD_KRW_RATE 상수만 동적 변경) |

## 4. 외부 API
- **선택 API**: exchangerate-api.com (Free tier 지원)
  - URL: `https://api.exchangerate-api.com/v4/latest/USD`
  - 응답: `{ "rates": { "KRW": 1380.5, ... } }`
  - 인증: 불필요 (기본 Free tier)
  - Rate limit: 충분함 (월 1500회, 초당 1회 정도면 충분)

## 5. 제약 조건
- Node.js 내장 `https` 모듈 사용 (외부 패키지 추가 금지)
- 환경변수 없이 즉시 동작 (fallback 불필요)

## 6. 완료 기준 (DoD)
- [ ] fetchExchangeRate() 함수 구현 (Promise 반환)
- [ ] 10초마다 환율 조회 및 USD_KRW_RATE 갱신
- [ ] API 실패 시 이전값 유지 로직
- [ ] kimchi_rate 계산에 실시간 환율 반영 확인
- [ ] /gimme, /price, SSE 페이로드에 최신 환율 포함 확인
- [ ] 기존 기능(ETH 가격, TOP10) 정상 작동 확인
- [ ] 로그에 환율 갱신 메시지 확인

---

## 승인 대기
✋ 위 요구사항 확인. 진행 승인 필요.
