# P1-02 — Revision Journal 및 Stale Mutation 실행 계획

> **상태:** 실행 계획 확정, 구현·회귀 보강 대기  
> **범위:** 지연된 OCR·인페인팅 완료 Main patch와 저장되지 않은 사용자 편집이 같은 프로젝트 세션에서 만날 때의 보존·충돌 처리  
> **비범위:** provider 호출 구현, 작업 큐 도입, renderer의 새로운 merge UI 설계, P1-03 저장 복구 작업

## 1. 목표와 현재 기준선

P1-02의 목적은 오래된 renderer 요청을 무조건 거부하거나, 반대로 늦게 끝난 Main 처리 결과가 사용자의 저장 전 편집을 조용히 덮어쓰는 두 극단을 피하는 것이다. 현재 구현은 `projectSessions.ts`에서 세션별 연산을 직렬화하고, 사용자 mutation을 `pendingUserMutations`에 보존한 뒤 persisted snapshot 위에 다시 적용한다. Main patch가 먼저 저장된 후에도 replay가 성공하면 사용자 draft는 유지된다. replay할 수 없는 mutation이면 세션을 `needs_recovery`로 전환하고 Main snapshot만 반환한다.

`evaluateRevision()`은 요청의 `baseRevision` 이후 revision journal이 연속적이고, 요청 changed path와 후속 changed path가 겹치지 않을 때만 stale mutation을 rebase한다. 경로가 겹치거나 journal이 보존 범위를 벗어나면 `REVISION_CONFLICT`와 최신 DTO를 반환한다. journal은 현재 100개 entry로 제한된다.

| 책임 | 현 구현 위치 | P1-02에서 증명할 계약 |
| --- | --- | --- |
| stale 요청 판정 | `src/main/projectRevision.ts` | 연속 journal + 비중첩 경로만 rebase한다. |
| 사용자 draft 보존 | `src/main/projectReplay.ts` | persisted Main 결과 위에 pending mutation을 결정적으로 재생한다. |
| Main patch 저장·재생 | `src/main/projectSessions.ts` | Main 결과를 먼저 안전하게 저장하고, 사용자 draft replay 실패를 recovery 상태로 격리한다. |
| renderer 응답 | `applyProjectMutation()` 반환 DTO | 충돌 시 코드·최신 revision·최신 project·conflicting path를 모두 제공한다. |
| 회귀 proof | `tests/main/projectRevision.test.ts`, `tests/main/projectReplay.test.ts`, `tests/main/projectSessions.test.ts` | 인위적 지연 없이도 지연 완료 순서를 fixture로 정확히 모사한다. |

## 2. 작업 목록과 우선순위

| 순서 | 작업 | 변경 예상 범위 | 완료 기준 |
| --- | --- | --- | --- |
| 1 | 현재 changed path 표본을 mutation·Main patch별로 확정한다. | 테스트 fixture 및 본 문서 | 서로 다른 경로와 같은 경로의 판정 근거가 테스트 이름으로 추적된다. |
| 2 | non-conflict rebase 회귀를 추가한다. | `projectSessions.test.ts` | 지연 Main patch 뒤 stale 사용자 편집이 적용되고, revision은 단조 증가하며 draft가 남는다. |
| 3 | path conflict 회귀를 추가한다. | `projectSessions.test.ts`, 필요 시 `projectRevision.test.ts` | 동일 사용자 경로의 stale 요청이 `REVISION_CONFLICT`·latest DTO·실제 conflicting path를 반환하며 상태를 바꾸지 않는다. |
| 4 | journal 범위 초과 회귀를 추가한다. | `projectRevision.test.ts` 또는 session manager fixture | 가장 오래된 보존 revision 앞의 요청은 빈 conflict path와 함께 fail-closed한다. |
| 5 | delayed OCR·인페인팅 Main patch fixture를 추가한다. | `projectSessions.test.ts`, `projectReplay.test.ts` | Main 처리 완료가 사용자 draft·pipeline 사용자 필드를 조용히 덮어쓰지 않는다. |
| 6 | 발견된 계약 gap만 최소 수정한다. | 해당 source와 회귀 테스트 | 새 동작이 기존 session·save·recovery 테스트를 훼손하지 않는다. |

## 3. 테스트 시나리오

### 3.1 Non-conflict rebase

사용자가 revision `r`에서 `dialogueLines/<line-id>/userTranslation`을 수정하는 동안, OCR 또는 인페인팅 완료를 `commitMainProjectPatch()`로 뒤늦게 주입한다. Main patch는 `processing/*` 또는 다른 pipeline page 경로만 변경하도록 만든다. 사용자의 요청은 원래 `r`을 base로 보내되, Main patch의 저장 이후 도착하도록 지연한다.

| 확인 지점 | 기대 결과 |
| --- | --- |
| revision 판정 | `accepted`이며 `rebasedFrom: r`에 해당한다. |
| persisted snapshot | Main patch의 run·asset·approved asset 정보가 보존된다. |
| live snapshot | Main 결과와 pending user translation이 함께 존재한다. |
| 상태 | `dirty: true`, session `active`, revision이 이전 값보다 증가한다. |
| 저장 뒤 상태 | `saveProject()` 성공 시 pending mutation이 비워지고 persisted/live snapshot이 일치한다. |

### 3.2 Path conflict

사용자가 한 dialogue line의 `sourceText` 또는 `userTranslation`을 stale base로 변경하려 할 때, 같은 line 또는 상위 `dialogueLines/<line-id>` 경로를 변경하는 후속 user/Main 변경을 먼저 기록한다. 이 테스트는 path segment의 접두 관계가 충돌로 해석되는지 확인한다.

| 확인 지점 | 기대 결과 |
| --- | --- |
| 반환 상태 | `status: "revision_conflict"`, `code: "REVISION_CONFLICT"` |
| conflict 상세 | `conflictingPaths`에 실제 겹친 경로가 들어간다. |
| 최신 상태 | 반환된 DTO의 revision·project가 현재 세션과 동일하다. |
| 무결성 | 거절된 stale mutation은 `pendingUserMutations`, live project, dirty state를 바꾸지 않는다. |
| 사용자 경험 계약 | renderer는 최신 DTO를 제시할 수 있으며, 자동 overwrite를 수행하지 않는다. |

### 3.3 Journal 범위 초과

세션에서 100개를 넘는 무해한 revision을 만든 뒤, 보존된 첫 revision보다 오래된 base로 mutation을 보낸다. 단일 파일의 실제 OCR을 반복하지 않고 title·setting 등 빠른 fixture mutation으로 journal만 진행시킨다.

> 이 경우에는 과거 중간 변경을 신뢰성 있게 재구성할 수 없으므로, 빈 `conflictingPaths`의 `REVISION_CONFLICT`가 정상적인 fail-closed 결과다. 빈 배열은 “충돌 없음”이 아니라 “보존 journal 부족으로 안전한 rebase 불가”를 뜻한다.

| 확인 지점 | 기대 결과 |
| --- | --- |
| stale 판정 | rebase하지 않고 conflict를 반환한다. |
| 최신 DTO | 현재 revision·project가 포함된다. |
| 데이터 보존 | 요청 mutation은 적용되지 않으며 기존 pending draft는 유지된다. |
| 성능 경계 | journal은 100 entries를 초과해 축적되지 않는다. |

## 4. 지연 Main patch test seam

외부 OCR·인페인팅 provider를 테스트에서 호출하지 않는다. 대신 세션 테스트에 `Promise` gate를 두고, 다음 시간 순서를 재현한다.

1. `createProjectSession()`으로 saved file path가 있는 synthetic project를 만든다.
2. `deferredMainPatch` promise를 만든 뒤 Main 처리 시작을 상징하는 marker를 기록한다.
3. renderer가 `baseRevision: r`로 보낼 사용자 mutation을 준비한다.
4. promise를 resolve하여 `commitMainProjectPatch()`를 먼저 완료시킨다. OCR은 `merge_pipeline_dialogues`, 인페인팅은 `commit_processing_run` 또는 `approve_asset` patch로 표현한다.
5. 그 뒤 stale renderer mutation을 적용하고 DTO·revision journal·live project를 검증한다.
6. 동일 persistent region의 pipeline 갱신은 `projectReplay.test.ts` fixture로 분리하여 `speaker`, `lineStatus`, `referenceTranslation`, `userTranslation`, `notes` 보존을 검증한다.

이 seam은 시간 기반 sleep에 의존하지 않는다. 모든 순서는 promise resolution과 session queue의 완료를 `await`하여 결정적으로 고정한다.

## 5. 변경 경로 검토 포인트

현재 `merge_pipeline_dialogues` Main patch는 `dialogueLines/pipeline/<pageImageId>` 하나로 journal에 기록된다. 반면 renderer의 line 편집은 일반적으로 `dialogueLines/<line-id>/<field>` 형태다. P1-02 구현 단계에서는 아래 두 질문을 fixture로 먼저 검증한다.

| 질문 | 판단 기준 | 후속 조치 |
| --- | --- | --- |
| pipeline page-level 경로와 line-level 편집을 독립으로 취급해도 안전한가 | `persistentRegionId`가 같은 line에서 사용자 필드가 preserve되는가 | 안전하지 않다면 `changedPathsForMainPatch()`를 persistent region 또는 line 수준으로 좁히는 최소 수정 검토 |
| pipeline이 source text를 바꾸고 사용자가 source text도 편집했을 때 충돌을 보여야 하는가 | 보존 우선 정책과 renderer의 재검토 UX | 보여야 한다면 exact field-level Main changed path를 journal에 기록하고 conflict fixture 추가 |
| replay가 실패했을 때 pending draft를 어떻게 다룰 것인가 | `needs_recovery`가 DTO로 전달되고 persisted Main 상태가 저장되는가 | draft를 자동 폐기하지 않고 recovery UX·export 가능성은 별도 P1/P2 결정으로 기록 |

이 항목은 설계상 남은 판단이지, 현재 구현 결함을 전제하지 않는다. 먼저 fixture를 추가해 현 정책을 가시화하고, 실제 사용자 편집 소실 또는 불필요한 conflict가 재현될 때만 source를 수정한다.

## 6. 완료 기준 및 검증 명령

P1-02는 아래 네 조건이 모두 충족될 때 완료로 표시한다.

| ID | 완료 기준 | 증거 |
| --- | --- | --- |
| P102-A | non-conflict Main patch 뒤 pending 사용자 편집이 남는다. | 결정적 session replay 회귀 테스트 |
| P102-B | 같은 경로의 stale mutation은 `REVISION_CONFLICT`·최신 DTO와 함께 거절된다. | path conflict 회귀 테스트 |
| P102-C | 100-entry 밖의 base revision은 fail-closed한다. | bounded journal 회귀 테스트 |
| P102-D | 지연 pipeline 결과가 저장된 사용자 authored field를 조용히 덮어쓰지 않는다. | replay fixture 및 필요 시 session integration test |

구현 PR에서는 먼저 아래 범위로 빠르게 검증하고, 병합 전 전체 회귀와 typecheck를 실행한다.

```bash
npm test -- tests/main/projectRevision.test.ts tests/main/projectReplay.test.ts tests/main/projectSessions.test.ts
npm run typecheck
npm test
```

## 7. 위험·차단 조건

| 위험 또는 외부 결정 | 대응 |
| --- | --- |
| 실제 provider 결과의 필드 구조가 fixture와 달라질 수 있음 | provider payload를 그대로 mocking하지 말고 `MainProjectPatch` 계약만 fixture로 사용한다. |
| journal overflow가 정상 conflict로 오해될 수 있음 | renderer/UI에서 빈 `conflictingPaths`를 “새로고침 후 재시도 필요”로 설명하는 별도 copy 검토를 백로그에 남긴다. |
| replay 실패 시 사용자 draft 노출 정책이 확정되지 않음 | 자동 복구·자동 삭제를 추가하지 않는다. 현 `needs_recovery` 상태를 보존하고 product 결정을 blocker로 기록한다. |
| Windows 실장비 QA와의 충돌 | P1-02는 deterministic unit/integration fixture로 완료 가능하며, P1-01·P1-03 파일 시스템 QA와 독립적으로 진행한다. |
