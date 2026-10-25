# Trio manga web

이 폴더는 연결된 설계 문서를 기준으로 Trio 웹서비스를 개발하는 프로젝트다. 작업 범위와 검토·설계·구현 여부는 현재 사용자 요청을 따른다. 원본 Electron 저장소의 dirty 변경·`.ctp`·IPC는 보존한다.

웹서비스의 목표, 네 가지 작업 구분과 쉬운 한국어 보고 형식은 [공통 작업 기준](C:/Users/ksaei/OneDrive/문서/trio-main/AGENTS.md#웹서비스-목표와-작업-보고)을 따른다.

- TypeScript API/worker가 현재 계정·owner·revision·시계·파일·비밀·비용 접근을 소유한다. 브라우저는 임의 경로·계정·자격 증명을 권위로 전달하지 않는다.
- 원본 bytes, 사용자 수정값, 실제 수행·무료 시작·비용·정산·보관 사실을 보존한다. unknown을 실패/0원/자동 재호출로 바꾸지 않는다.
- 검증은 loopback·OS tmpdir의 격리 PG18·합성 계정/자료/자격 증명을 사용한다. 실제 외부 계정·설정·AI 자료 전송·유료 실행·구매·배포·commit/push는 별도 명시 승인 범위다.
- source of truth와 진행 기록은 `docs/source-reference.json`이 가리키는 기존 Domain Story/spec/plan이다. 현재 단계와 검증 증거는 기존 plan과 `docs/validation/`에 남긴다.
- 분리 가능한 구현·검증은 worker, 긴 작업 완료 전 독립 검토는 architect에 맡긴다. 다른 worker 변경을 보존하고 맡은 파일만 수정한다.

## 검증 하네스

- 변경 전 목표·입력과 기대 결과·허용 변경 파일·완료 조건과 확인 방법을 먼저 정한다. 다음 작업과 증거 수준은 [검증 하네스](docs/agent-harness.md)를 필요한 때 참조하고, 현재 작업은 기존 플랜의 최신 기록을 이어 간다.
- 작업 절차는 제공되는 Superpowers의 brainstorming·writing-plans·test-driven-development·verification-before-completion을 필요한 범위에 적용하고, 프로젝트의 기존 검사 명령을 재사용한다. 사용자 지시와 이 AGENTS.md의 변경 보존·검증·승인 조건이 우선한다.
- 실패·미실행·필수 증거 누락·검사 후 관련 소스 변경을 성공으로 처리하지 않는다. 선택한 검사 통과는 그 범위에 한정하며 실제 웹 전체 흐름·새 이미지의 무보정 결과·사람의 페이지 품질 합격을 별도 증거로 확인한 뒤에만 제품 완료로 판정한다.
