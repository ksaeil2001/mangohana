# AGENTS.md

Trio는 Electron/React/TypeScript 기반 이미지 중심 만화 현지화 워크벤치다. 페이지 이미지와 대사 검토, OCR·번역·인페인팅 제안의 사용자 검토, `.ctp` 저장·복구가 핵심이다. UI 문구는 한국어를 사용한다.

현재 동작은 이 저장소의 코드·테스트·실행 근거로 확인한다. 이전 번역기와 오래된 계획은 참고 자료이며, 현재 제품을 되돌리는 근거가 아니다. 명령은 `package.json`, 배포 조건은 `.github/workflows/`를 따른다. MVP Production은 Windows x64이며 macOS는 제외한다. Linux 기존 범위는 유지한다(`docs/operations/mvp-platform-scope.md`).

## 웹서비스 목표와 작업 보고

- 별도 웹서비스 `C:/Users/ksaei/Documents/Codex/trio-manga-web`의 목표는 다양한 만화·웹툰을 업로드하면 문자 인식(OCR), 문맥을 반영한 한국어 번역, 그림을 보존하는 원문 제거, 말풍선에 맞는 자동 식자를 거쳐 수동 보정 없이 자연스럽게 읽히는 이미지를 만드는 것이다. 검수·수정·재번역·취소·실패 복구·저장·재개·ZIP 다운로드까지 웹서비스에서 연결한다. 이 저장소의 기존 Electron·저장·보안 계약은 유지한다.
- 원본과 잘 번역된 참고 이미지는 원인 분석과 성능 평가 자료다. 특정 이미지의 번역문·좌표·줄바꿈을 직접 고친 성공은 제품의 자동 성능 개선으로 계산하지 않는다. 문제는 가능한 한 공통 처리 코드를 개선하고, 다른 이미지에서도 수동 보정 없이 효과가 나타나는지 확인한다.
- 작업은 **원인 분석**(문제의 이유 조사), **샘플 보정**(특정 이미지만 직접 수정), **제품 개선**(다른 이미지에도 자동 적용되는 공통 코드 수정), **제품 검증**(수정된 프로그램을 실제로 실행해 결과 확인)으로 구분한다. 여러 유형을 함께 수행했다면 각각 표시하고 모두를 '품질 개선'으로 묶지 않는다.
- 공통 코드 반영 여부, 실제 제품 경로의 실행 결과, 입력 자료와 수동 보정 여부, 새로운 이미지에서 확인한 범위를 구분한다. 보정된 샘플의 실행 성공만으로 자동 성능이나 새 이미지 적용을 검증했다고 하지 않으며, 미검증 개선을 완료로 보고하지 않는다.
- 특정 샘플의 파일명·해시·고정 좌표·정답 번역문으로 분기하거나 입력을 제한한 검증은 일반 자동 처리의 증거가 아니다. 요청별 원본 무결성 검사에 쓰는 해시와 샘플 전용 처리를 구분한다. 기존 고정 평가 세트와 별도의 새로운 이미지에서 같은 기준으로 회귀·품질을 확인한다.
- 번역 제품의 전체 품질 완료 판정에는 실제 웹서비스의 업로드부터 최종 다운로드까지 이어진 실행과 번역 의미·원문 잔여·그림 보존·식자 가독성 검토가 필요하다. 자동 테스트, 독립 실험, 개별 PNG 생성과 사람의 품질 확인은 각각 구분하며 확인하지 못한 항목은 미검증으로 남긴다.
- 모든 답변은 쉬운 한국어로 직접적인 답을 먼저 말한다. 필요한 전문용어는 처음에 풀어 설명하고, 파일명·함수명·구현 과정은 핵심 이해에 필요할 때만 언급한다. 작업 보고는 가급적 아래 다섯 항목으로 짧게 작성하되 중요한 문제와 검증 한계를 생략하지 않는다.

**현재 하는 일:** [작업 유형] 무엇을 하고 있는지

**제품이 실제로 개선됐나?:** 예 / 아니요 / 일부와 확인한 근거 또는 미검증 이유

**새로운 만화에도 자동 적용되나?:** 예 / 아니요 / 미검증과 확인한 범위

**이번에 해결한 문제:** 쉬운 말로 설명

**다음 작업:** 다음에 고칠 문제 또는 필요한 행동 하나

## 프로세스와 보안 경계

- `src/renderer/`는 Node.js/fs에 직접 접근하지 않으며, 프로젝트·원본 파일 경로나 임의 명령을 IPC로 전달하지 않는다.
- 파일 접근, project session, secret, external API 호출은 `src/main/`이 소유한다. `electron/preload.ts`는 최소 IPC만 노출하고, main은 IPC input과 session ownership을 검증한다.
- 프로세스 간 type/validation의 source of truth는 `src/shared/`다.
- API key/token/password와 민감한 프로젝트 내용은 코드·로그·fixture에 남기지 않는다. API 키는 OS 보안 저장소 또는 실행 세션에만 두며 프로젝트 파일에 포함하지 않는다.
- path validation, session ownership, encryption/integrity check를 우회하지 않는다. 외부 AI로 보내는 이미지·crop·프롬프트·대사 범위를 임의로 확대하지 않는다.

## 프로젝트 데이터와 AI 소유권

- 원본 이미지를 수정·덮어쓰지 않는다. 작업 사본과 파생 이미지는 별도 프로젝트 자산으로 보관한다.
- `.ctp` 호환성, sidecar 자산, schema validation, migration, atomic save와 recovery 안전성을 보존한다. 정식 저장, backup, recovery candidate와 무효 복구 산출물을 구분한다.
- recovery 변경 전 `src/main/projectRecovery.ts`와 `tests/main/projectRecovery.test.ts`를 확인한다. 검증된 candidate·backup 복원과 무효 파일 보존 정책을 임의 삭제·덮어쓰기로 바꾸지 않는다.
- AI OCR·화자·번역·인페인팅 결과는 제안·검토 대상이다. 사용자 확정값처럼 취급하거나 조용히 자동 승인하지 않는다.
- OCR의 `ai_proposed`, `user_modified`, `user_confirmed` 계약을 따른다. 재실행·병합은 사용자 소유 값을 보존하고, 모호한 결과는 검토 상태로 남긴다.
- 인페인팅의 provider success, QA status, `finalStatus`, `approvedCleanedAssetId`는 별개 계약이다. 공유 타입·테스트 확인 없이 성공과 승인 의미를 합치지 않는다.

## 비동기·성능·화면 맥락

- late result는 현재 project/session/page/revision 및 해당 작업의 selection/source와 일치할 때만 반영한다. 전환·재실행·cancel/retry 이후 이전 결과가 새 상태를 덮어쓰지 않게 한다.
- lazy page hydration, 활성·인접 페이지 중심 viewport cache, dirty page protection, chunk 단위 저장을 보존한다. 전체 이미지·프로젝트를 한 번에 적재·복제하거나 변경 없는 chunk를 반복 저장하지 않는다.
- cache는 session 전환 시 초기화하거나 안전한 identity로 범위를 제한한다. 성능 개선이 저장 무결성·사용자 데이터·UI 정확성을 약화해서는 안 된다.
- 현재 페이지·선택 대사·화자·편집 초안·이미지 zoom/pan/layer·패널 맥락을 보존한다. Focus Deck, 페이지 탐색, 작업 도구, 결과 레이어의 역할을 섞지 않는다.
- 비동기 진행·결과·실패 원인·비활성 이유와 재시도·취소 행동을 표시한다. 키보드 입력·전역 단축키 충돌을 막고, 반응형 화면에서도 이미지 검토·주요 행동·현재 상태를 유지한다.

## 필요한 참조와 승인 경계

- 검증 선택과 증거의 의미는 [docs/agent-validation.md](docs/agent-validation.md)를 필요한 때 참조한다. 실제 제공자·패키징·물리 설치 증거를 자동 테스트와 구분한다.
- 별도 웹서비스의 다음 작업·완료 조건·검증 명령은 [웹 검증 하네스](C:/Users/ksaei/Documents/Codex/trio-manga-web/docs/agent-harness.md)를 필요한 때 참조한다. 변경 전 성공 기준을 정하고 선택 검사 성공과 실제 제품 품질 합격을 구분한다.
- 관련 설계는 `docs/superpowers/specs/`에 있다. 수 시간 이상 또는 여러 session 작업은 해당 작업의 기존 `docs/superpowers/plans/` 계획이나 활성 ledger가 있으면 재사용한다. 작은 작업에는 상태 문서를 만들지 않으며 중복 ledger나 `.agent-state/`를 추가하지 않는다.
- `dist-electron/`, `dist-renderer/`, `release/`는 생성 결과물이므로 직접 수정하지 않는다.
- Trio의 프로세스 경계·전체 아키텍처, 데이터 모델·저장 형식·migration, IPC·외부 API·공개 계약, 삭제·recovery·crypto·보안 모델, 새 의존성·대규모 refactor, 핵심 UI·승인 흐름, 인증·배포·업데이트·릴리스 방식 변경은 현재 구현·설계와 영향·trade-off를 확인하고 사용자 승인을 받는다.

## Agent skills

### Issue tracker

작업 항목은 `ksaeil2001/trio`의 GitHub Issues에서 관리한다. 명령과 게시 경계는 `docs/agents/issue-tracker.md`를 따른다.

### Triage labels

기본 5개 라벨의 의미와 실제 매핑은 `docs/agents/triage-labels.md`를 따른다.

### Domain docs

단일 용어집 `GLOSSARY.md`와 필요한 결정 기록 `docs/adr/`를 사용한다. 읽기 범위와 기존 설계 문서의 관계는 `docs/agents/domain.md`를 따른다.
