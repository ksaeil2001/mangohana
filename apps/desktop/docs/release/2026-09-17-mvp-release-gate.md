# 2026-09-17 MVP Release Gate

판정: **NO-GO**. 후리가나 Production OCR과 Windows Production font 검증은
해결되었다. 실제 Translation/Inpainting Golden E2E와 Windows Authenticode가
BLOCKED다. 아래 결과는 로컬 후보 증거이며 공개 배포나 원격 CI 성공을 뜻하지 않는다.

## A. Repository State

- 저장소: `ksaeil2001/trio`, branch `main`.
- 시작: `67ab9dfd669afa02f368aaa14446a99f6dbf20df`, `origin/main` 대비 ahead 2.
- 기존 `997841a`, `67ab9df`는 보존했다. reset/squash/amend/rebase와 push는 하지 않았다.
- OCR/font 변경: `d7de379d74e15f7ca33fbaf621d6655ee291b2b0`.
- 플랫폼 정책과 이 보고서는 별도 로컬 커밋이다. 최종 SHA와 전후 상태는 로컬
  `review-captures-release-20260917/git-after.txt`에 기록한다.
- `.grok/` 및 2026-09-03 carrot feature adaptation plan/spec는 미추적 상태로
  보존했다. 전후 파일 hash 차이 0, private signing credential 파일/header 검사 0건.
- 공개 font `.p7s`와 allowlist의 전후 hash는 동일하다. dependency와 package-lock 변경 없음.

## B. Production Font Trust

| 항목 | 결과 | 증거 |
| --- | --- | --- |
| CMS | PASS | committed manifest와 detached `.p7s` 실제 검증 |
| publisher pin | PASS | signer가 allowlist `current`와 일치 |
| manifest | PASS | committed manifest hash = pipeline lock = packaged manifest hash |
| payload | PASS | manifest의 font/license hash와 size를 실제 파일과 비교 |
| packaged verification | PASS | 새 `release/win-unpacked`에서 `verifyInstalledResourcePack()` 성공 |
| typeset evidence identity | PASS | initializer `enabled: true`, 올바른 identity `true`, 잘못된 identity `false` |
| protocol byte serving | PASS | 실제 등록된 `trio-resource` protocol을 Electron `net.fetch()`로 호출 |
| regression test | PASS | 공개 committed CMS/pin/hash 검증, 잘못된 signer/CMS/manifest/lock/font fail-closed |

- signer SHA-256: `CA17FDAB1BA0435732689799B64C9586EE28219AE5546B952371A97FDB84FF2B`
- manifest SHA-256: `27efedd0315cc2e77e54d2f3c86b1dd321a570c33e9dabcac1682354fd2e1628`
- signature SHA-256: `a355207148493c20a1a46ed521dd12d057d2d8b0b74e41f36351599c336f01c3`
- font SHA-256: `3090ccde0442bb347aa7685d9ba8b17436a60682df6e8f92a9a670de14056e22`
- protocol: HTTP `200`, `content-type: font/ttf`, `cache-control: no-store`.
- served / packaged bytes: 각각 `6739336`, 두 SHA-256 동일.
- 테스트에는 committed 공개 자료만 추가로 사용했다. Production key 생성·요청·복사 없음.
- 기존 “공개 서명 자료가 없어야 한다”는 테스트의 실패를 먼저 확인한 뒤 현재 계약에 맞게 대체했다.

## C. Production OCR

고정된 detector, mandatory grouping, Baberu ONNX, normalization 계약을 유지했다.
fallback, ensemble, 언어별 recognizer, fixture 문구 분기, 원문 날조는 추가하지 않았다.

재현은 기존 `japanese-furigana.svg`를 Electron offscreen capture로 rasterize한
실제 이미지에서 수행했다. detector의 두 영역은 다음과 같다.

| 검출 영역 | x / y / width / height | 같은 Baberu에 단독 crop 입력 |
| --- | --- | --- |
| 본문 | 475 / 212 / 500 / 190 | `日本語` |
| 작은 읽기 문자 | 597 / 128 / 235 / 70 | `にほんご` |

기존 grouping은 두 영역의 방향과 간격만 검사하여 합쳤다. 합친 crop에는 두 줄이
모두 보이지만 Baberu raw output은 `日本語`였고 normalized output도 동일했다.
따라서 normalization 손실이 아니라 서로 다른 글자 크기를 합친 recognition 입력이
원인이었다. 같은 모델이 분리 crop에서 두 문자열을 읽는 것을 확인한 뒤 수정했다.

수정은 읽기 방향에 수직인 글자 두께가 2배 넘게 다른 검출을 별도 group으로
유지한다. 가로에서는 높이, 세로에서는 너비를 비교하며 글자 내용이나 언어를 보지
않는다. 비슷한 두께의 여러 줄은 기존처럼 묶는다. 회귀 테스트는 수정 전 4개 실패,
수정 후 전체 11개 통과이며 좌표 배율·검출 순서·세로 보조 문자도 포함한다.

새 `release/win-unpacked/Trio.exe`를 **C:\trq17**의 빈 userData / APPDATA /
LOCALAPPDATA / TEMP로 실행했다. 공개 HTTPS의 기존 서명 OCR pack을 새로 설치했다.
실제 사용자 프로젝트나 리소스 저장소는 사용하지 않았다.

| Fixture | Run 1 | Run 2 (restart) | 실제 normalized output |
| --- | --- | --- | --- |
| English horizontal | PASS | PASS | `HELLO WORLD` |
| Japanese horizontal | PASS | PASS | `こんにちは` |
| Japanese vertical | PASS | PASS | `日本語` |
| small Japanese | PASS | PASS | `こんにちは` |
| multiple regions | PASS | PASS | `HELLO` + newline + `WORLD` |
| Japanese + furigana | PASS | PASS | `にほんご` + newline + `日本語` |

전체 **12/12 PASS**. 모든 fixture에서 orientation, reading order, 경고 없음,
고정 모델 revision, raw/normalized separation도 확인했다. 재시작 install 결과는
`installed: false`; downloader와 Electron netlog 모두 Production download 0건,
종료 후 `.partial`은 비어 있다. offline 네트워크 차단 검증은 이번 범위에서 실행하지 않았다.

## D. MVP Platform Policy

[현재 플랫폼 정책](../operations/mvp-platform-scope.md)에 따라 macOS는 non-MVP /
future scope다. Linux의 기존 AppImage, CI, updater-disabled 정책은 유지했다.
Linux를 새로운 MVP 지원 대상으로 선언하지 않았다.

- `.github/workflows/package-release.yml`: macOS QA matrix, stable job, assembly
  dependency, 다운로드, verification, asset upload 제거.
- `.github/workflows/promote-stable.yml`: macOS 공개 업로드 제거.
- `scripts/release-candidate-evidence.mjs`, `scripts/stable-promotion-policy.mjs`:
  macOS 자산과 Apple 서명 증거를 현재 allowlist/gate에서 제외.
- `docs/workflow-examples/trio-releases-attest.yml`: macOS 요구와 attestation 제거.
- `package.json`: macOS 명령을 `pack:mac:future`, `dist:mac:future`로 구분.
  mac builder의 강한 서명 조건과 일반 `darwin` 코드는 보존.
- `README.md`, `AGENTS.md`, release notes: 현재 MVP macOS 지원 표현 수정.
- 기존 backlog, execution plan, operations QA/delivery, release readiness/go-no-go,
  brand 문서는 이전 기록과 macOS future scope임을 명시했다.
- 관련 config/CI/evidence 테스트를 현재 정책으로 수정하고 macOS 재유입 거부를 검사했다.

## E. Golden E2E

**BLOCKED — real Production Translation/Inpainting provider unavailable**.

Gemini/OpenAI 환경 키가 없고, 실제 앱 설정 위치의 저장된 Gemini key 및 provider
settings 파일도 없었다. IPv4/IPv6 loopback의 11434, 8080, 8188, 7860, 1234 포트는
모두 연결되지 않았다. 기본 local translation / inpainting 실행 서버가 준비되지 않았다.
이 확인은 임의의 모든 외부 endpoint 부재를 뜻하지 않는다.

실제 production OCR과 Production Pretendard protocol은 실행했다. 그러나
image input → OCR → 실제 translation → 실제 inpainting → 한국어 typeset → export
→ save/reload 전체 Golden journey는 실행하지 못했다. 결정적 저장/재열기/사용자 편집
보존 테스트의 PASS를 실제 provider Golden evidence로 대체하지 않았다.

## F. Authenticode

**BLOCKED**. 새 `release/win-unpacked/Trio.exe`에 `Get-AuthenticodeSignature`를
실행한 결과 `NotSigned`, signer certificate 없음, timestamp certificate 없음.
실제 trusted code-signing 서명이 필요하다. Production font CMS는 이 gate와 별개다.

## G. Verification

| Command / 검증 | 결과 |
| --- | --- |
| `npm.cmd ci` | 기본 사용자 npm cache의 EPERM으로 최초 실패 |
| `npm.cmd ci --cache review-captures-release-20260917/npm-cache` | PASS, 422 packages, audit 0 vulnerabilities |
| font 기존 테스트 | 기존 부재 assertion 1 FAIL 재현 |
| grouping 회귀 테스트 (수정 전) | 4 FAIL / 7 PASS 재현 |
| OCR/grouping/merge/Golden + font + CI/evidence targeted tests | 10 files / 111 tests PASS |
| 최종 정책 targeted tests | 4 files / 56 tests PASS |
| `npm.cmd test` 최초 전체 실행 | 186 files PASS / 1 file FAIL; 2055 PASS / 1 FAIL |
| installer suite 반복 | 5회 × 55 tests PASS |
| `npm.cmd test` 최종 전체 실행 | **187 files / 2056 tests PASS, 0 failures, exit 0** |
| `npm.cmd run typecheck` | PASS, exit 0 |
| `npm.cmd run build` | PASS, exit 0 |
| `npm.cmd run pack:win` | PASS, exit 0; fresh unpacked package |
| `npm.cmd run test:release-policy` | 4 tests PASS |
| `npm.cmd run test:release-evidence` | 31 tests PASS |
| workflow YAML / Bash / embedded JS syntax | 3 workflows / 36 shell scripts / 9 Node modules PASS |
| package file/source hash 비교 | lock, allowlist, manifest, CMS, font, compiled grouping 모두 일치 |
| 실제 packaged OCR acceptance | 12/12 PASS, exit 0 |
| 실제 packaged font / protocol | PASS |
| `git diff --check` | PASS |

최초 전체 테스트의 installer 실패는 clean-install atomic rename 뒤
`RESOURCE_CORRUPT`였으며, 이후 5회 반복과 최종 전체 실행에서는 재현되지 않았다.
installer 코드나 assertion은 변경하지 않았고 간헐적 실패의 근본 원인이 해결됐다고
주장하지 않는다. 원래 실패 로그를 보존한다. jsdom canvas/navigation 및 Node SQLite
경고는 실패 수와 구분한다.

로컬 원본 증거 디렉터리: `review-captures-release-20260917/` (Git ignored).
주요 파일: `baseline/trace.json`, `grouping-red.log`, `targeted-green.log`,
`full-test.log`, `full-test-final.log`, `installer-repeats.json`, `package-hashes.json`,
`authenticode.json`, `provider-prerequisites.json`, `local-provider-probes.json`,
`clean/summary.json`, `clean/packaged-font.json`, `clean/restart-network-check.json`.

## H. Remaining Blockers

1. 실제 Production Translation/Inpainting provider가 없어 Golden E2E 미완료.
2. Windows executable Authenticode가 `NotSigned`.

Production font signer material과 후리가나 OCR은 더 이상 blocker가 아니다.
NSIS 물리 설치, 실제 update/배포 및 원격 workflow 실행은 이번 로컬 검증의 PASS로
주장하지 않는다. 최초 installer 간헐 실패의 원인 미확정은 별도 잔여 위험이다.

## I. Release Gate

**NO-GO**
