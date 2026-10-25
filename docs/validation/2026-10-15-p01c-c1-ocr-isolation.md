# P01-C C1 OCR 기록 분리·실행 경계 검증 — 2026-10-15

**판정:** 승인한 10.150 C1의 공통 코드 구현과 격리된 연결 검증을 완료했다. 실제 외부 API·Python/모델 추론·운영 활성화는 하지 않았다. C2 비용 확정, C3 전체 runtime 조립, C4 취소/종료 연결, C5 네 단계 인수는 이번 완료에 포함하지 않는다.

**작업 유형:** 원인 분석·제품 개선·제품 검증(가짜 실행 포트·격리 PG의 C1 연결에 한정). 실제 웹 업로드→다운로드와 새로운 만화의 무보정 품질은 미검증이다.

**설계·기록:** [기존 plan 10.150/10.151](C:/Users/ksaei/OneDrive/문서/trio-main/docs/superpowers/plans/2026-10-02-manga-web-workspace-contracts-and-validation-plan.md:3299). Superpowers executing-plans·test-driven-development·systematic-debugging·requesting-code-review·verification-before-completion을 필요한 범위에 적용했다. 웹은 non-Git 루트이므로 기존 plan과 임시 원본/검사 로그를 사용하고 새 Git/worktree·중복 ledger·commit을 만들지 않았다.

**제품 변경 3곳**

| 파일 | 변경 |
| --- | --- |
| [pipeline-evidence.ts](../../packages/domain/src/pipeline-evidence.ts) | OCR만 LEGACY/PIPELINE_V1/LOCAL_OCR_V1으로 고정 매핑한다. 같은 계정 잠금 아래 과거/경쟁 owner 기록과 원 INPUT·current claim/lease를 확인한다. raw 최초 생성은 같은 outer·claim을 요구하며 candidate 없는 모호한 기록도 차단한다. |
| [local-ocr.ts](../../packages/providers/src/local-ocr.ts) | 기존 프로세스 실행을 별도 engine 포트로 연결한다. 기본 실행과 주입 포트를 모두 지원하며 기존 pin·지원 입력·원 CAPTURE/START/RAW/RESULT·출력 검증은 유지한다. |
| [local-ocr-executor.ts](../../packages/providers/src/local-ocr-executor.ts) | 기존 bounded/offline child 실행을 추출했다. 응답 deadline은 실제 close를 대신 해결하지 않으며 joined는 원 close·I/O·START 저장/통지 callback·post-pin 검증을 기다린다. host/subtree 종료와 비용 권한은 계속 미확인이다. |

**검사 변경 5곳:** tests/postgres/pipeline-evidence.test.ts, tests/domain/local-ocr.test.ts, 신규 tests/postgres/pipeline-ocr-composition.test.ts, 신규 tests/domain/local-ocr-executor.test.ts, tests/domain/operational-pipeline.test.ts. 마지막 파일은 이번 guard의 새 SELECT를 지원하도록 가짜 DB 조회 분기 한 줄만 추가했다. 기존 assertion·validation·제품 guard는 완화하지 않았다.

**직접 확인한 결과**

| 입력/실패 경계 | 관측한 결과 |
| --- | --- |
| 정상 요청으로 준비한 동일 INPUT 아래 outer/raw 중첩 OCR | 별도 candidate/source를 보존하고 가짜 process 제출·native prepare/apply는 각각 최초 1회다. 실제 ExecutionService START는 요청당 1회이며, 재생성/만료된 claim 조회는 원 결과·bytes/digest를 유지한다. |
| outer 또는 raw candidate commit ACK 유실 | 원 candidate를 보존하고 새 제출 0·준비/apply 0·무료 시작 0이다. outer만 남은 중단도 raw 최초 제출을 재개하지 않는다. |
| legacy/new owner 경쟁·candidate 없는 source | 정확한 owner의 기록만 읽는다. legacy/새 outer 경쟁은 하나만 허용하고, outer 이후 raw/legacy 경쟁은 raw만 최초 생성한다. 모호한 orphan 기록·외부 owner source는 보류하며 원 기록을 바꾸지 않는다. |
| 다른 단계·과거 기록 | TRANSLATE/CLEANUP/TYPESET의 OPERATIONAL kind와 legacy 조회를 유지한다. 기존 운영 처리·LaMa binding reader 회귀도 통과했다. |
| deadline·child close·I/O·START 저장/통지 지연 | 응답이 UNKNOWN으로 끝나도 joined는 실제 원 작업을 기다린다. 늦은 저장·통지 상태가 이미 반환한 receipt를 성공으로 바꾸거나 새 START를 발급하지 않는다. fullHostCostUsd:null·billingAuthority:false·subtreeTermination:UNCONFIRMED를 유지한다. |

**합성 범위:** PG 조립은 실제 제한 LOGIN·WorkspaceService 요청 → synthetic:true 정책/SyntheticProvider를 사용하는 ExecutionService의 authorize/preflight → 기존 OperationalPipelineProvider/TextStagesProvider/LocalOcrAdapter/executor 연결이다. 그 후 process·native·object store는 합성 포트다. 합성 페이지는 실제 만화 이미지가 아니고 OCR reply는 0개 탐지를 사용한다. 원본/폰트 metadata와 OWNED 검사 한도를 격리 DB에 준비했으며, 실제 운영 admission·전체 worker runtime·OCR 인식 성능을 증명하지 않는다. MEASURED라는 fixture 값도 실측·운영 권한이 아니다.

**최종 검증**

| 검사 | 결과 | 전용 로그 |
| --- | --- | --- |
| 관련 단위 4파일 | 169 통과, 이전 adapter 비교 1 skip | [unit](C:/Users/ksaei/AppData/Local/Temp/trio-p01c-c1-20261015-5bd1416ecc764a45a1a22de6bbef5f37/c1-final-unit.stdout.log) |
| 격리 PG 4파일 | 34 통과, PostgreSQL 18.6 | [PG](C:/Users/ksaei/AppData/Local/Temp/trio-p01c-c1-20261015-5bd1416ecc764a45a1a22de6bbef5f37/c1-final-pg.stdout.log) |
| TypeScript | exit 0 | [typecheck](C:/Users/ksaei/AppData/Local/Temp/trio-p01c-c1-20261015-5bd1416ecc764a45a1a22de6bbef5f37/c1-final-typecheck.json) |
| 변경 TS 8파일 ESLint | exit 0 | [lint](C:/Users/ksaei/AppData/Local/Temp/trio-p01c-c1-20261015-5bd1416ecc764a45a1a22de6bbef5f37/c1-final-lint.json) |

이전 adapter 비교는 TRIO_LOCAL_OCR_BEFORE_ADAPTER/TRIO_LOCAL_OCR_BEFORE_SHA256가 지정되지 않아 선택적으로 건너뛰었다. 이 비교를 통과로 계산하지 않는다. 각 최종 실행은 필수 OS 변수만 전달한 별도 프로세스에서 수행했고 운영 자격정보·활성화 변수·이전 비교 옵션·검사명 필터를 상속하지 않았다.

실제 실행 명령은 다음과 같다. 전용 실행기는 아래 Node 인자에 필수 OS 변수와 PG 경로만 전달했다.

    node node_modules/vitest/vitest.mjs run tests/domain/local-ocr.test.ts tests/domain/local-ocr-executor.test.ts tests/domain/pipeline-evidence.test.ts tests/domain/operational-pipeline.test.ts

    node node_modules/tsx/dist/cli.mjs scripts/test-postgres.ts tests/postgres/pipeline-evidence.test.ts tests/postgres/pipeline-ocr-composition.test.ts tests/postgres/operational-pipeline.test.ts tests/postgres/local-lama-binding-reader.test.ts

    node node_modules/typescript/bin/tsc --noEmit

    node node_modules/eslint/bin/eslint.js packages/domain/src/pipeline-evidence.ts packages/providers/src/local-ocr.ts packages/providers/src/local-ocr-executor.ts tests/postgres/pipeline-evidence.test.ts tests/domain/local-ocr.test.ts tests/postgres/pipeline-ocr-composition.test.ts tests/domain/local-ocr-executor.test.ts tests/domain/operational-pipeline.test.ts

TRIO_TEST_PG_BIN은 기존 PostgreSQL 18.6 bin을 사용했다. 새 임시 cluster는 127.0.0.1·무작위 자격정보·SCRAM·별도 DB를 사용했고 종료 후 postmaster.pid 부재와 검사 exit 0을 확인했다. 기존 실행기의 realProviderCalls:0 고정 문구만을 외부 차단 증거로 쓰지 않았다. 실제 모델 대신 child_process fake를 사용했고 새 조립 검사에서 fetch는 금지 포트다.

**실패와 수정의 구분:** 제품 수정 전 owner 미분리 회귀 8개와 engine 주입 회귀 1개의 실패를 확인했다. 최초 새 조립 검사의 OWNED 기간·FilePin/타입 오류는 fixture만 기존 계약에 맞게 수정했다. 넓힌 회귀의 UNEXPECTED_OWNED_SQL 10개는 기존 가짜 DB가 새 조회를 몰랐기 때문에 위 한 줄을 추가했다. 제품의 제한이나 assertion을 약화하지 않고 최종 회귀를 재확인했다.

**보존·독립 검토:** 소스/핵심 기존 문서 792개를 대조해 허용 범위 밖 변경 0, 기존 plan prefix 1046323바이트 보존, 변경 TS 8파일 UTF-8·diff whitespace 정상이다. 최종 소스 manifest digest는 2d67a08693a0d38d34003283f0a78208ed5ed00793d3b54dab5ddf286c33a56c다. [구조화 검증 근거](C:/Users/ksaei/AppData/Local/Temp/trio-p01c-c1-20261015-5bd1416ecc764a45a1a22de6bbef5f37/c1-final-evidence.json)에 여덟 파일 SHA-256·종료 코드·격리 PG 종료 근거가 있다. architect는 추가 orphan/동시 경쟁/START 저장 지연 회귀까지 읽고 Critical·Important 지적 및 필수 수정 없음으로 판정했다. 독립 코드 검토는 테스트와 운영 승인을 대체하지 않는다.

**미실행·다음 경계:** 실제 모델/외부 API, 운영 admission·전체 runtime, 물리 host/subtree 종료, 일반 worker 활성화, 브라우저 품질·새 만화 인수, 패키징/build·배포는 NOT RUN이다. adapter의 joined를 runtime 종료 대기에 연결하는 것은 C4 범위다. 다음 구현 단위는 C2이며 이번 작업에서는 시작하지 않았다.
