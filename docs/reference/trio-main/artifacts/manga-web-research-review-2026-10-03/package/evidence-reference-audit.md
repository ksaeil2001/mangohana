# Architecture 문서 Evidence Reference Audit

작성일: 2026-09-27 KST  
대상: `outputs/06-service-architecture-comparison.md`  
범위: Architecture reconstruction 및 head-to-head 표의 근거 ID·분류·표 구조 정합성 점검

## 검사 결과

- **잘못된 Ichigo ID 제거:** 초안에 있던 `I-049`는 현재 Ichigo ledger에 존재하지 않아 Database/Queue 행에서 제거했다. 해당 행은 “Ichigo evidence unavailable”로 남겨, 데이터베이스나 queue가 없다고 결론내리지 않는다.
- **I-110 의미 교정:** `I-110`은 공개 bundle의 canvas/WebGL 및 IndexedDB 관련 capability/symbol probe이다. Ichigo의 실제 cache, object store, persistence, schema를 확인한 자료가 아니다. Storage, Cache, Extension storage, Renderer 관련 문구를 이 범위로 제한했다.
- **Torii runtime fallback 경계 교정:** 비교 문서의 Torii live run은 1장 `3.43s`, `1.10 credits`를 관찰했지만 해당 실행에서 fallback은 발생하지 않았다. 따라서 fallback metadata를 실행 결과로 쓰지 않고, 정적 client/release에 존재하는 fallback 경로와 별도로 기록했다.
- **T-205 반영:** Torii 개발자 공개 발언은 자체 OCR engine을 만들었다는 사실만 확정한다. vendor, detector architecture, checkpoint, training data, production deployment는 UNKNOWN이다.
- **T-206 반영:** Torii 개발자 발언의 `optimized LaMa`는 LaMa 계열 사용 진술로 기록했다. fork, checkpoint, inference host, current route/runtime은 UNKNOWN이다.
- **T-207 반영:** Pillow 발언은 Torii typesetting에 Pillow를 사용한다는 개발자 진술이다. 웹 editor의 모든 픽셀 렌더러와 server/client parity까지 확장하지 않았다.
- **T-209 반영:** top-to-bottom paragraph delivery 발언을 OCR/reading-order 표에 반영했으나, 일반 manga panel의 RTL·말풍선 순서 전체를 증명하는 것으로 확장하지 않았다.
- **결제 근거 경계:** `T-201`은 Lemon Squeezy entitlement correction에 관한 역사적 개발자 발언으로만 사용했다. Dodo는 pricing-page option 수준이며 현재 결제 transaction/webhook/ledger 실행 증거가 아니다.
- **정적 계약과 runtime 분리:** Torii의 `/api/v2/upload`·OCR·inpaint·typeset 및 Ichigo의 `/translate` message는 각각 공개 문서/정적 client 계약 단서이다. endpoint 문자열, manifest, bundle symbol은 현재 서버 schema나 운영 provider 실행을 단독 증명하지 않는다.
- **Technology Matrix 구조:** Component, Torii confirmed, Torii inferred/unknown, Ichigo confirmed, Ichigo inferred/unknown, PROPOSED candidate, Alternative, Evidence의 8개 열과 24개 component 행(Web frontend부터 Deployment)을 확인했다. Mobile은 head-to-head 18번과 별도 `Mobile comparison` 단락으로 다뤘다.

## 남은 미확인 범위

Torii 자체 OCR의 정확한 모델·detector·training data·provider routing, optimized LaMa의 checkpoint/hosting, Pillow pipeline의 전체 render parity, queue/GPU/autoscaling, current billing webhook/ledger는 공개 근거만으로 결정할 수 없다. Ichigo는 `/translate`의 현재 schema, OCR/translation provider, reading-order algorithm, queue/DB/object storage/cache persistence, mobile/backend parity가 남아 있다. 로그인·비공개 Discord/Reddit 자료는 우회하지 않았으며 필요한 경우 사용자 개입 큐로 남긴다.

## 판정

문서 안의 ID는 현재 사용 가능한 ledger 범위(`I-001`~`I-038`, `I-100`~`I-116`, `I-200`~`I-205`, `I-300`~`I-302`)에 맞춰 사용했고, `I-049` 참조는 0건이다. 근거가 capability probe 또는 역사적 발언인 경우 해당 한계를 각 표에 명시했다. 이 감사는 architecture 문서의 참조 정합성 검사이며, 추가 runtime 성공이나 backend 구현 확인을 주장하지 않는다.
