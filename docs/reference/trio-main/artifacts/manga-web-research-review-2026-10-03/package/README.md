# Torii × Ichigo 비교 기술 조사 — 산출물 안내

**2026-09-27 KST: 조사·비교·독립 설계·제한된 실제 모델 프로토타입 작성 완료.** 비공개 내부는 UNKNOWN, production 구현·배포는 미수행이다. 로그인/기존 credit 승인 후 두 서비스 한 장 테스트까지 진행했다.

먼저 [55개 항목 최종 보고서](10-final-report.md)를 읽으면 조사 결과에서 실제 구현 순서까지 연결된다.

| 목적 | 문서 |
|---|---|
| 전체 결과와 순서 | [최종 보고서](10-final-report.md), [94+55 체크리스트](master-checklist.md) |
| Torii 원문 근거 | [출처](torii-source-map.md), [원장](torii-evidence-ledger.md), [client](torii-client-evidence.md), [extension](torii-extension-evidence.md), [Discord·실행](torii-discord-runtime-evidence.md) |
| Ichigo 원문 근거 | [출처](ichigo-source-map.md), [원장](ichigo-evidence-ledger.md), [client](ichigo-client-evidence.md), [extension](ichigo-extension-evidence.md), [추가 추적](ichigo-final-gaps.md), [실행](ichigo-runtime-evidence.md) |
| 기술 복원과 비교 | [서비스별 architecture·component matrix](06-service-architecture-comparison.md) |
| 독립 개발 설계 | [Production blueprint](07-production-blueprint.md), [ML·식자·평가](08-ml-engineering-and-validation.md), [lifecycle·API·worker 보충](11-contract-lifecycle-and-decisions.md) |
| 데이터와 API 계약 | [PostgreSQL](schema.sql), [OpenAPI 3.1](api.openapi.yaml) |
| 비용과 일정 | [비용·성능·P0–P11·7일 sprint](09-cost-performance-roadmap.md), [비용 CSV](cost-model.csv), [비용 JSON](cost-model.json) |
| 실행한 독립 코드 | [Prototype 안내](prototype/README.md), [출력 이미지](prototype/run-002/translated.png), [실측](prototype/run-002/result.json), [fixture 평가](prototype/run-002/evaluation.json) |
| 검증·한계 | [검증 보고서](validation-report.md), [UNKNOWN과 초기 기록](05-gaps-and-intervention.md), [진행 기록](00-progress.md) |

Evidence 분류는 CONFIRMED / STRONGLY INFERRED / HYPOTHESIS / UNKNOWN이다. 독립 설계는 PROPOSED다. 개발자 발언 확인, 공개 code path, 실제 UI 실행은 다른 증거 층위다. 모델/폰트 가중치는 패키지에 포함하지 않으며 새 환경 재현 방법은 prototype 안내에 있다. credential·cookie·API key 값, 타인의 만화, proprietary source 전체를 산출물에 복제하지 않았다.
