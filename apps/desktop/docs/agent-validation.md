# Trio agent validation reference

검증 수준은 파일 수가 아니라 실패 영향과 변경된 계약으로 판단한다. 아래는 검증 선택을 위한 참조이며 매 작업의 전체 실행 체크리스트가 아니다. 명시된 인수·릴리스 조건은 유지하고, 실행하지 못한 검증은 이유와 함께 구분한다.

## Validation levels

| 수준 | 변경 영향 | 선택할 증거 |
| --- | --- | --- |
| L0 | 문서·주석·실행 의미 없는 변경 | 내용·참조·구문·diff 검사. 제품 테스트·build는 관행적으로 실행하지 않는다. |
| L1 | 국소 static/type 검증으로 판단 가능한 변경 | 관련 정적 검사와 필요 시 `typecheck`. 타입 성공은 동작 증거가 아니다. |
| L2 | 한 영역의 동작 변경 또는 bug fix | 해당 영역의 focused test, 버그 재현·회귀 검증. renderer는 관련 Testing Library 테스트를 선택한다. |
| L3 | shared/preload/main/renderer 계약, 저장·복구·비동기 상태 전파 | 계약 양쪽과 호출 경로의 테스트. 잘못된 입력·소유권·stale result·취소·재시도 및 dirty 보호를 해당 변경에 맞춰 검사한다. |
| L4 | 넓은 refactor, build 설정, dependency 변경 | 영향 범위의 회귀 테스트와 전체 suite/typecheck/build, 필요한 runtime·package 검사. |
| L5 | 저장 형식, recovery, crypto, signing, update/release, production OCR resource | 관련 L3/L4 증거와 실제 자산·서명·런타임·배포 후보 검증. 로컬 단위 테스트만으로 릴리스 조건을 충족했다고 판단하지 않는다. |

수준은 누적 명령 묶음이 아니다. recovery처럼 영향이 큰 변경은 작은 diff여도 L5이며, L3의 mocked IPC 검증이 실제 Electron 검증을 대체하지 않는다.

## Existing Trio validation mapping

PowerShell에서 저장소 루트를 기준으로 실행한다. 명령의 source of truth는 [package.json](../package.json), Vitest 설정은 [vite.config.ts](../vite.config.ts)다. 기본 테스트 환경은 jsdom이며 `.worktrees`는 제외된다. 개별 파일의 환경 지정과 mock을 함께 확인한다.

| 명령 | 주 적용 수준 | 증명하는 범위와 한계 |
| --- | --- | --- |
| `npm.cmd run typecheck` | L1–L5 | `tsc --noEmit` 및 `tsc -p tsconfig.node.json --noEmit`. 타입 계약 검사이며 실행 동작은 증명하지 않는다. |
| `npm.cmd test -- <focused test>` | L2–L5 | 지정한 Vitest 테스트의 assertion 범위. 예: `npm.cmd test -- tests/main/projectRecovery.test.ts`. mock·fixture·환경의 한계를 포함해 해석한다. |
| `npm.cmd test` | L4 또는 넓은 회귀 위험 | 현재 Vitest suite의 회귀 검사. 실제 AI 제공자, 설치·업데이트와 전체 앱 E2E를 의미하지 않는다. |
| `npm.cmd run build` | L4 및 관련 L3/L5 | main TypeScript 컴파일과 Vite renderer 번들 생성. 앱 기동·패키징·추론 성공과 별개다. |
| `npm.cmd run smoke:ipc` | L3 | `tests/main/ipcHandlers.integration.test.ts`의 handler/integration 계약. Electron API가 mock이다. |
| `npm.cmd run smoke:storage` | L3/L5 | build 후 `scripts/storage-smoke.mjs`가 OS 임시 폴더에서 일반·암호화 `.ctp` 저장/로드와 잘못된 비밀번호 거부를 확인한다. 모든 migration/recovery/장애 상황은 포함하지 않는다. |
| `npm.cmd run smoke:ocr-production` | L5 | main build 후 Electron에서 실제 Production OCR service와 설치된 resource/runtime으로 고정 fixture를 추론한다. 아래 PASS/FAIL/BLOCKED를 구분한다. |
| `npm.cmd run smoke:package` | L4/L5 | `scripts/ci-smoke-packaged-app.mjs`가 기존 `release/`의 현재 OS 패키지·필수 파일/메타데이터와 앱 기동을 확인한다. 패키지를 생성하지 않으며 새 Windows 설치·실제 OCR·사용자 workflow 완주를 증명하지 않는다. |
| `npm.cmd run test:release-policy` | L5 | `tests/scripts/releaseChannelPolicy.test.mjs`의 태그·채널·stable signing gate 정책. 실제 서명 또는 공개 배포 증거가 아니다. |
| `npm.cmd run test:release-evidence` | L5 | `tests/scripts/releaseCandidateEvidence.test.mjs`의 후보 evidence 생성·검증 및 자산 정책. fixture의 서명 검증 값은 실제 후보의 Authenticode 검증을 대신하지 않는다. |

### smoke:ipc

[ipcHandlers.integration.test.ts](../tests/main/ipcHandlers.integration.test.ts)는 `vi.mock("electron")`으로 dialog, ipcMain, protocol, nativeImage, net을 대체하며 등록된 handler를 검사한다.

**handler/integration evidence ≠ actual Electron runtime evidence**

preload 변경은 [preload.test.ts](../tests/electron/preload.test.ts)도 관련 증거다. 이 테스트 역시 Electron API를 mock하므로 실제 contextBridge·창·프로세스 통신의 runtime 검증과 구분한다.

### productionOcrGoldenPath

`npm.cmd test -- tests/main/productionOcrGoldenPath.test.ts`는 [해당 테스트](../tests/main/productionOcrGoldenPath.test.ts)의 deterministic detector/recognizer와 fake crop을 사용한다. OCR 결과의 provenance·검토 병합·사용자 수정 보존·저장/재열기·export 연결을 검사한다.

**OCR pipeline/data contract evidence ≠ actual Production OCR inference evidence**

### smoke:ocr-production

[main.mjs](../scripts/production-ocr-smoke/main.mjs)는 실제 Electron에서 SVG fixture를 PNG로 만들고 `createProductionOcrService`를 실행한다. CMS 서명과 checksum이 검증된 `trio-production-ocr-win32-x64` resource pack 및 실행 가능한 detector/recognizer runtime이 필요하다.

| 결과 | 현재 smoke의 의미 |
| --- | --- |
| PASS | 모든 fixture의 추론·텍스트·방향·읽기 순서·provenance 검사를 통과하고 exit 0. 고정 fixture 범위의 실제 추론 증거다. |
| FAIL | 시작·실행 오류 또는 fixture assertion 실패, exit 1. build 실패도 PASS가 아니다. |
| BLOCKED | resource/runtime 준비 상태가 `ready`가 아니어서 실행 전 중단, exit 2. 누락 자원을 fake로 대체하거나 PASS로 기록하지 않는다. |

스크립트는 repository `resources/`와 `LOCALAPPDATA` 기반 기본 resource root(없으면 Electron userData 기반 경로)를 참조한다. 실행 전 자원·프로필의 범위와 격리를 확인한다. smoke는 자원을 설치하지 않는다. 실행 자체를 하지 않았으면 `NOT RUN`과 사유를 기록하고 실제 출력의 BLOCKED와 구분한다.

### 계약별 focused evidence와 릴리스 경계

- 저장·복구: [projectRecovery.test.ts](../tests/main/projectRecovery.test.ts), [projectStorage.test.ts](../tests/storage/projectStorage.test.ts), [incrementalProjectStorage.test.ts](../tests/main/incrementalProjectStorage.test.ts). 정상 저장뿐 아니라 해당 변경의 invalid input·경로 이탈·candidate/backup 실패를 검사한다.
- hydration/cache: [lazyPageHydrationManager.test.ts](../tests/main/lazyPageHydrationManager.test.ts), [usePageHydration.test.ts](../tests/renderer/usePageHydration.test.ts), [viewportCache.test.ts](../tests/shared/viewportCache.test.ts). 현재 session/page/revision, dirty page 및 지연 결과 계약에 맞는 검증을 선택한다.
- 성능 변경: [pipelineBenchmark.test.ts](../tests/main/pipelineBenchmark.test.ts)와 실제 변경 병목에 가까운 측정이 증거다. 빠른 실행만으로 데이터 보존을 증명하지 않는다.
- CI·릴리스의 추가 조건은 해당 [.github/workflows](../.github/workflows/)와 [MVP 플랫폼 범위](operations/mvp-platform-scope.md)를 따른다. package smoke, 실제 제공자 실행, 독립된 깨끗한 Windows 설치, signing/update/release 승인은 각각 별도 증거다.

L0 문서 변경은 `git diff --check`와 `git diff -- AGENTS.md docs/agent-validation.md` 등 해당 diff·참조를 확인한다. 새 untracked 문서는 일반 `git diff`에 나오지 않으므로 내용·공백을 별도로 검사한다. Git 저장소가 아니면 파일 비교와 동등한 공백 검사를 사용한다.
