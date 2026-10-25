# 최종 진행·실행 기록

2026-09-27 KST. 원문 Master Prompt의 94개 항목과 최종 55개 항목을 추적했다. 원본 E: 문서는 수정하지 않았다.

| 순서 | 작업 | 현재 결과 |
|---|---|---|
|1|Torii Source Discovery|공식/커뮤니티/store/API/GitHub/integration 지도, 후속 Discord 원문|
|2|Ichigo Source Discovery|같은 정보원 축, historical/current 분리, named model/org 추가 추적|
|3|Torii Evidence Ledger|73개 ID; 기본/client/Discord·실행 분리|
|4|Ichigo Evidence Ledger|64개 ID; 기본/client/재검색·실행 분리|
|5|누락 정보원 재검색|개발자/model/endpoint/package/domain 변형 추적, UNKNOWN·접근 제한 기록|
|6|각 Architecture Reconstruction|근거 등급과 미확인 경계를 붙인 서비스별 Mermaid|
|7|Head-to-Head|동일 component 비교 및 기술 선택 matrix|
|8|Independent Rebuild|설계/SQL/OpenAPI/ML·context·editor·billing·security 계약|
|9|Technical Prototype|실제 로컬 모델 1장 성공 + 6개 회귀 테스트; 제한된 flat-bubble baseline|
|10|MVP→Production Roadmap|P0–P11, 첫7일, 운영 gate, 비용·성능·확장 시나리오|

Evidence 137개는 **독립 출처 137개라는 뜻이 아니다**. 같은 출처에서 분리한 여러 사실이 포함된다. [검증 기록](validation-report.md).

## 정상 개입 후 진행

사용자 로그인으로 Torii/Discord를 열고, 기존 credit 한 장 사용 승인을 받아 Torii를 실행했다. UI가 1.10 credit·3.43초를 표시했고 영어 출력과 세부 텍스트를 확인했다. Ichigo는 같은 소유 PNG를 익명 무료 범위에서 제출해 한국어 JPG를 실제 내려받고 잔여량 5→4를 확인했다. Torii ZIP export 파일 확보는 미검증이다. 다른 target language이므로 동등 품질/속도 benchmark로 다루지 않는다.

## 독립 구현과 검증

공개 모델 revision을 고정해 credential 없이 내려받고, local-only inference로 실행했다. 검출/원문/번역/mask/cleaned/render artifact와 JSON을 저장했다. 최종 run-002는 exit0, fixture CER0(14자), overflow0, mask 밖 불변이었다. 6개 회귀 테스트 통과. 새 machine 설치, broad manga, LaMa, context, 실제 웹/extension/DB/billing은 실행하지 않았다.

## 최종 일관성 수정

잘못된 evidence ID, capability probe의 cache 오해, LaMa/Pillow 진술과 실행 검증 혼동을 교정했다. 금전 reservation release를 refund와 분리했고, webhook immutable receipt와 retryable processing state를 분리했다. page별 stage unique, document/page 결과 모델, 최대 attempts, MVP 범위와 roadmap 명칭을 맞췄다. SQL/OpenAPI 파서 검증 및 파일 참조 검사는 별도 보고서에 남긴다.

현재 필요한 로그인/승인 대기는 없다. 모든 비공개 내부를 알아냈거나 production 구현을 마쳤다고 주장하지 않는다.
