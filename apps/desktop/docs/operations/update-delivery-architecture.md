# Trio 릴리스 자동화 및 업데이트 제공 아키텍처

> 2026-09-17 범위 갱신: 이 문서의 macOS 항목은 **non-MVP / future scope**이며 현재 MVP 지원이나 Release Gate 요구가 아닙니다. Linux 범위는 변경하지 않습니다. [현재 플랫폼 정책](mvp-platform-scope.md)을 우선합니다.
> 이전 시점의 실행 결과와 gate 상태는 역사적 기록이며 현재 후보 판정은 [최신 Release Gate 보고서](../release/2026-09-17-mvp-release-gate.md)를 따릅니다.

> **작성일:** 2026-08-18  
> **현재 상태:** 설계·의사결정 문서. cloud signing credential, Apple Developer Team ID, 공개 배포 범위는 아직 미확정이다.  
> **변경 불가 원칙:** 서명되지 않은 stable 배포와 stable tag 릴리스는 허용하지 않는다. packaged 앱에 GitHub PAT, GitHub App key, cloud signing key 또는 장기 API token을 넣지 않는다.

## 1. 기준선과 문제 정의

현재 `package-release.yml`은 PR/main의 unsigned QA와 수동 `stable-candidate`의 private package/evidence만 수행한다. tag 생성, GitHub Release mutation과 public delivery promotion은 이 workflow에 없다. unsigned stable tag는 `release-channel-policy.mjs`가 계속 차단하며, preview/dev QA도 public stable feed를 변경하지 않는다.

`ksaeil2001/trio`는 private 저장소다. GitHub Release는 저장소 읽기 권한이 있는 사람에게만 보이므로, 설치된 일반 앱은 GitHub provider의 `latest.yml`을 비인증으로 읽을 수 없다.[1] 현재 이 현상은 `UPDATER_PRIVATE_RELEASE_ASSET_UNREACHABLE` 진단으로 분류되어 있으며, 앱은 crash 대신 update error UI를 보여 준다.

electron-builder는 GitHub Releases, object storage 및 generic HTTPS server를 update provider로 지원한다. generic provider의 경우 생성된 metadata와 release 파일을 배포 파이프라인이 직접 업로드해야 한다.[2] 따라서 **private source 저장소와 public update asset을 분리**하면 source는 비공개로 유지하면서 소비자용 자동 업데이트를 제공할 수 있다.

## 2. 선택지 비교

| 선택지 | 동작 방식 | 장점 | 핵심 trade-off | 운영·구성 난이도 | 권고 여부 |
| --- | --- | --- | --- | --- | --- |
| A. 현재 `trio`를 public 전환 | source·tag·Release·installer를 하나의 public 저장소에 게시하고 GitHub provider 사용 | 가장 단순하며 현재 `publish` 설정과 가장 가깝다 | source와 모든 release asset이 공개된다. proprietary 정책과 맞지 않을 수 있다 | 낮음 | source 공개를 명시적으로 승인할 때만 |
| B. private source + public delivery repo/CDN | private `trio`에서 build·sign·verify하고, public `trio-releases`와 public static update prefix에 signed installer·metadata만 게시 | source 비공개 유지, public consumer update 가능, GitHub Release 페이지도 제공 가능 | 별도 delivery 경로·cross-repository credential·promotion 규칙 필요 | 중간 | **소비자 대상 기본 권고** |
| C. private source + 인증된 내부 update broker | 앱이 조직 SSO/device credential으로 broker에 인증하고, broker가 정책 판정 및 제한된 metadata·download URL을 제공 | binary까지 비공개, 사용자·조직별 rollout·폐기 제어 가능 | 인증·token 갱신·monitoring·incident 대응을 운영해야 한다 | 높음 | 기업·폐쇄 배포에만 |

GitHub가 workflow에 자동 발급하는 `GITHUB_TOKEN`은 workflow가 있는 repository에만 권한이 한정된다.[3] 따라서 선택지 B에서 private source repository의 workflow가 public delivery repository에 Release를 만들려면 일반 `GITHUB_TOKEN`만으로는 부족하다. 리포지토리 두 곳에 최소 권한으로 설치한 GitHub App의 짧은 installation token을 사용하는 것이 적절하다.[4]

## 3. 권고안 — private source와 public release delivery 분리

Trio가 일반 사용자에게 Windows 자동 업데이트를 제공하려면 **선택지 B**를 기본으로 권고한다. `ksaeil2001/trio`는 source·issue·개발 tag를 private으로 유지하고, 새 public delivery repository(예: `ksaeil2001/trio-releases`) 또는 public object storage/CDN에는 아래 파일만 게시한다.

| 저장 위치 | 공개 대상 | 포함 가능한 것 | 포함 금지 |
| --- | --- | --- | --- |
| private `trio` | 개발자·승인자 | source, CI, 내부 test artifact, signing evidence의 민감하지 않은 요약 | signing key, credential, 실제 원고, user data |
| public `trio-releases` GitHub Release | 최종 사용자 | installer, `latest.yml`, release notes, SHA-512 metadata, 최소한의 다운로드 안내 | source archive 참조, secret, 내부 로그, private issue 링크 |
| public static update prefix | updater | 플랫폼·채널별 metadata와 updater가 다운로드할 immutable artifacts | preview를 stable pointer에 노출하는 파일, 장기 인증 token |

GitHub Release 자산은 사람이 다운로드할 배포 페이지로 쓰고, `stable/latest.yml` 같은 updater pointer는 별도의 고정 static prefix에서 제공한다. 이 분리는 GitHub의 “latest release” 선택 규칙이나 prerelease 순서가 자동 update channel을 바꾸지 않도록 한다. 릴리스 자산과 metadata를 공개할 수 없다면 이 권고안을 선택하지 않고 §6의 내부 broker 모델을 선택한다.

## 4. GitHub Actions 릴리스 빌드·public Release 자동화 설계

### 4.1 채널과 공개 범위

| tag/channel | unsigned 허용 | package·smoke | 외부 public Release | updater feed | 현재 상태 |
| --- | --- | --- | --- | --- | --- |
| `vX.Y.Z-preview.N` / `-dev.N` | 예, QA 범위만 | 예 | 기본값은 비공개 artifact 또는 private prerelease | stable feed에 절대 게시하지 않음 | 현재 허용 |
| `v0.1.3-transition.1` | signed QA만 | private transition workflow | 아니오 | Main-owned immutable `v0.1.4-preview.1` QA feed만 | exact `refs/tags/v0.1.3` and transition tag peeled SHA·`preview_candidate_run_id`/`preview_evidence_sha256`/`release_tooling_sha`·`TRIO_APPROVED_RELEASE_TOOLING_SHA` exact binding·별도 tooling checkout의 exact SHA/필수 도구·strict `latest.yml` schema/reference allowlist·asset bytes·pinned tooling의 `signtool verify /pa /all /v` publisher/digest/timestamp/chain 검증 필요; package source checkout은 tooling으로 대체하지 않음 |
| `vX.Y.Z` stable (Windows) | 아니오 | cloud-signed package 후 smoke·signature verify | 검증 후 public delivery에 게시 가능 | `windows/x64/stable`만 promotion | credential 준비 전 **차단 유지** |
| macOS stable | 아니오 | signed·notarized build 및 verify가 선행 | Apple 정책 충족 전 게시하지 않음 | `mac/x64/stable` promotion 금지 | Apple Developer/Team ID blocker |
| Linux stable auto-update | 별도 package-signing 정책 필요 | package·smoke는 가능 | manual/preview 배포와 분리 | 신뢰 모델 확정 전 stable auto-update 금지 | 정책 결정 대기 |

macOS auto update에는 code signing이 필요하다.[2] 따라서 현재 Apple Developer 계정과 Team ID가 없는 상태에서 macOS 자산을 unsigned stable로 공개하는 우회는 허용하지 않는다. Windows가 먼저 서명 준비를 끝낸 경우에도 release title을 플랫폼 전체 stable이라고 부르지 말고, `Windows stable` channel만 명시적으로 promotion한다.

### 4.2 파이프라인 단계

| 순서 | job 책임 | 입력 | 필수 검증 | 출력 및 실패 처리 |
| --- | --- | --- | --- | --- |
| 1 | `release-policy` | tag, channel policy | tag 형식, preview/stable 판정, stable signing readiness gate | gate 실패 시 package/public publish 전부 중단 |
| 2 | `package` matrix | tagged source | lockfile install, typecheck, platform package, packaged smoke | private artifact만 14일 보관; 아직 public 노출 없음 |
| 3 | `sign-windows` | Windows unsigned staging output | cloud signing, Authenticode publisher·timestamp·digest verify, signed installer hash 확인 | signature proof와 signed installer. 검증 실패 시 stable 중단 |
| 4 | `assemble-update-metadata` | signed platform outputs | `latest*.yml`의 version·filename·SHA-512·크기와 실제 파일 대조 | immutable release bundle. metadata 불일치 시 중단 |
| 5 | `release-draft` | verified bundle | public delivery repository에 **draft** Release 생성, 모든 asset upload | draft 상태에서 sha512·공개 URL·release note 검사 |
| 6 | `publish-and-promote` | published-ready draft | human-facing Release publish 후, 플랫폼/channel 별 static pointer 원자 갱신 | pointer 갱신 실패 시 release를 promotion하지 않고 incident 처리 |
| 7 | `post-publish-check` | public URL | 비인증 metadata fetch, installer checksum, signature proof, update check integration test | 실패 시 channel pointer를 마지막 known-good 버전으로 유지 |

public Release는 draft로 만들고 모든 자산이 검증된 뒤 publish하는 방식을 권장한다. GitHub도 immutable release 사용 시 draft로 자산을 먼저 붙인 뒤 publish하는 흐름을 권장한다.[5] CI artifact를 public delivery로 복사하기 전 단계에서 smoke test와 서명 검증을 끝내므로 “GitHub Release에 올라갔지만 설치가 안 되는” 상태를 줄일 수 있다.

### 4.2.1 transition candidate의 exact 입력과 no-latest 정책

transition QA는 다음 입력을 수동 dispatch에 요구한다.

| 입력/환경 | 역할과 binding | live 상태 |
| --- | --- | --- |
| `preview_candidate_run_id` | `package-release.yml`의 정확한 성공 `workflow_dispatch` run을 선택; run head SHA와 candidate artifact를 결속 | 미정 — 실제 run 없음 |
| `preview_evidence_sha256` | private `transition-candidate-evidence.json`의 lowercase SHA-256 sidecar digest | 미정 — private candidate 없음 |
| `release_tooling_sha` | full SHA; candidate run head/private evidence `sourceSha`/pinned tooling checkout HEAD와 일치 | 미정 — live 실행 없음 |
| `TRIO_APPROVED_RELEASE_TOOLING_SHA` | `transition-qa` Environment의 승인된 tooling SHA; `release_tooling_sha`와 exact-match | 미정 — Environment 증거 없음 |

private candidate artifact 이름은
`trio-preview-transition-candidate-<sourceSha>-<runId>`로 고정한다. evidence는
`trio.transition-candidate-evidence.v1` JSON, sidecar, `latest.yml`,
`Trio-Setup-0.1.4-preview.1.exe`, 해당 blockmap과 exact bytes/digests를
포함한다. transition workflow는 source와 tooling checkout 각각에 대해
`trio.git-source-integrity.v1` before/after 결과를 남기고, 각 `headSha`와
tracked `treeSha`가 동일한지 확인한 뒤에만 sanitized `transition.json`을
업로드한다.

어떤 job도 latest workflow run, latest artifact, GitHub Release의 latest
pointer 또는 stable feed를 추측해 선택하지 않는다. exact run ID·artifact
ID/name·source SHA·evidence digest가 맞지 않으면 종료하며, private
candidate/transition artifact는 public Release나 stable update pointer를
변경하지 않는다.

### 4.3 credential과 권한 최소화

Cloud signing vendor는 아직 선정되지 않았으므로 vendor-specific secret name이나 workflow 구현을 지금 확정하지 않는다. 다음의 권한 경계만 선행 확정한다.

| 자격 증명 | 보관 위치 | 허용 권한 | 금지 사항 |
| --- | --- | --- | --- |
| 기본 `GITHUB_TOKEN` | source workflow runtime | 현재 source repository의 artifact·release 처리 | 다른 repository publish에 사용한다고 가정하지 않음 |
| GitHub App installation token | release job runtime에서 단명 발급 | public delivery repository의 `contents: write` 및 Release asset 관리만 | PAT를 앱·installer·repository file에 넣지 않음 |
| cloud signing workload identity | GitHub Actions secret/OIDC trust에서만 교환 | signing 요청 및 필요한 verify 조회 | PFX private key를 CI artifact·Git history·채팅에 보관하지 않음 |
| static storage deploy credential | promotion job runtime | `stable/` pointer와 immutable signed asset 업로드만 | broad account credential 또는 long-lived access key를 renderer에 노출하지 않음 |

GitHub App 방식에서는 App의 client ID는 configuration variable, private key는 Actions secret에 두고 job마다 installation token을 발급한다.[4] 이 방식은 앱을 설치한 target repositories로 권한을 제한할 수 있으며, public delivery repository를 위한 개인 PAT를 배포·장기 보관하지 않아도 된다.

### 4.4 현재 workflow에서의 적용 순서

현재 환경에서는 `.github/workflows/` 변경을 CLI로 push할 수 없다. 따라서 아래 순서로 검토 PR을 만들고 GitHub 웹 UI에서 workflow 파일을 반영한다.

1. `package-release.yml`의 current release job을 **private artifact 검증 전용**과 **public delivery promotion** 책임으로 분리한다.
2. `release-policy`가 stable tag를 무조건 통과시키지 않도록 유지한다. cloud signing과 platform verification evidence가 존재할 때만 stable promotion이 가능하게 별도 gate를 추가한다.
3. Windows cloud signing provider가 선정된 뒤 signing job을 실제 연결하고, signed output을 기준으로 metadata를 다시 검증한다.
4. GitHub App을 public delivery repository에만 최소 권한으로 설치하고, App key는 Actions secret으로만 등록한다.
5. preview tag에서 `dry-run` draft 생성·asset validation을 먼저 실행한다. preview가 stable static pointer를 수정하지 않는지 확인한다.
6. synthetic Windows installer fixture 또는 test release로 public URL·metadata·signature probe를 검증한 뒤에만 실제 stable promotion을 enable한다.

## 5. `electron-updater` 설정 전환안

현재 `package.json`은 GitHub provider를 가리킨다. public delivery를 source repository와 분리할 경우 final stable build는 **generic HTTPS provider**로 전환한다. 이 provider는 electron-builder가 metadata를 만들지만, artifact와 metadata upload 자체는 pipeline이 담당한다.[2] 단, transition baseline은 stable provider 설정을 재사용하지 않고 Main의 `TRIO_TRANSITION_QA_FEED_URL`을 `setFeedURL()`로 일시 지정한다. 이 값은 renderer나 환경변수 입력으로 바꿀 수 없고 `v0.1.4-preview.1` immutable QA 경로만 가리킨다.

```jsonc
// 개념 예시 — credential, 실 URL, 공개 전환 전 변경 금지
{
  "build": {
    "publish": [{
      "provider": "generic",
      "url": "https://updates.example.invalid/trio/windows/x64/stable/"
    }]
  }
}
```

이 URL은 installer에 포함되므로 **인증이 필요 없는 public update feed**일 때만 사용한다. `latest.yml`, installer, blockmap은 같은 immutable release bundle에서 생성하고, promote 단계가 마지막 known-good pointer만 바꾸도록 한다. `latest.yml`의 SHA-512와 Windows code signature 검증은 모두 release gate에 포함한다. electron-updater는 Windows code signature 검증, checksum metadata, staged rollout 및 generic provider를 지원한다.[2]

업데이트 rollback은 같은 version 파일을 다시 올리는 방식이 아니라, 더 높은 version으로 수정 release를 내거나 channel pointer를 마지막 안전 release로 되돌리는 방식으로 운영한다. staged rollout을 철회한 뒤 동일 버전을 재발행하면 이미 해당 version을 받은 사용자가 수정본을 받지 못할 수 있다.[2]

## 6. private repository용 인증된 내부 updater broker

내부 조직 또는 라이선스 계약상 installer도 공개할 수 없을 때는 선택지 C를 쓴다. 이 모델은 public GitHub Release를 auto-update source로 사용하지 않는다.

### 6.1 권고 구성

```text
Trio installed app
  └─ (사용자/조직 로그인, 단명 access token)
       └─ Update broker API
            ├─ 정책 엔진: tenant, device, channel, 현재 버전, rollout
            ├─ metadata authorization endpoint
            └─ audit event sink (개인정보 최소화)
                 └─ private object storage / CDN
                      ├─ immutable latest.yml
                      ├─ signed NSIS installer + blockmap
                      └─ release evidence
```

1. **인증:** 앱은 조직 SSO 또는 제품 계정으로 로그인하고, 메모리에만 보관하는 짧은 access token으로 update broker에 request한다. GitHub PAT는 사용하지 않는다. refresh token이 필요하면 OS credential vault로 한정하는 별도 보안 설계를 거친다.
2. **정책 판정:** broker는 platform, architecture, installed version, channel, 조직·device allowlist, rollout cohort를 검증한다. 허용되지 않은 요청에는 파일 URL이 아닌 `no-update` 또는 generic authorization error만 반환한다.
3. **다운로드:** broker는 짧은 만료·release/version/architecture에 결속된 download authorization을 제공한다. 업데이트 파일은 immutable object key로 보관하며 overwrite하지 않는다.
4. **무결성:** CI에서 signed installer의 Authenticode 상태와 SHA-512를 검증한 뒤 metadata를 publish한다. client는 electron-updater의 checksum·platform signature 검증을 유지한다.[2]
5. **관측성:** broker audit는 release ID, anonymized device hash, result code, timestamp 중심으로 남긴다. access token, raw IP, project file path, 원고, crash dump 원본은 일반 운영 로그에 넣지 않는다.

### 6.2 `electron-updater`와 인증의 경계

electron-updater는 custom `NsisUpdater`를 만들고 request header 또는 `addAuthHeader()`를 전달하는 구성을 지원한다.[2] 그러나 이 기능은 **앱 안에 장기 credential을 넣어도 된다는 뜻이 아니다.** 내부 broker 모델에서는 매 실행/갱신 때 얻는 짧은 bearer token만 전달하고, 이 token의 audience·만료·download scope를 제한한다.

`latest.yml` 자체에 application-level detached signature를 추가로 요구한다면, generic updater만으로 “manifest signature 검증”이 자동 제공된다고 가정하면 안 된다. 최소 모델은 TLS·짧은 authorization·installer code signing·SHA-512 검증이다. 더 강한 manifest authenticity가 필요하면 다음을 별도 보안 범위로 설계한다.

| 강화 수준 | 구현 방향 | 출시 전 검증 |
| --- | --- | --- |
| 기본 | TLS broker + ephemeral bearer token + signed installer + SHA-512 | token 만료·권한 거부·checksum mismatch integration test |
| 강화 | broker가 version·manifest digest·만료를 담은 Ed25519/JWS release envelope 발급, 앱에 고정된 public key로 preflight 검증 | envelope tamper·expired·wrong platform·key rotation test |
| 최고 | 별도 custom update client가 manifest·artifact를 직접 검증하고 NSIS install handoff | Windows signature·rollback·partial download·crash recovery의 end-to-end QA |

강화/최고 모델은 현재 `AutoUpdateController`의 범위를 넘어선다. 먼저 기본 모델의 access boundary와 Windows cloud signing을 확정하고, manifest detached signature 요구가 실제 계약 사항일 때만 별도 P2 security design·threat model·integration test를 시작한다.

### 6.3 호스팅 선택

내부 broker는 stateless HTTPS API와 object storage/CDN만으로도 시작할 수 있으며, 그 경우 상시 프로세스나 고정 IP가 필수는 아니다. 조직 네트워크 allowlist, private connectivity, custom HSM agent, 고정 IP, Docker 기반 signing proxy처럼 관리형 API가 충족하지 못하는 운영 제약이 생길 때만 별도 항상 실행 서버를 검토한다. 이 선택은 현재 배포 범위를 넘어가므로 credential provider·조직 인증 방식·예상 device 수가 확정된 뒤에 결정한다.

## 7. 결정 요청 및 완료 조건

| 결정 | 선택지 | 결정 전 기본값 | 영향 |
| --- | --- | --- | --- |
| 소비자 installer 공개 | A/B/C | source·installer 모두 private | B/C 없이는 consumer auto-update 불가 |
| public delivery destination | public GitHub delivery repo + static prefix / object storage CDN | 미정 | generic URL, promotion job, GitHub App 권한이 달라짐 |
| Windows cloud signing provider | vendor 선정 | 미정 | stable gate는 계속 block |
| macOS stable 지원 시점 | Apple signing/notarization 준비 후 / 연기 | 연기 | `latest-mac.yml` public stable promotion 금지 |
| internal deployment 필요 여부 | 필요 / 불필요 | 미정 | 필요 시 broker authentication·device policy 범위 추가 |

**지금 바로 실행 가능한 다음 단계**는 P1-02 fixture 구현과, preview tag에 대한 release draft dry-run 설계 검토다. 하지만 actual public Release promotion과 stable tag 허용은 Windows cloud signing이 실제로 연결되고 signature verification evidence가 자동화된 뒤에만 진행한다.

구체적인 source-to-delivery repository job, GitHub App 최소 권한, protected environment 및 GitHub 웹 UI 적용 순서는 [public delivery workflow 구성](public-delivery-workflow.md)과 [주석 포함 workflow 템플릿](../workflow-examples/private-source-public-delivery.yml)에서 관리한다.

## References

[1]: [GitHub Docs — About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

[2]: [electron-builder — Auto Update](https://www.electron.build/docs/features/auto-update/)

[3]: [GitHub Docs — GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)

[4]: [GitHub Docs — GitHub App authentication in Actions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/making-authenticated-api-requests-with-a-github-app-in-a-github-actions-workflow)

[5]: [GitHub Docs — Managing releases in a repository](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)
