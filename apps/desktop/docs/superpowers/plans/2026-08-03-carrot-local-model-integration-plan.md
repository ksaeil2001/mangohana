# Trio × Carrot 로컬 처리 전체 통합 계획

> 2026-09-17 범위 갱신: 이 문서의 macOS 항목은 **non-MVP / future scope**이며 현재 MVP 지원이나 Release Gate 요구가 아닙니다. Linux 범위는 변경하지 않습니다. [현재 플랫폼 정책](../../operations/mvp-platform-scope.md)을 우선합니다.
> 이전 시점의 실행 결과와 gate 상태는 역사적 기록이며 현재 후보 판정은 [최신 Release Gate 보고서](../../release/2026-09-17-mvp-release-gate.md)를 따릅니다.

> 상태: 구현 진행 중 — `TRIO-UI-00`, `TRIO-UI-01` 완료
> 작성일: 2026-08-03
> 대상: Windows x64 데스크톱 앱
> 기준 프로젝트: `ucx0204/CarrotMangaTranslator`
> 상위 계획: `2026-08-02-trio-system-overhaul-review.md`
> UI 상세 계획: `2026-08-03-install-compare-ocr-review-design-plan.md`

## 1. 목표와 완료 모습

Trio에 CarrotMangaTranslator가 사용하는 로컬 처리 범위를 단계적으로 도입한다. 최종 범위에는 로컬 Gemma 번역, PaddleOCR, AOT·LaMa·Flux 인페인팅, 모델·런타임 자동 설치와 관리가 모두 포함된다.

완료 후 사용자는 다음 흐름으로 작업한다.

1. 로컬 기능을 처음 사용할 때 앱이 하드웨어와 저장 공간을 검사한다.
2. 앱이 적합한 모델을 추천하고 용량·출처·라이선스를 보여준다.
3. 사용자가 동의하면 앱이 공식 원본에서 파일을 내려받아 검증하고 설치한다.
4. 번역·OCR·인페인팅은 Main 프로세스가 관리하는 격리된 자식 프로세스에서 실행된다.
5. AI 결과는 초안 또는 파생 이미지로 보관되며 사용자의 기존 수정 내용을 자동으로 덮어쓰지 않는다.
6. 설치가 끝난 뒤에는 네트워크 연결 없이 로컬 처리할 수 있다.

이 계획의 핵심 성공 조건은 “모든 기능을 한 번에 완성”이 아니라 다음 네 단계를 각각 독립적으로 사용할 수 있게 출시하는 것이다.

```text
[공통 설치·관리 기반]
          |
          v
[로컬 번역 사용 가능]
          |
          v
[PaddleOCR 사용 가능]
          |
          v
[AOT·LaMa·Flux 인페인팅 사용 가능]
          |
          v
[AMD 지원과 운영 안정화]
```

## 2. 확정된 제품 결정

| 번호 | 결정 | 확정 내용 |
|---|---|---|
| D1 | 구현 범위 | 최종 범위는 유지하되 `공통 기반 → 번역 → OCR → 인페인팅`으로 단계 출시 |
| D2 | 배포 출처 | Trio가 서명한 카탈로그로 버전·해시를 고정하고 파일은 공식 원본에서 직접 다운로드 |
| D3 | 실행 구조 | Electron Main이 모듈별 자식 프로세스를 시작·중지하는 `LocalRuntimeManager` 소유 |
| D4 | 초기 하드웨어 | Windows x64의 NVIDIA CUDA와 CPU 폴백 우선, AMD는 후속 안정화 단계 |
| D5 | 설치 시점 | 기능을 처음 사용할 때 필요한 구성만 사용자 동의 후 설치 |
| D6 | 번역 모델 | 하드웨어 자동 추천, 사용자가 12B·26B·31B를 경고 후 변경 가능 |
| D7 | 업데이트 | 새 버전 자동 확인, 설치·전환은 사용자 승인, 작업 기록에는 사용 버전 보존 |
| D8 | 번역 결과 | `aiTranslation`은 읽기 전용 초안, 선택 범위에 `userTranslation`으로 복사 |
| D9 | OCR 결과 | 고신뢰 결과 자동 반영, 저신뢰·충돌 결과는 예외 검토함으로 이동 |
| D10 | 인페인팅 | 영역 유형별 엔진 자동 추천, 사용자 변경 가능, 원본 비파괴 미리보기 후 승인 |
| D11 | 클라우드 관계 | Gemini·OpenAI 유지, 로컬 우선 추천, 로컬 실패 시 자동 클라우드 전환 금지 |
| D12 | 테스트 | 일반 CI는 가짜 실행기와 골든 픽스처, 실제 모델은 Windows CPU/NVIDIA 릴리스 게이트 |
| D13 | 저장소 | `%LOCALAPPDATA%\Trio\resources` 기본, 첫 설치 전 다른 드라이브 선택과 안전한 이동 지원 |
| D14 | 동시 실행 | 무거운 GPU 작업은 한 번에 하나만 실행하고 중앙 큐에서 취소·순서 관리 |
| D15 | 대용량 다운로드 | 기존 리소스 팩 다운로더는 보존하고 Range 재개 전용 다운로더를 별도 추가 |
| D16 | 카탈로그 배포 | 기본 서명 카탈로그는 앱에 포함하고 갱신본과 서명은 Trio GitHub Releases에 게시 |

## 3. 범위

### 포함

- Windows x64 공통 모델·런타임 카탈로그, 설치, 검증, 복구, 제거, 업데이트 확인
- 12B 우선 로컬 번역과 후속 26B·31B 프리셋
- PaddleOCR CPU 및 NVIDIA 실행 경로
- AOT·LaMa 빠른 인페인팅과 Flux 정밀 인페인팅
- 설치 진행률, 취소, 재개, 저장 위치 변경, 디스크 사용량 표시
- 하드웨어 검사와 모델 추천
- Main 소유 작업 큐, 런타임 생명주기, 종료 정리, 오류 코드
- AI 초안과 사용자 번역의 분리 표시 및 범위별 적용
- OCR 예외 검토함과 인페인팅 비파괴 승인
- 실제 모델 호환성 검증과 라이선스 고지
- 기능 안정화 후 AMD 런타임 도입

### NOT in scope

- Carrot 소스나 GPL 실행 파일을 Trio에 복사·번들링하는 작업: 라이선스 경계를 분리한다.
- Trio가 모델과 런타임 파일을 재호스팅하는 작업: 초기에는 공식 원본 직접 다운로드만 사용한다.
- 사용자 동의 없는 백그라운드 대용량 다운로드 또는 자동 업데이트: 용량과 결과 재현성을 보호한다.
- 로컬 실패 시 Gemini·OpenAI로 자동 전환: 민감한 이미지와 대사의 외부 전송을 방지한다.
- macOS·Linux 지원: 현재 제품과 검증 환경이 Windows x64다.
- 첫 안정판에서 AMD 동시 지원: 기능 안정화 후 별도 하드웨어 단계로 제공한다.
- DFlash 추측 디코딩: 기본 12B·26B·31B 번역 경로가 안정화된 뒤 벤치마크로 판단한다.
- 모델 학습·파인튜닝·데이터 수집: 이 계획은 추론과 편집 워크플로만 다룬다.
- 전체 자동 식자 엔진 재작성: 상위 시스템 개편 계획의 `TextRegion`·레이아웃 작업과 연결하되 이 계획의 런타임 범위와 분리한다.

## 4. 이미 존재하며 재사용할 것

| 기존 코드 | 현재 역할 | 계획에서의 처리 |
|---|---|---|
| `src/shared/pipelineResources.ts` | 리소스 역할, 파일 크기·SHA-256, 라이선스 파일, 잠금 파일 계약 | 작은 서명 리소스 팩에는 그대로 사용하고 대형 아티팩트 카탈로그 설계의 기준으로 재사용 |
| `src/main/cmsSignatureVerifier.ts` | CMS 서명과 고정된 게시자 인증서 검증 | Trio 카탈로그와 매니페스트 신뢰 검증에 재사용 |
| `src/main/resourcePackInstaller.ts` | 임시 설치, 검증, 원자적 전환, 실패 정리 | 작은 압축 리소스에 유지하고 대형 모델 설치의 트랜잭션 패턴만 재사용 |
| `src/main/resourcePackDownloader.ts` | HTTPS·리디렉션·시간·크기 제한 다운로드 | 4GB 이하 기존 경로는 변경하지 않고 URL·오류 정책만 새 다운로더가 참고 |
| `src/main/resourcePreflight.ts` | 설치 파일 무결성, 신뢰 루트, 플랫폼 프로브 | 각 로컬 기능 실행 직전의 검증 게이트로 확장 |
| `src/main/sidecarIntegrity.ts` | 실행 파일 세트 무결성 검사 | llama.cpp·Paddle·인페인팅 실행기 검증에 재사용 |
| `src/main/projectSessions.ts` | Main 소유 프로젝트 세션과 저장 | AI 초안, OCR 결과, 인페인팅 승인 결과의 유일한 커밋 경로로 유지 |
| `src/shared/projectTypes.ts` | `aiTranslation`, `userTranslation`, 처리 실행, 파생 이미지 | 새 병렬 데이터 저장소를 만들지 않고 선택적 출처 필드를 추가해 재사용 |
| `src/main/inpaintingAssets.ts` | 원본을 보존하는 파생 이미지 기록 | 로컬 인페인팅 결과도 같은 저장·승인 흐름 사용 |
| `electron/preload.ts`와 `src/renderer/electronApi.ts` | 제한된 Renderer API | 임의 경로나 명령 문자열을 노출하지 않는 형식화된 로컬 처리 API 추가 |

### 현재 공백과 선행 문제

1. 리소스 설치 코드는 Main 초기화·IPC·Renderer에 아직 연결되지 않았다.
2. 기존 다운로더는 최대 4GB이고 실패 시 부분 파일을 지우므로 대형 모델 재개에 맞지 않는다.
3. 로컬 프로세스 관리자, 작업 큐, 종료 시 자식 프로세스 정리가 없다.
4. `LineDetailPanel`은 AI 번역을 편집 가능하게 보이지만 사용자 mutation은 `aiTranslation`을 저장하지 않아 UI와 Main 소유권이 불일치한다.
5. 인페인팅 공급자 타입은 현재 `openai | gemini`만 지원한다.
6. 전체 테스트는 `.worktrees/**`까지 수집하는 문제와 Windows 파일 잠금 정리 실패가 있어 릴리스 기준선부터 안정화해야 한다.

## 5. 라이선스와 공급망 원칙

Carrot는 동작과 구성 후보를 조사하는 참고 구현으로만 사용한다. Carrot 앱 자체는 GPL-3.0이며 제3자 런타임과 모델은 각각 별도 라이선스를 가지므로, Trio는 Carrot의 코드나 릴리스 바이너리를 복사하지 않는다.

참고 자료:

- [CarrotMangaTranslator](https://github.com/ucx0204/CarrotMangaTranslator)
- [Carrot 제3자 고지](https://github.com/ucx0204/CarrotMangaTranslator/blob/main/THIRD_PARTY_NOTICES.md)
- [llama.cpp 릴리스](https://github.com/ggml-org/llama.cpp/releases)
- [PaddleOCR](https://github.com/PaddlePaddle/PaddleOCR)

Trio의 서명 카탈로그 항목은 최소 다음 정보를 가진다.

```text
artifactId, capability, version, upstreamUrl, upstreamRevision,
byteSize, sha256, licenseId, licenseUrl, noticeFiles,
platform, accelerator, dependencies, compatibilitySet, revoked
```

### 카탈로그 배포

```text
앱에 포함된 bootstrap catalog + signature
                    |
                    +-- 오프라인/첫 실행의 신뢰 가능한 기준
                    |
                    v
Trio GitHub Release의 catalog.json + catalog.p7s
                    |
                    +-- 서명·schema·증가하는 catalogVersion 검증
                    |
                    v
공식 upstream URL에서 실제 모델·런타임 다운로드
```

- 앱에는 해당 앱 버전에서 검증한 bootstrap 카탈로그와 서명을 포함한다.
- 갱신본은 Trio GitHub Releases의 버전 고정 asset으로 게시한다. `latest` 리디렉션은 발견 용도로만 사용하고, 실제로 선택된 release와 asset의 식별자를 기록한다.
- 원격 카탈로그가 없거나 검증에 실패하면 bootstrap 또는 마지막으로 검증된 카탈로그를 계속 사용한다.
- 낮은 `catalogVersion`, 알 수 없는 schema, 서명 불일치, 동일 버전의 다른 내용은 거부한다.
- GitHub 장애는 새 설치·업데이트 확인만 막고 이미 설치한 로컬 추론은 막지 않는다.
- 카탈로그 생성·서명·게시·롤백은 스크립트와 release workflow로 재현 가능해야 한다. 실제 `.github/workflows` 또는 배포 설정 변경은 구현 단계에서 별도 승인을 받는다.

카탈로그 게시 전 체크리스트:

1. URL이 공식 프로젝트나 원 모델 제공자의 배포 위치인지 확인한다.
2. 태그·revision·파일명을 고정하고 `latest` URL을 사용하지 않는다.
3. 파일 전체 SHA-256과 크기를 독립적으로 계산한다.
4. 사용·실행·수정·재배포 조건과 추가 사용 제한을 검토한다.
5. 라이선스 또는 모델 카드가 바뀌면 기존 동의를 자동 승계하지 않는다.
6. 서명된 카탈로그에서 철회된 아티팩트는 새 작업 실행을 차단한다.
7. 직접 다운로드 방식이라도 라이선스와 고지 문서를 로컬 설치 기록에 보존한다.

초기 후보 세트는 Carrot의 현재 프리셋을 출발점으로 삼되, 아래 값은 카탈로그 게시 시 다시 검증한다.

| 기능 | 후보 |
|---|---|
| 번역 12B | `culturerevolt/gemma-4-12b-heretic-abliterated-GGUF` + `ggml-org/gemma-4-12B-it-GGUF` mmproj |
| 번역 26B | `mradermacher/gemma-4-26B-A4B-it-ultra-uncensored-heretic-i1-GGUF` + 대응 mmproj |
| 번역 31B | `mradermacher/gemma-4-31B-it-The-DECKARD-HERETIC-UNCENSORED-Thinking-i1-GGUF` + 대응 mmproj |
| OCR | PaddlePaddle/PaddleOCR 런타임, PP-DocLayoutV3, PaddleOCR-VL-1.6, PP-OCRv6 det/rec |
| 빠른 인페인팅 | `mayocream/aot-inpainting`, `mayocream/lama-manga` |
| 정밀 인페인팅 | `unsloth/FLUX.2-klein-4B-GGUF`, FLUX decoder, 대응 텍스트 인코더 |

## 6. 목표 아키텍처

```text
 Renderer (신뢰하지 않는 UI 입력)
    |
    | typed IPC: install / status / enqueue / cancel / approve
    v
+-------------------------------------------------------------------+
| Electron Main                                                     |
|                                                                   |
|  LocalArtifactCatalog ---- CMS signature / revocation             |
|           |                                                       |
|           v                                                       |
|  LargeArtifactDownloader --> staging --> SHA-256 --> ResourceStore|
|           |                                     |                 |
|           +--> progress / pause / resume         v                 |
|                                            HardwareProfile         |
|                                                  |                 |
|  ProjectSessionManager <--- result commit --- LocalJobQueue        |
|                                                  |                 |
|                                           LocalRuntimeManager      |
+-------------------------------------------+-----------+-----------+
                                            |           |
                       +--------------------+           +------------------+
                       v                                                   v
            llama.cpp child process                         Paddle/Python child process
                       |
                       +------------------------+
                                                v
                                      AOT / LaMa / Flux runners

네트워크 사용: 카탈로그 확인과 설치·업데이트에만 사용
추론 데이터: 로컬 자식 프로세스와 loopback 통신에만 사용
```

### 의존 방향

```text
shared contracts
      ^
      |
main catalog/store/runtime/project ownership
      ^
      |
preload allowlist
      ^
      |
renderer views and commands
```

Renderer는 실행 파일 경로, 임의 URL, 포트, 셸 인자 또는 저장소 절대 경로를 Main에 전달할 수 없다. Renderer는 `capability`, `presetId`, `projectSessionId`, `targetIds`처럼 검증 가능한 식별자만 전달한다.

### 모듈 경계

| 모듈 | 책임 |
|---|---|
| `shared/localArtifacts.ts` | 카탈로그·설치 상태·오류 코드의 순수 타입과 검증 |
| `shared/localProcessing.ts` | 작업 요청·진행률·취소·결과·출처 계약 |
| `main/largeArtifactDownloader.ts` | Range 청크 다운로드, 재개 메타데이터, 전체 해시 검증 전 단계 |
| `main/localArtifactInstaller.ts` | 동의, 공간 검사, staging, 검증, 원자적 설치, repair/remove |
| `main/localResourceStore.ts` | 버전별 위치, 활성 버전, 롤백 버전, 이동과 정리 후보 계산 |
| `main/hardwareProfile.ts` | Windows CPU·RAM·GPU·VRAM·디스크 검사와 추천 입력 |
| `main/localJobQueue.ts` | 하나의 대형 GPU 작업, FIFO, 취소, 상태 전이 |
| `main/localRuntimeManager.ts` | 자식 프로세스 시작·health·lease·종료·비정상 종료 복구 |
| `main/adapters/*` | llama.cpp, PaddleOCR, AOT·LaMa·Flux별 프로토콜 변환 |
| `main/localProcessingIpc.ts` | IPC 인자 검증과 Main 서비스 연결 |
| Renderer 설정/작업 패널 | 설치 동의, 진행률, 모델 추천, 결과 비교·적용 |

새 모듈은 상태를 숨긴 클래스보다 명시적인 factory와 작은 인터페이스를 우선한다. `App.tsx`에 다운로드·프로세스·큐 상태를 직접 추가하지 않는다.

## 7. 상태와 데이터 계약

### 설치 상태

```text
not_installed
      |
      v
awaiting_consent --> downloading <--> paused
                         |
                         v
                      verifying
                      /       \
                     v         v
                 installed    failed
                     |
                     v
                    ready

failed --retry--> downloading 또는 verifying
corrupt --repair--> staging에서 새로 검증
```

부분 파일은 `staging/<transactionId>` 아래에서만 관리한다. 설치 완료 표시는 전체 해시, 카탈로그 서명, 의존성, 실행 프로브가 모두 통과한 뒤 원자적 디렉터리 전환이 성공했을 때만 기록한다.

### 작업 상태

```text
queued -> preparing -> starting_runtime -> running -> committing -> completed
   |          |               |             |            |
   +----------+---------------+-------------+------------+--> cancelling -> cancelled
                              |
                              +----------------------------> failed
```

모든 상태 전이는 Main에서만 일어난다. Renderer를 닫거나 화면을 이동해도 작업 소유권은 사라지지 않는다.

### 프로젝트 기록

기존 `schemaVersion: 2` 구조를 유지하고 선택적 출처 필드만 추가하는 최소 변경을 권장한다. 기존 프로젝트는 필드가 없으면 정상적으로 열린다. 실제 타입·검증 변경은 구현 시작 시 스키마 변경 승인을 다시 받은 뒤 진행한다.

예상 출처 정보:

```ts
type LocalResultProvenance = {
  provider: "local";
  capability: "translation" | "ocr" | "inpaint";
  engineId: string;
  engineVersion: string;
  resourceVersions: Record<string, string>;
  promptProfileVersion?: string;
  sourceFingerprint: string;
  generatedAt: string;
};
```

- 번역: `aiTranslation`과 선택적 provenance는 전용 Main 명령으로 함께 커밋한다.
- OCR·인페인팅: 기존 `ProcessingRunRecord`와 파생 이미지에 선택적 엔진·리소스 버전을 기록한다.
- 사용자 mutation은 `aiTranslation`이나 provenance를 직접 쓸 수 없다.
- AI 재실행은 `userTranslation`을 수정하지 않는다.
- 원문 또는 입력 이미지 fingerprint가 바뀌면 이전 결과를 `stale`로 표시하고 자동 적용하지 않는다.

### 번역 적용 규칙

```text
AI 초안 (읽기 전용) --사용자 적용--> 사용자 번역 (편집 가능)
        |                                  |
        +--재실행 가능                     +--기본 덮어쓰기 금지
```

지원 범위:

- 현재 대사
- 사용자가 체크한 대사
- 현재 페이지의 미번역 대사
- 프로젝트 전체 미번역 대사

기존 `userTranslation`이 비어 있지 않은 항목은 기본 적용 대상에서 제외한다. 덮어쓰기를 선택하면 대상 수와 이전 내용 보존 방식을 확인한다.

## 8. 자동 설치와 업데이트 UX

### 첫 사용

1. 사용자가 로컬 번역, OCR 또는 인페인팅을 선택한다.
2. 앱이 현재 설치 상태와 하드웨어를 검사한다.
3. 추천 프리셋, 예상 다운로드 크기, 설치 후 크기, 필요 메모리, 출처, 라이선스를 표시한다.
4. 사용자가 저장 위치와 프리셋을 확인한다.
5. 다운로드는 취소·일시 정지·앱 재실행 후 재개할 수 있다.
6. 검증이 끝나면 실행 프로브를 수행하고 기능을 활성화한다.

### 업데이트

- 앱 시작을 막지 않는 저빈도 카탈로그 확인을 사용한다.
- 새 버전은 자동 다운로드하지 않는다.
- 변경 내용, 추가 용량, 라이선스 변경, 호환성 세트를 보여주고 사용자가 승인한다.
- 활성 작업은 시작할 때 선택한 버전을 끝까지 유지한다.
- 업데이트 실패 시 기존 활성 버전을 계속 사용한다.
- 사용 중 버전과 직전 롤백 버전은 자동 삭제하지 않는다.
- 철회된 파일은 새 작업 실행을 차단하고 안전한 교체 방법을 안내한다.

### 저장소 이동

```text
새 위치 공간 검사
   -> 설치 파일 복사
   -> 전체 해시 재검증
   -> 활성 포인터 전환
   -> 이전 위치를 정리 후보로 표시
```

검증 전에는 기존 위치를 삭제하지 않는다. 정리도 사용자가 승인한 정확한 버전 디렉터리에만 수행한다.

## 9. 런타임 정책

### 공통

- Main만 설치된 실행 파일을 시작할 수 있다.
- 실행 파일과 모든 의존 파일은 시작 직전에 preflight한다.
- 작업마다 임시 loopback 포트와 인증 토큰을 사용한다.
- 자식 프로세스에는 필요한 환경 변수만 전달하고 API 키나 전체 부모 환경을 복사하지 않는다.
- stdout/stderr는 크기를 제한하고 경로·프롬프트·이미지·대사 전문을 로그에 남기지 않는다.
- 앱 종료, 업데이트, 취소 시 정상 종료를 먼저 시도하고 제한 시간 이후 프로세스 트리를 정리한다.
- 예상하지 못한 프로세스 종료는 현재 작업만 실패시키고 프로젝트 세션은 유지한다.

### 번역

- llama.cpp의 고정된 Windows 릴리스와 해당 모델·mmproj를 하나의 `compatibilitySet`으로 검증한다.
- 첫 출시 프리셋은 12B이며 실제 장비 검증 뒤 26B와 31B를 같은 계약으로 추가한다.
- 하드웨어 추천은 실행 가능성의 보증이 아니라 사전 경고다. 첫 로드 실패 시 GPU layer 축소 또는 CPU 폴백을 제안한다.
- `/health`와 OpenAI 호환 채팅 엔드포인트를 사용하되 API 표면은 adapter 밖으로 노출하지 않는다.

### PaddleOCR

- CPU와 NVIDIA 런타임을 별도 아티팩트 세트로 관리한다.
- layout, detection, recognition, optional VL 모델을 개별 리소스로 고정한다.
- 고신뢰 결과만 새 대사 초안으로 반영하고 다음 항목은 예외 검토함으로 보낸다.
  - 낮은 문자 또는 영역 신뢰도
  - 겹치는 영역과 중복 텍스트
  - 읽기 순서 충돌
  - 빈 문자열 또는 지원하지 않는 문자 비율 초과
  - 기존 사용자 확정 영역과 충돌
- 상위 계획의 `TextRegion`이 도입되기 전에는 기존 `DialogueLineV2.origin`과 OCR 후보 계약을 사용하며, 병렬 임시 모델을 만들지 않는다.

### 인페인팅

- 말풍선·캡션에는 AOT 또는 LaMa를 빠른 기본값으로 추천한다.
- 복잡한 배경 문자에는 Flux 정밀 모드를 추천한다.
- 사용자는 실행 전에 엔진을 바꾸거나 결과 후보를 비교할 수 있다.
- 원본 이미지는 수정하지 않는다. 결과는 기존 파생 이미지 저장 흐름에 기록한다.
- 승인된 결과만 `approvedCleanedAssetId`로 전환한다.
- 로컬 실패 시 클라우드 공급자로 자동 전환하지 않는다.

## 10. 오류와 복구 계약

오류는 사용자에게 보여줄 안정된 코드와 내부 원인을 분리한다. 추천 접두사는 다음과 같다.

```text
CATALOG_*     카탈로그 서명·버전·철회
ARTIFACT_*    다운로드·공간·해시·설치·이동
RUNTIME_*     실행기 시작·health·종료·호환성
JOB_*         큐·취소·stale·커밋
TRANSLATION_* 번역 응답·형식·메모리
OCR_*         layout·인식·후보 변환
INPAINT_*     마스크·출력·파생 이미지
```

| 실패 | 시스템 동작 | 사용자 복구 | 보존되는 것 |
|---|---|---|---|
| 카탈로그 연결 실패 | 설치·업데이트만 중지 | 나중에 재시도 | 이미 검증된 설치와 오프라인 추론 |
| 서명 또는 해시 불일치 | 파일을 활성화하지 않음 | 다시 다운로드, 계속 실패하면 공급원 신고 | 기존 활성 버전 |
| 다운로드 중 앱 종료 | 청크 메타데이터를 원자적으로 저장 | 다음 실행에서 재개 | 검증된 청크 |
| 서버가 Range를 지원하지 않음 | 단일 스트림으로 명시적 재시작 제안 | 사용자 승인 후 처음부터 다운로드 | 기존 설치 |
| 디스크 부족 | 다운로드 시작 전 또는 쓰기 중 중단 | 위치 변경·정리 후 재개 | 프로젝트와 완료 청크 |
| 백신·파일 잠금 | 제한된 재시도 후 실패 | 잠금 원인 안내와 repair | 기존 활성 버전 |
| 런타임 health 시간 초과 | 자식 프로세스 종료 | 재시도·CPU 폴백·다른 프리셋 | 프로젝트와 설치 파일 |
| GPU 메모리 부족 | 현재 작업 실패, 다음 큐는 보류 | layer 축소·12B·CPU 제안 | 기존 AI 초안과 사용자 번역 |
| 작업 중 입력 변경 | 결과 커밋 금지, stale 표시 | 새 입력으로 재실행 | 사용자 변경 |
| OCR 일부 실패 | 성공 후보와 실패 후보를 분리 | 실패 영역만 재실행·수정 | 성공 결과와 기존 확정 영역 |
| 인페인팅 출력 오류 | 파생 결과 승인 금지 | 마스크 수정·엔진 변경 | 원본 이미지 |
| 로컬 처리 실패 | 클라우드 자동 전환 금지 | 사용자가 명시적으로 공급자 선택 | 개인정보 경계 |

## 11. 성능과 자원 예산

### 실행 정책

- 번역·PaddleOCR GPU·Flux는 기본적으로 하나의 `heavy-gpu` 큐를 공유한다.
- AOT·LaMa·CPU OCR의 병렬 허용 여부는 실제 벤치마크 뒤 정한다.
- 런타임 전환 시 이전 lease를 해제하고 프로세스 종료와 VRAM 회수를 확인한 뒤 다음 작업을 시작한다.
- 모델을 일정 시간 유지하는 warm 정책은 고정값을 추측하지 않고 12B·OCR·Flux 로드 시간과 유휴 메모리를 측정해 결정한다.

### 다운로드 정책

- Carrot의 16MiB 청크·동시성 4 설정을 초기 벤치마크 후보로만 사용한다.
- 서버 응답, 디스크 속도, 오류율에 따라 동시성을 낮출 수 있어야 한다.
- `.partial` 메타데이터는 URL만 신뢰하지 않고 artifact ID·version·size·hash와 묶는다.
- 최종 파일은 순차 전체 SHA-256을 다시 계산한다.
- 예상 파일 크기 외에 staging, 추출, 롤백 공간을 포함한 여유 공간을 사전 계산한다.

### 측정 항목

| 영역 | 측정값 |
|---|---|
| 설치 | 총 크기, 재개 성공률, 해시 시간, 실패 후 잔여 공간 |
| 번역 | 첫 토큰 시간, 문장 처리량, 피크 RAM·VRAM, 취소 지연 |
| OCR | 페이지 p50/p95, 영역 recall, 문자 오류율, 피크 RAM·VRAM |
| 인페인팅 | 엔진별 p50/p95, 마스크 경계 품질, 원본 훼손률, 피크 RAM·VRAM |
| 큐 | 대기시간, 런타임 전환시간, 취소 후 자원 회수시간 |

측정 로그에는 원문·번역·이미지 내용이 아니라 시간, 크기, 오류 코드, 익명화된 리소스 ID만 기록한다.

## 12. 테스트 전략

```text
                         +-----------------------------+
                         | 실제 Windows 릴리스 검사   |
                         | CPU + NVIDIA + 실제 모델    |
                         +--------------+--------------+
                                        ^
                         +--------------+--------------+
                         | 작은 골든 이미지·결과 검사 |
                         | OCR / mask / derived asset  |
                         +--------------+--------------+
                                        ^
            +---------------------------+---------------------------+
            | 단위·계약·IPC 테스트                                   |
            | fake downloader / fake runner / fake clock / fake disk |
            +-------------------------------------------------------+
```

### 공통 기반 테스트

- `tests/main/largeArtifactDownloader.test.ts`
  - 중단 뒤 Range 재개, 청크 손상 재다운로드, redirect, timeout, 취소, 4GB 초과 크기 메타데이터
  - Range 미지원 서버, ETag 변경, Content-Range 불일치, 앱 종료 직전 메타데이터 원자성
- `tests/main/localArtifactInstaller.test.ts`
  - 동의 전 다운로드 금지, 공간 부족, 서명·해시·라이선스 변경, staging 정리, 원자적 활성화
  - 기존 활성 버전을 업데이트 실패가 손상하지 않는지 확인
- `tests/main/localArtifactCatalog.test.ts`
  - bootstrap fallback, GitHub Release 갱신, 서명 실패, downgrade, 동일 버전 변조, 철회 반영
  - 원격 장애가 이미 설치된 오프라인 실행을 막지 않는지 확인
- `tests/main/localResourceStore.test.ts`
  - 저장소 이동, 롤백 보존, 사용 중 버전 삭제 금지, 경로 탈출과 symlink 방어
- `tests/main/hardwareProfile.test.ts`
  - GPU 조회 실패, VRAM 불명, CPU 폴백, 디스크 부족에서 보수적 추천
- `tests/main/localRuntimeManager.test.ts`
  - 중복 시작, health timeout, 조기 종료, 취소, 앱 종료, 비밀 없는 로그
- `tests/main/localJobQueue.test.ts`
  - heavy GPU 직렬화, FIFO, 취소 경쟁, 작업 완료 직전 취소, 다음 작업 진행
- `tests/electron/preload.test.ts`
  - 허용된 IPC만 노출하고 임의 URL·경로·명령 인자를 제거하는지 확인

### 번역 테스트

- `tests/main/localTranslationAdapter.test.ts`
  - health, 요청 형식, 응답 파싱, timeout, malformed response, OOM 분류
- `tests/main/localTranslationCommit.test.ts`
  - AI 초안만 Main이 기록, source fingerprint 불일치 시 stale, 사용자 번역 보존
- Renderer 테스트
  - AI/사용자 번역 동시 표시
  - 현재/선택/페이지/전체 미번역 적용
  - 기존 사용자 번역 기본 제외와 덮어쓰기 확인

### OCR 테스트

- 작은 합성 일본어·영어 이미지와 고정 영역을 저장소에 포함한다.
- OCR 실행기는 가짜 JSON으로 계약을 검사하고, 실제 Paddle 출력은 정기 골든 검사로 다룬다.
- 고신뢰 자동 반영, 저신뢰·중복·순서 충돌 예외 분류를 각각 검증한다.
- 사람이 수정한 영역과 원문이 재실행으로 덮어쓰이지 않는지 검증한다.

### 인페인팅 테스트

- 원본 해시가 실행 전후 동일한지 검증한다.
- AOT·LaMa·Flux adapter의 출력 형식과 취소를 가짜 실행기로 검사한다.
- 파생 이미지가 프로젝트 내부 허용 경로에만 기록되는지 검증한다.
- 미리보기 미승인, 승인, 롤백, 실패 중단 후 복구를 검증한다.

### 실제 모델 릴리스 매트릭스

| 환경 | 번역 | OCR | 인페인팅 | 게이트 |
|---|---|---|---|---|
| Windows x64 CPU | 12B 최소 smoke | CPU Paddle | AOT 또는 LaMa | 필수 |
| Windows x64 NVIDIA | 12B, 이후 26B·31B | CUDA Paddle | AOT·LaMa·Flux | 필수 |
| Windows x64 AMD | 후속 프리셋 | 후속 ROCm/Vulkan | 후속 ZLUDA/ROCm | AMD 단계 필수 |

실제 성인 작품 이미지나 사용자 프로젝트는 테스트 저장소와 CI에 넣지 않는다. 합성 또는 사용 허가가 명확한 작은 픽스처만 사용한다.

### 기준 명령

작업 폴더: `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기`

```powershell
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd run pack:win
```

구현 첫 단계에서 `.worktrees/**` 수집 제외와 Windows 리소스 설치 테스트의 파일 잠금 실패를 먼저 해결해 “기존 실패”와 “새 회귀”를 분리한다.

## 13. 구현 단계와 완료 조건

### Phase 0 — 기준선과 승인 게이트

목표: 새 기능 전에 현재 검증 기준을 신뢰할 수 있게 한다.

- 전체 테스트의 `.worktrees/**` 제외 설정
- Windows 파일 잠금으로 실패하는 리소스 설치 테스트 원인 수정
- 현재 typecheck, 관련 테스트, build 결과 기록
- 카탈로그 게시 키와 운영 책임자 결정
- bootstrap 카탈로그 생성·서명 스크립트와 GitHub Release 게시 방식 승인
- 각 후보 아티팩트의 라이선스·출처·SHA 검토표 작성
- 실제 구현 전 필요한 패키지 추가와 선택적 프로젝트 형식 변경을 사용자에게 별도 승인 요청

완료 조건:

- 전체 테스트가 프로젝트 파일만 수집한다.
- 리소스 설치 테스트가 반복 실행해도 안정적이다.
- 제품 코드를 바꾸기 전에 정확한 첫 카탈로그 후보가 승인된다.

### Phase 1 — 공통 설치·관리 기반

목표: 작은 시험 아티팩트로 설치·재개·검증·복구·제거가 독립적으로 동작한다.

1. `LocalArtifactCatalogV1`과 설치·오류 계약 작성
2. 앱 bootstrap 카탈로그와 GitHub Release 갱신·서명·철회 처리
3. 대용량 Range 다운로더와 `.partial` 메타데이터
4. 저장소, staging, 활성·롤백 버전, 안전한 이동
5. Windows 하드웨어 프로브와 프리셋 추천 입력
6. Main 작업 큐와 runtime manager의 fake runner 경로
7. preload·Renderer 설치 상태·진행률·취소 UI

완료 조건:

- 네트워크 중단과 앱 재시작 후 다운로드가 이어진다.
- 전체 해시 실패 파일은 실행 가능 상태가 되지 않는다.
- 원격 카탈로그가 실패해도 마지막 검증본과 설치된 기능은 사용할 수 있다.
- Renderer가 임의 URL이나 실행 파일을 지정할 수 없다.
- 기존 OCR·인페인팅·프로젝트 저장 기능이 그대로 통과한다.

### Phase 2 — 로컬 번역

목표: 12B 번역을 실제 Windows 환경에서 설치부터 사용자 적용까지 완주한다.

1. 고정된 llama.cpp·12B·mmproj compatibility set 게시
2. llama.cpp adapter, health, 인증된 loopback, timeout, 종료
3. 현재 대사와 선택 대사 batch 번역
4. Main 전용 AI 초안 커밋과 provenance
5. AI 초안 읽기 전용 표시와 범위별 사용자 번역 적용
6. stale 결과와 사용자 수정 보호
7. CPU·NVIDIA 실제 smoke와 품질 샘플
8. 안정화 후 26B·31B 프리셋 추가

완료 조건:

- 12B가 CPU와 NVIDIA 검증 장비에서 시작·번역·취소·종료된다.
- 앱 종료 후 llama.cpp 프로세스가 남지 않는다.
- 재번역해도 기존 `userTranslation`은 바뀌지 않는다.
- 모델이 없어도 기존 클라우드·수동 편집 흐름은 정상이다.

### Phase 3 — PaddleOCR

목표: CPU·NVIDIA에서 이미지 영역과 원문 후보를 만들고 예외 검토까지 완주한다.

1. Python/Paddle 실행 환경을 고정된 아티팩트로 설치
2. layout·det·rec·VL 모델과 compatibility set 게시
3. Paddle adapter와 진행률·부분 실패 계약
4. 기존 OCR 후보·`DialogueLineV2.origin`에 결과 연결
5. 신뢰도·중복·읽기 순서·기존 편집 충돌 규칙
6. 이미지 오버레이와 예외 검토함
7. 영역별 재실행과 사용자 확정 보호

완료 조건:

- 일본어·영어 합성 골든 페이지에서 고정된 후보 계약을 만든다.
- 저신뢰 결과가 자동 확정되지 않는다.
- 한 영역 실패가 페이지 전체 성공 결과를 폐기하지 않는다.
- 사용자 수정 원문은 재실행으로 덮어쓰이지 않는다.

### Phase 4 — AOT·LaMa·Flux 인페인팅

목표: 빠른 처리와 정밀 처리를 원본 비파괴 방식으로 제공한다.

1. AOT·LaMa 런타임과 모델 게시
2. 말풍선·캡션 추천 규칙과 빠른 모드
3. Flux·decoder·text encoder compatibility set 게시
4. 배경 문자 추천 규칙과 정밀 모드
5. 결과 비교, 사용자 엔진 변경, 승인·롤백
6. 기존 `inpaintingAssets`와 `approve_asset` 흐름 연결

완료 조건:

- 모든 엔진이 원본 파일 해시를 변경하지 않는다.
- 실패 결과는 승인 자산이 되지 않는다.
- 사용자는 미리보기 전후를 비교해 원하는 결과만 적용한다.
- Flux OOM 시 AOT·LaMa 또는 CPU 대안을 안내하되 자동 클라우드 전환하지 않는다.

### Phase 5 — AMD와 운영 안정화

목표: 기능 계약을 바꾸지 않고 AMD 실행 세트를 추가하고 장기 관리 기능을 마무리한다.

- 번역 Vulkan/ROCm, Paddle ROCm, 인페인팅 ZLUDA/ROCm 후보 검증
- 카탈로그 업데이트·철회·롤백 운영 연습
- 저장소 정리와 이동 복구 테스트
- 실제 장기 실행, 반복 런타임 전환, 앱 강제 종료 복구
- 하드웨어별 추천 기준 재조정

완료 조건:

- AMD 전용 실제 장비 매트릭스가 통과한다.
- 기존 CPU·NVIDIA 카탈로그와 결과 계약이 회귀하지 않는다.
- 철회와 롤백 절차를 문서와 실제 시험으로 검증한다.

## 14. 예상 파일 변경 지도

실제 구현 전에 각 Phase별로 더 작은 작업 계획과 변경 승인을 만든다. 아래는 책임 위치를 보여주는 예상 지도이며 한 번에 모두 수정하지 않는다.

| Phase | 예상 파일 |
|---|---|
| 0 | `vite.config.ts`, 실패하는 기존 테스트와 최소 관련 코드 |
| 1 계약 | `src/shared/localArtifacts.ts`, `src/shared/localProcessing.ts` |
| 1 배포 | 카탈로그 생성·서명 스크립트, bootstrap asset, 승인된 GitHub Release workflow |
| 1 Main | `src/main/largeArtifactDownloader.ts`, `localArtifactInstaller.ts`, `localResourceStore.ts`, `hardwareProfile.ts`, `localJobQueue.ts`, `localRuntimeManager.ts` |
| 1 연결 | `src/main/localProcessingIpc.ts`, `electron/main.ts`, `electron/preload.ts`, `src/renderer/electronApi.ts` |
| 1 UI | 새 로컬 리소스 설정 패널과 작은 App 연결부, 관련 CSS |
| 2 | `src/main/adapters/llamaCppAdapter.ts`, 번역 커밋 서비스, 번역 비교·적용 UI, 선택적 project type/validation 필드 |
| 3 | `src/main/adapters/paddleOcrAdapter.ts`, OCR 후보 변환·예외 규칙, 이미지 검토 UI |
| 4 | `src/main/adapters/*InpaintAdapter.ts`, `src/shared/inpainting.ts`, 기존 인페인팅 자산·UI 연결 |
| 5 | AMD 카탈로그·프로브·실제 장비 테스트 문서 |

`package.json`, lock 파일, 프로젝트 형식, 배포 설정에 변경이 필요하면 AGENTS 지침에 따라 이유와 대안을 먼저 설명하고 사용자 승인을 받은 뒤 수정한다.

## 15. 병렬화와 의존성

```text
순차 필수:
카탈로그 계약
  -> 대용량 다운로드·저장소
  -> 작업 큐·런타임 관리자
  -> IPC·설치 UI

공통 기반 뒤 병렬 가능:
  +-> llama.cpp adapter + 번역 UI
  +-> Paddle adapter + OCR 후보 규칙
  +-> AOT/LaMa/Flux adapter + 비파괴 자산 테스트

출시는 순차:
공통 기반 -> 번역 -> OCR -> 인페인팅 -> AMD
```

병렬 작업은 같은 핵심 파일을 동시에 고치지 않도록 나눈다.

- 계약 lane: shared DTO와 오류 코드
- 설치 lane: downloader·installer·store
- 런타임 lane: queue·manager·fake runner
- 기능 adapter lane: 번역, OCR, 인페인팅
- UI lane: 설정과 각 단계 결과 검토
- 검증 lane: 단위·골든·실제 Windows 매트릭스

`electron/main.ts`, `electron/preload.ts`, `electronApi.ts`, `App.tsx` 통합은 각 Phase 마지막에 한 소유자가 순차 처리한다.

## 16. 위험과 완화

| 위험 | 영향 | 완화 |
|---|---|---|
| Carrot와 모델 라이선스 혼동 | 배포 중단 또는 소스 공개 의무 오판 | Carrot 바이너리 미사용, 아티팩트별 독립 검토, 공식 원본 직접 다운로드 |
| 모델·mmproj·llama.cpp 버전 불일치 | 서버 시작 또는 추론 실패 | compatibility set으로 함께 고정하고 실제 smoke 후 게시 |
| 대용량 다운로드 손상 | 시간·데이터 낭비 | 청크 상태, 전체 해시, staging, 원자적 전환 |
| GPU 메모리 경쟁 | OOM과 앱 불안정 | heavy GPU 단일 큐, preflight, 정상 unload 뒤 전환 |
| Python 환경 의존성 충돌 | OCR 또는 인페인팅 시작 실패 | 앱 전용 격리 런타임을 버전 세트로 설치 |
| AI 결과가 사용자 편집을 덮어씀 | 작업 손실 | Main 소유 초안, fingerprint, 사용자 필드 기본 보호 |
| App 컴포넌트 비대화 | 유지보수와 테스트 난이도 증가 | 서비스·hook·작은 패널로 분리하고 App에는 조정 코드만 둠 |
| 실제 모델 없는 테스트 | 릴리스에서만 호환성 실패 | fake CI와 별도로 실제 CPU/NVIDIA 릴리스 게이트 운영 |
| 민감 정보 로그 유출 | 개인정보 침해 | 내용 로그 금지, 오류 코드와 성능 수치만 기록 |
| 기존 리소스 설치 회귀 | 현재 파이프라인 손상 | 4GB 기존 다운로더 계약 보존, 대용량 경로 분리 |

## 17. 구현 시작 전 체크리스트

- [ ] Phase 0만 먼저 별도 작업으로 승인받는다.
- [ ] 패키지 추가 필요 여부와 무의존 구현 대안을 비교해 승인받는다.
- [ ] 선택적 프로젝트 출처 필드 변경을 승인받는다.
- [ ] 첫 12B compatibility set의 정확한 URL·revision·SHA·라이선스를 검증한다.
- [ ] 카탈로그 서명 키 보관과 교체 절차를 정한다.
- [ ] GitHub Release 카탈로그 게시·롤백을 위한 배포 설정 변경을 승인받는다.
- [ ] 테스트용 합성 이미지의 사용 권리를 확인한다.
- [ ] CPU와 NVIDIA 실제 검증 장비를 정한다.
- [ ] 각 Phase 완료 후 다음 Phase를 시작할지 사용자에게 확인한다.

## 18. 엔지니어링 검토 요약

- Scope review: 전체 기능을 유지하되 네 개의 독립 출시 단계로 분리했다.
- Architecture review: 8개 쟁점을 검토했고 모두 사용자 선택으로 확정했다.
- Code quality review: AI 초안 소유권, OCR 예외, 비파괴 인페인팅, 클라우드 경계를 확정했다.
- Test review: 계층형 테스트와 실제 Windows 릴리스 매트릭스를 확정했다.
- Performance review: 공용 저장소와 heavy GPU 단일 큐를 확정했다.
- Failure modes: 설치·프로세스·GPU·stale·부분 실패의 복구 계약을 포함했다.
- What already exists: 서명·설치·세션·파생 자산 기반을 재사용하고 병렬 시스템을 만들지 않는다.
- TODO 제안: 별도 `TODOS.md` 항목 없음. 이 계획에 필요한 후속 작업을 모두 Phase로 포함했다.
- Outside voice: 이번 검토에서는 실행하지 않았다. UI 범위가 크므로 구현 전 디자인 계획 검토가 유용하다.
- Parallelization: 6개 lane이 가능하지만 공통 계약과 통합 파일은 순차 처리한다.
- Recommendation adoption: 제시한 16개 권장안 모두 사용자가 A로 확정했다.
- Design review: 설치·비교·OCR 예외 검토를 7개 관점으로 검토했고 11개 디자인 결정을 모두 확정했다. 상세 와이어프레임과 상태 계약은 연결된 UI 상세 계획을 따른다.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | 실행하지 않음 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | 실행하지 않음 |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | CLEAR (PLAN) | 15 engineering issues reviewed, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 1 | CLEAR (PLAN) | 7 passes, 11 decisions, 13 implementation tasks, 0 unresolved decisions |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | 실행하지 않음 |

**VERDICT:** CLEARED — 구현 전 엔지니어링·디자인 계획 검토를 통과했다. 제품 코드는 아직 변경하지 않는다.

NO UNRESOLVED DECISIONS
