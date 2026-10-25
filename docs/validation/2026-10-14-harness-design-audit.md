# Superpowers 하네스 설계와 지침 점검

상태: **구현 전 조사·설계 검토 결과**. 성공 기준과 변경 범위를 먼저 제시하는 단계다. 이번 조사에서 기존 지침·제품 코드·검사 실행기·TOML·외부 스킬 원본은 변경하지 않았다. 이 보고서는 새 진행 원장이 아니며 현재 진행과 승인 기록은 기존 플랜을 따른다.

검토일: 2026-10-14 (Asia/Seoul). 작업 유형: 원인 분석·설계·지침 점검.

## 결론

현재 전역과 두 프로젝트의 AGENTS.md는 영상에서 설명한 성공 기준 선행, 근거에 따른 검증, 작은 변경, 자료 보호, 제품과 합성 검사 구분을 대부분 포함한다. 문장을 더 늘리는 것보다 **기존 검사 실행기의 증거 보존과 실패 경로를 먼저 보강하는 것**이 필요하다.

현재 하네스는 지침과 기존 검사 명령을 연결한 상태다. 모든 작업을 자동 차단하는 장치나 실제 번역 품질 검증이 이미 완성된 상태로 해석하면 안 된다. Superpowers 활성 설정 복구와 실제 작업에서 모든 스킬이 자동 호출되는 것은 별개다.

## 다음으로 할 하네스 작업 하나와 완료 조건

**다음 작업: 기존 웹 PG·브라우저 검사 실행기에서 과거 검증 기록을 보존하고, 실패와 소유한 임시 PG의 정리 결과를 완료 판정에 연결한다.**

구현 후보는 기존 실행기의 국소 보강이다. 별도 범용 runner, 새 의존성, Git/CI·배포 정책, 모델/보안 설정 변경은 포함하지 않는다. 성공 기준을 검토한 뒤 구현한다.

| ID | 완료 조건 | 확인 방법과 기대 결과 |
| --- | --- | --- |
| H01 | 작업 목표·허용 파일·성공 조건마다 검사 방법이 연결됨 | 작업별 조건표와 아래 직접 회귀/정적/격리 실행 명령 대조. 없는 명령이나 확인하지 않은 결과를 완료 근거로 쓰지 않음 |
| H02 | 과거 증거 보존과 실행별 결과 분리 | 기존 postgres-environment.json의 전후 bytes·SHA-256 동일. 두 번의 격리 fixture 실행은 서로 다른 새 결과 경로를 사용하며 출력 충돌은 덮어쓰기 대신 오류 |
| H03 | 실패가 성공으로 처리되지 않음 | 디렉터리 준비 실패, child 시작 실패, child exit 7, 실제 임시 파일 쓰기 실패/충돌, 정리 실패를 직접 주입. 해당 실행이 exit 0/PASS로 끝나지 않음. 기존 검사 실패의 종료 코드와 이유 보존 |
| H04 | 이번 실행기가 소유한 임시 PG의 정리 경계가 확인됨 | 디렉터리 준비 실패는 PG 시작 전 중단. PG helper가 정상 반환한 뒤의 child·검사·기록 실패에는 stop이 실행됨. 정리 실패는 성공으로 숨기지 않음. 준비된 격리 runtime에서 정상 종료도 별도 확인 |
| H05 | 검증 범위와 기존 작업을 보존함 | 허용 변경 범위 외 bytes·설정 보존. 합성 제공자 검사, 실제 제품 웹 처리, 새 이미지 무보정, 사람 품질 검토를 구분. 미실행 필수 확인은 NOT RUN/BLOCKED로 남기고 전체 완료로 승격하지 않음 |

정리 보강의 시작점은 **startIsolatedPostgres가 정상 반환한 이후**다. helper 내부에서 PG를 부분 시작한 뒤 실패하는 경로는 이번 변경의 보장 범위에 포함하지 않으며 미검증 위험으로 남긴다. 강제 종료와 모든 OS 장애를 정리 완료로 보장하지 않는다.

## 현재 파일이 영상 원칙에 맞는가?

| 영상의 원칙 | 현재 근거 | 판정과 보강 필요 |
| --- | --- | --- |
| 성공 기준을 구현 전에 정함 | 전역 AGENTS.md 10·15행, 웹 AGENTS.md 15행, agent-harness.md 7–17행 | 지침에 존재. 이번 요청은 조건·짧은 설계 검토 뒤 구현하도록 적용 |
| 실제 실행으로 검증 | 전역 19–24행, main의 agent-validation.md, 웹 기존 PG/browser 실행기 | 검사별 증거 수준은 잘 구분됨. 합성 제공자의 브라우저 성공을 실제 번역 공정으로 확대하지 않음 |
| 검사 실패를 자동 검출 | test-all.ts의 실패 종료 코드 전파, Electron CI의 typecheck/test | 해당 검사 범위에 존재. 웹 browser는 npm test에 포함되지 않으며 웹 Git/CI 차단은 없음 |
| 작게 바꾸고 검증 | 전역 8–9·20–24행, 기존 플랜과 관련 테스트 선택 | 적절함. 이번 첫 변경은 실행기 증거·정리로 좁힘 |
| 원본·사용자 자료 보호 | 전역 16–17행, main의 데이터·복구·보안 계약, 웹 AGENTS.md 8–9행 | 규칙은 충분함. 검사 실행기의 증거 덮어쓰기와 준비 실패 후 정리 누락을 실제 보강 대상으로 선정 |
| 도구를 바꿔도 프로젝트에 검증 기준 유지 | 프로젝트 AGENTS.md, validation 문서, package.json, 기존 테스트 | 적절함. Superpowers는 절차를 제공하고 프로젝트의 품질 자료·검사는 별도로 유지 |

이름은 자동 지침 탐색용 **AGENTS.md**를 유지한다. 전역에는 공통 판단·보존 원칙, 프로젝트에는 해당 제품 계약, 상세 검사에는 validation 문서를 두는 현재 분리가 적절하다. 같은 규칙을 전역·main·web에 길게 복제하거나 외부 Superpowers 원문을 수정할 필요가 없다.

## 확인한 실행기 문제와 한계

1. **과거 PG 증거 덮어쓰기:** [test-postgres.ts](../../scripts/test-postgres.ts:17)는 고정 docs/validation/postgres-environment.json에 기록한다. 지금도 쓰기 실패는 예외로 전파되므로 이미 오류를 숨긴다고 판단하지 않는다. 보강 목표는 기존 자료 보존과 실행별 기록이다.
2. **준비 실패의 정리 경계:** PG runner의 7–10행은 PG 시작 뒤 mkdir가 try 밖에 있고, [browser runner](../../scripts/test-browser.ts:10)도 PG 시작 뒤 mkdtemp가 try 밖에 있다. 그 준비 작업이 실패하면 finally에 도달하지 않는다. 실제 PG 잔류를 이번 조사에서 관측한 것은 아니다.
3. **환경 상속과 호출 수 표기:** 두 실행기는 자식에 process.env를 전달하며 호출 수 0은 고정 필드다. 실제 credential 접근이나 외부 호출을 관측하지 않았다. 실제 검사에는 값이 출력되지 않는 격리 환경과 합성 자료를 사용한다. 이번 실행기 보강 자체가 운영 환경 전달 전체를 차단하거나 네트워크 호출 0회를 측정한 것으로 해석하지 않는다.
4. **검사와 CI 범위:** [test-all.ts](../../scripts/test-all.ts:2)는 domain과 PG만 실행한다. browser는 따로 선택해야 한다. Electron CI에는 타입·테스트 단계가 있지만 웹에 적용되지 않는다. CI 실패 검출, 필수 상태 검사와 병합 차단은 별개다. 기존 CI의 기본 checkout에서 git diff --check만으로 커밋된 PR 변경의 공백까지 확인했다고 단정하지 않는다.
5. **실제 제품 품질:** 운영 worker는 RUNTIME_PIPELINE_UNIMPLEMENTED로 중단하고, 품질 평가 계획 21건은 모두 NOT RUN이다. 제품의 업로드→다운로드, 새 이미지, 사람의 페이지 품질 합격은 미검증이다.

## 짧은 구현 설계와 검증 계획 — 아직 미실행

허용 후보 파일:

- docs/agent-harness.md: 이번 하네스 다음 작업과 기존 제품 다음 작업을 구분하고 조건·검사 표를 연결.
- scripts/test-postgres.ts: 실행별 신규 OS temp 증거 경로, 준비 순서, 성공/실패 기록과 정리 경계 보강.
- scripts/test-browser.ts: 기존 신규 temp 증거 방식 유지, 준비 순서와 정리·완료 판정 보강.
- tests/domain/test-runner-evidence.test.ts: 실제 runner 흐름과 실제 임시 파일의 보존·충돌·쓰기 오류를 확인하는 직접 회귀. PG/child fixture는 합성임을 명시하고 실제 프로세스 확인을 대체하지 않음.

공유 helper나 추가 파일이 필요해지면 그 필요와 범위를 먼저 설계에 반영한다. package.json, 잠금 파일, 제품 처리 코드, 전역 설정, 외부 스킬과 기존 출력물을 바꾸지 않는다. 결과는 기존 플랜에 기록하고 중복 원장을 만들지 않는다.

| 검사 | 명령 또는 확인 | 합격과 한계 |
| --- | --- | --- |
| 실패 재현→수정 후 회귀 | node node_modules/vitest/vitest.mjs run tests/domain/test-runner-evidence.test.ts | 실패 이유를 먼저 확인한 뒤 수정 후 통과. metadata 문구 존재나 mock 호출 하나만으로 자료 보존을 판정하지 않음 |
| 타입 | npm.cmd run typecheck | 타입 성공은 프로세스 정리나 제품 품질 증거가 아님 |
| 격리 PG의 선정 사례 | npm.cmd run test:postgres -- tests/postgres/execution.test.ts | 설치된 PG18·loopback·합성 계정/자료로 실행. 실제 서버·계정 접근과 구분 |
| 선정 브라우저 흐름 | npm.cmd run test:browser -- tests/browser/workspace.spec.ts --project=windows-chrome | 기존 지원 필터 TRIO_TEST_NAME_PATTERN에 uses actual pointer/keyboard flow를 명시. 지정 프로젝트에서 대상 테스트 1개가 실제 실행됐는지 확인. 실제 브라우저·합성 제공자 흐름이며 실제 번역 품질이 아님 |
| 자료와 범위 보존 | 기존 파일별 hash·최종 diff·문서 참조 대조 | 기존 증거와 허용 범위 외 변경 없음. 도구/자료 부족은 NOT RUN/BLOCKED로 남김 |

코드 변경 뒤 필요한 검사만 실행한다. 같은 소스·유효 환경의 검사를 이유 없이 반복하지 않고, 이 변경에 필요한 확인은 생략하지 않는다. 이번 조사에서는 위 테스트·build·PG/browser·native·모델·유료 API를 실행하지 않았다.

## 제품 개발의 다음 작업은 별도 유지

기존 플랜 10.121의 제품 다음 작업은 **작은 말풍선에서 한국어 종결 표현이 갈라지지 않는 공통 줄바꿈 후보의 최소 설계**다. 필요한 Carrot 공개 소스 비교를 연결하되, 이번 하네스 실행기 보강으로 그 작업이 완료되었다고 하지 않는다.

제품 설계 작업의 완료 조건은 고정 Carrot 커밋과 현재 Trio 근거, 공통 원인·후보 하나, 유지할 계약과 변경 범위, 동일 조건의 전후 비교와 별도 새 이미지 계획, 독립 검토 결과다. 기존 12쌍은 최종 PNG·cleanup·layout·9 glyph 산출물 쌍이며 12개 새 이미지 품질 검증이 아니다.

## 검토·출처·승인 경계

영상의 설명·챕터 확인은 이 대화의 앞선 조사 결과를 재사용했다. 자막 본문과 Boris Cherny의 정확한 발언은 미확인이다. 요약을 직접 인용으로 취급하지 않는다. 공식 검증 지침과 영상 주장의 세부 연결은 기존 agent-harness.md의 원출처를 따른다.

활성 설치본의 Superpowers brainstorming 14–20행은 구현 전 의도·설계 승인 경계를 둔다. 이번 짧은 설계와 성공 기준을 검토한 뒤 구현 단계로 진행한다. architect의 독립 검토는 사용자 승인이나 실제 검사 결과를 대신하지 않는다.

독립 검토: 실행기 우선 보강 방향은 적절하며, 준비·child·검사·기록·정리 실패와 명령별 검증을 구체화하라는 REVISE를 반영했다. 부분 기동 실패의 보장 제외와 환경 상속의 한계를 명시했다. 후속 검토에서 Playwright가 프로젝트·파일·제목을 합친 문자열에 필터를 적용하는 점이 확인되어 패턴의 시작 앵커를 제거했다. 대상 테스트 1개의 실제 실행을 인수조건에 포함했으며, 이 정정을 적용하면 독립 검토 GO라는 결과를 반영했다. 구현 승인은 아직 받지 않았다.

## 조사 시점의 파일 기준점

아래는 조사한 파일과 SHA-256이다. 민감한 설정 내용·자격 증명·프로젝트 자료를 보고서에 복사하지 않았다. 이 manifest는 조사 대상의 기준점이며 전체 의존성 closure나 실행 증명이 아니다.

| 파일 | SHA-256 |
| --- | --- |
| C:/Users/ksaei/.codex/AGENTS.md | 65947A375C62F9AF0BF7E1D16642C8FF5C959682151608B4C3301F4CFF5356CA |
| C:/Users/ksaei/.codex/config.toml | 635C706C409C60306DB4B920A16AFED90138865D89BCCC2A32A5404B8E8B8E36 |
| C:/Users/ksaei/.codex/agents/architect.toml | 4F1590EA2061ED0FD85D3D794306D0A76D231A8259040A5685F68D6808956FAF |
| C:/Users/ksaei/.codex/agents/worker.toml | 6AED604F547121808EDA081C3C31C4F024367CF62AD972DE655682EBFDFF960B |
| C:/Users/ksaei/.codex/.tmp/plugins/plugins/superpowers/skills/brainstorming/SKILL.md | 99476557E55F9DAA60BEE5BA350C2C2800FAE621C54F5ACA3C32ECB85F803A1A |
| C:/Users/ksaei/OneDrive/문서/trio-main/AGENTS.md | DF01600CA95828C964DB49F1E3053F8C27AE29C027F9A603AEE2EDAFA610353C |
| C:/Users/ksaei/OneDrive/문서/trio-main/docs/agent-validation.md | 971DE86AC40AD646B1E33282125F6710D2486E032609E8E81EDE049D9A17E9A6 |
| C:/Users/ksaei/OneDrive/문서/trio-main/.github/workflows/pr-02-a-validation.yml | 92AB1B7B4C92B0378AD4299175AB11481AFE71219589C1409E2FD1B346B84AE0 |
| C:/Users/ksaei/Documents/Codex/trio-manga-web/AGENTS.md | 4454234288661FDBF2F17DC224F14AAC2D5A62CB2DBD29D211D6CC7C5173FC8F |
| C:/Users/ksaei/Documents/Codex/trio-manga-web/docs/agent-harness.md | 6C25AF7595BC576DF0289748D36A2BBD1F1BD9317436443466FCAF448FD29A1A |
| C:/Users/ksaei/Documents/Codex/trio-manga-web/docs/source-reference.json | 2EE5AA7108D0AA1007A8655D9B55E97107B6929930A2681C593ED4FF2E31A98C |
| C:/Users/ksaei/Documents/Codex/trio-manga-web/package.json | E8746E6CD5DF6ADFAE03E04A30BBA9A7876AC1D24340C2B344268153E4D1B243 |
| C:/Users/ksaei/Documents/Codex/trio-manga-web/scripts/test-all.ts | 66387166C27C07BC7CD0A406BA098BB4972D7A7EAADCCC9155DC754BEC615626 |
| C:/Users/ksaei/Documents/Codex/trio-manga-web/scripts/test-postgres.ts | 25B3AFE9F90FC4CA123BCC9E98B76649EB5551E8ED8BF6449B8542CA88355EE8 |
| C:/Users/ksaei/Documents/Codex/trio-manga-web/scripts/test-browser.ts | BC038364143769A51EC56C10646585B454786B84D6B1B41C8BEEF5B025663969 |
| C:/Users/ksaei/Documents/Codex/trio-manga-web/docs/validation/postgres-environment.json | D1E562AF83167D3879B388CB807D9F63EEE01947EACD54AF724B09B610FC37A3 |
| C:/Users/ksaei/Documents/Codex/trio-manga-web/packages/operations/src/runtime-startup.ts | 76B63B542942EAD02D40A1CA841522BF373717654C2D10E13C4667C1A8EFB01A |
| C:/Users/ksaei/Documents/Codex/trio-manga-web/packages/contracts/schemas/quality-specimen-plan.json | 866030B22E39E82A914CEBF57F629959D79F8AECDCBB95FF9A95CA6B9C16270F |
