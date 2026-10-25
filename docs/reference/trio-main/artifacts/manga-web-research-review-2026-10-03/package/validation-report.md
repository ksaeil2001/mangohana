# 최종 검증 보고서

2026-09-27 KST. **설계/문법 검증, 실제 서비스 UI 실행, 독립 모델 실행을 구분한다.**

| 검사 | 결과 | 증명 범위 |
|---|---|---|
| Evidence ID | Torii73 + Ichigo64 = 137, 중복0 | 원장 항목 수이며 독립 출처 수가 아님 |
| 핵심 비교/종합 보고서 evidence 참조 | 존재하지 않는 ID0 | source 사실의 진위를 parser가 판정한 것은 아님 |
| 원문 추적 | 94개 요구사항 + 55개 최종 항목 | 설계/실행/미검증 상태를 구분해 연결 |
| PostgreSQL 문법 | pglast7.7 parser PASS, 101 statements, 37 tables | PL/pgSQL body 실행·migration·RLS·FK DML·concurrency 테스트 아님 |
| OpenAPI3.1 | openapi-spec-validator0.7.2 PASS, 22 paths / 25 operations | 실제 HTTP server 구현/인증/성능 검증 아님 |
| Torii UI | 같은 소유 PNG 한 장, 결과·상세·텍스트 관찰 | 1.10credits, UI3.43s; ZIP export 파일은 미확보 |
| Ichigo UI | 익명 quota5→4, 한국어 JPG 실제 download | 내부 OCR/LLM/provider timing은 미관찰 |
| 로컬 prototype | run-002 종료0, 실제 pinned OCR+MT 모델 | flat white bubble fixture1장, CLI; mock/provider API 아님 |
| Fixture 평가 | 2regions/14chars CER0, overflow0, mask 밖 불변 | 넓은 만화 품질·context·complex background 성능 아님 |
| 회귀 테스트 | 6 passed | blank abstain, mask 불변, fit bounds, oversized word 거절, invalid image, byte cap |

## 검증 중 수정한 결함

- OpenAPI flow mapping의 쉼표 때문에 description이 의도치 않은 property로 읽힌 오류를 validator로 발견하고 문자열 quoting을 수정했다. 최종 확장 명세도 재검증했다.
- reservation release를 refund로 적었던 초안을 수정했다. duplicate settlement는 기존 결과를 반환하고 실제 provider 비용만 정산한다.
- webhook receipt의 append-only trigger와 processed_at update가 충돌하는 초안을 receipt/processing 두 테이블로 분리했다. 처리 효과와 processed 상태를 원자적으로 commit하도록 설계했다.
- stage unique를 job+stage+page로 수정해 여러 page 작업을 표현하도록 했다. documents/pages/images/OCR/translation/payment/session 명시 계약과 lifecycle을 추가했다.
- Torii/Ichigo 근거 혼합, 존재하지 않는 I-049, Ichigo IndexedDB probe의 cache 과해석을 교정했다. 개발자 진술을 server-code 검증으로 확대하지 않았다.

## 수행하지 않은 검증

실제 PostgreSQL migration/RLS 역할·race 실행, API server E2E, payment provider test/live webhook, queue failure injection, extension 설치, native app 실행, PDF/ZIP batch, volume context, LaMa inference, broad holdout 평가, 새 PC 설치/재현, SaaS 배포는 수행하지 않았다. 이는 다음 개발 gate이며 이번 문법/fixture 통과로 대체되지 않는다.

검증 dependency는 workspace work/validation-deps에 격리했다. 자동 dependency resolver가 오래 진행되어 중단한 뒤 필요한 validator 버전을 고정해 설치했다. 사용자 전역 설정이나 credential을 수정하지 않았다.

기계 집계: [validation-summary.json](validation-summary.json). 실행 세부: [prototype README](prototype/README.md), [결과 JSON](prototype/run-002/result.json), [fixture evaluation](prototype/run-002/evaluation.json).

UTF-8 Markdown 26개를 읽어 내부 파일 링크 누락0, 비정상 제어문자0을 확인했다. 외부 링크의 미래 가용성이나 유료 서비스 재실행을 반복 검증한 것은 아니다.
