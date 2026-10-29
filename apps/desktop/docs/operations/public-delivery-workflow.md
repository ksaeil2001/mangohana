# private source + public delivery repository: GitHub Actions 구성

> 2026-09-17 범위 갱신: 이 문서의 macOS 항목은 **non-MVP / future scope**이며 현재 MVP 지원이나 Release Gate 요구가 아닙니다. Linux 범위는 변경하지 않습니다. [현재 플랫폼 정책](mvp-platform-scope.md)을 우선합니다.
> 이전 시점의 실행 결과와 gate 상태는 역사적 기록이며 현재 후보 판정은 [최신 Release Gate 보고서](../release/2026-09-17-mvp-release-gate.md)를 따릅니다.

> **상태:** private source candidate-only workflow가 구현되었다. cloud signing provider, stable environment, public delivery repository를 준비하기 전에는 public promotion을 활성화하지 않는다.
> **source:** `ksaeil2001/trio` (private)  
> **delivery:** `ksaeil2001/trio-releases` (public, 아직 생성하지 않음)  
> **정책:** unsigned stable은 차단한다. preview/dev는 private QA artifact만 생성하며 public stable update feed를 수정하지 않는다. `v0.1.3-transition.1`은 별도 private transition workflow에서 고정된 signed `v0.1.4-preview.1` QA feed만 조회한다.

## 1. 왜 별도 delivery repository인가

GitHub Release는 repository 읽기 권한이 있는 사람에게만 보인다. 따라서 private `trio`의 Release asset은 일반 설치 앱의 비인증 updater source가 될 수 없다.[1] source를 public으로 바꾸지 않으면서 일반 사용자용 자동 업데이트를 제공하려면, public repository에는 source가 아니라 **검증된 installer·blockmap·update metadata·릴리스 노트만** 두는 방식이 필요하다.

GitHub Actions 기본 `GITHUB_TOKEN`은 workflow가 있는 source repository에만 권한이 있다.[2] 그러므로 private source workflow가 public delivery repository의 Release를 생성할 때는, target repository 하나로 범위를 제한한 GitHub App installation token을 job 중에 발급한다.[3]

## 2. 사전 준비

| 항목 | 설정 값 | 이유 |
| --- | --- | --- |
| public delivery repository | `ksaeil2001/trio-releases` | source 없이 Release asset만 공개하는 destination |
| GitHub App installation | delivery repo만 설치, **Contents: write** | Release·asset 관리를 위한 최소 권한 |
| stable-release environment variable | `TRIO_DELIVERY_APP_CLIENT_ID` | App client ID; secret은 아니지만 두 번째 stable promotion job으로 범위를 제한 |
| stable-release environment secret | `TRIO_DELIVERY_APP_PRIVATE_KEY` | GitHub App private key 전체; `stable-promotion` job에만 제공 |
| protected environment | `stable-release` | App secret scoping과 public promotion audit 경계; 독립 reviewer 승인을 현재 gate로 주장하지 않음 |
| cloud signing integration | electron-builder packaging 내부 hook | installer가 완성된 뒤 서명하면 `latest.yml` SHA-512와 불일치할 수 있으므로 packaging 중에 서명 |
| verifier script | `scripts/ci-verify-signed-windows-release.mjs` | publisher·timestamp·signature, filename·size·SHA-512를 fail-closed로 검사; 현재는 구현 전 |
| package publish provider | public delivery repo의 GitHub provider | final stable installer가 `trio-releases`의 public Release를 updater source로 보게 함 |

GitHub App private key는 `stable-release` environment secret으로 보관하고 job 안에서 installation token을 만들어 사용한다. GitHub 공식 예시도 client ID를 variable, private key를 secret으로 분리한다.[3] 템플릿은 target repository와 `contents: write`만 request하며, token이 job 종료 시 revoke되도록 기본값을 유지한다. 자세한 UI 절차·plan 제약·1인 2단계 운영은 [GitHub App 및 stable-release 설정 가이드](github-app-and-stable-environment-setup.md)에서 관리한다.

## 3. 앱 빌드 설정 전환

public delivery 모델을 실제 enable하기 전에 final stable build의 publish configuration을 아래처럼 바꾼다. 기존 private source repository를 provider로 남기면 installer가 계속 private `trio`의 `latest.yml`을 요청한다.

```jsonc
// package.json의 build.publish — stable 구현 PR에서만 변경
{
  "build": {
    "publish": [{
      "provider": "github",
      "owner": "ksaeil2001",
      "repo": "trio-releases",
      "releaseType": "release"
    }]
  }
}
```

electron-updater는 GitHub Release provider와 NSIS auto-update를 지원하며, installer와 함께 생성된 `latest.yml`을 사용한다.[4] preview/dev build가 public stable update를 추적하지 않도록 runtime release channel을 별도로 명시하고, preview package에는 updater를 disable하거나 preview-only feed를 사용해야 한다. transition baseline은 Main-owned `TRIO_TRANSITION_QA_FEED_URL`을 generic feed로 설정하고, `allowPrerelease`만으로 public 기본 GitHub feed를 조회하지 않는다. 이 feed는 `v0.1.4-preview.1` QA Release asset 경로에 고정하며 stable controller에는 설정하지 않는다.

## 4. workflow 파일과 job 흐름

기존 주석 포함 예시는 [`private-source-public-delivery.yml`](../workflow-examples/private-source-public-delivery.yml)에 남아 있다. private candidate/evidence 단계와 public promotion workflow [`promote-stable.yml`](../../.github/workflows/promote-stable.yml)은 구현되어 있지만, 별도 execution approval과 public repository·GitHub App·Environment/secrets·signing service·candidate/live evidence prerequisites가 갖춰질 때까지 public promotion을 enable하거나 execute하지 않는다.

| job | tag/channel | protected environment | 공개 전환 | 핵심 보장 |
| --- | --- | --- | --- | --- |
| `classify` | stable/preview 구분 | 없음 | 없음 | 지원 tag만 통과 |
| `preview-package` | preview/dev | 없음 | 없음 | unsigned cross-platform artifact를 private QA용으로 14일 보관 |
| `transition-update-qa.yml` | `v0.1.3-transition.1` | `transition-qa` | 없음 | exact `v0.1.3`/transition tag peeled SHA·별도 immutable `release_tooling_sha` checkout과 tooling evidence·strict `latest.yml` schema and reference allowlist·preview Release asset bytes·pinned `verify-windows-signing.ps1` publisher/digest/timestamp/chain 검증 후 package source에서 `--publish never` private Windows artifact만 보관 |
| `package-signed-windows-stable` | stable | `stable-release` | 없음 | signing hook 내부에서 NSIS build, smoke test, signature·metadata 검사 |
| `assemble-candidate` | stable-candidate | 없음 | private Actions artifact만 생성 | exact asset allowlist, sanitized evidence, SBOM·checksum·metadata 재검증 |

`package-release.yml`은 현재 candidate를 만들기만 하며 GitHub Release·tag·public repository를 생성하거나 변경하지 않는다. 별도 promotion workflow가 같은 candidate run, source/tag SHA와 evidence digest를 다시 검증한 뒤에만 draft Release를 만들 수 있다.

### 4.1 private preview candidate와 transition 입력

Gate 4의 transition dispatch는 `preview_candidate_run_id`,
`preview_evidence_sha256`, `release_tooling_sha`를 필수 입력으로 받고,
`TRIO_APPROVED_RELEASE_TOOLING_SHA`를 `transition-qa` Environment에서 읽는다.
`release_tooling_sha`는 approved Environment SHA, exact candidate run head SHA,
private evidence `sourceSha`와 일치해야 한다. candidate artifact는
`trio-preview-transition-candidate-<sourceSha>-<runId>` 하나만 허용한다.
private evidence에는 `trio.transition-candidate-evidence.v1` JSON과 lowercase
SHA-256 sidecar, `latest.yml`, preview installer, preview blockmap의 exact
filename/size/SHA-256/SHA-512가 포함된다. transition run은 source와 pinned
`.trio-release-tooling` checkout의 before/after
`trio.git-source-integrity.v1` 결과와 동일한 tracked `treeSha`를 함께 남긴다.

실제 `preview_candidate_run_id`, `preview_evidence_sha256`,
`release_tooling_sha`, `TRIO_APPROVED_RELEASE_TOOLING_SHA` 값은 아직 live
Environment/run에서 관찰되지 않았다. 이 workflow는 latest run/latest artifact를
선택하지 않으며, exact run·artifact·source/evidence binding이 실패하면
private artifact도 transition QA도 중단한다. candidate evidence는 public
Release, stable `latest.yml` 또는 public pointer로 자동 승격되지 않는다.

stable job은 Apple Developer 준비 전 macOS release를 만들지 않으며, Linux package-signing policy가 확정되기 전 Linux stable update metadata도 promote하지 않는다. 현재 v0.1.4 public release metadata title은 정확히 **Trio v0.1.4**로 고정한다.

## 5. stable 보안 gate의 정확한 위치

현재 `scripts/release-channel-policy.mjs`는 모든 `vX.Y.Z` tag를 의도적으로 reject한다. 이 기존 gate는 signing provider가 준비될 때까지 유지한다. 템플릿을 적용하는 stable enable PR에서는 단순히 environment variable 하나로 이 차단을 푸는 대신, 아래 네 조건을 모두 만족하도록 policy script·CI test를 함께 변경한다.

1. source tag가 protected source revision을 가리킨다.
2. `stable-release` environment를 참조하는 protected `stable-promotion` job에서만 cloud signer OIDC/credential을 읽는다. 이 environment는 secret scoping/audit 경계이며 독립 reviewer 승인을 의미하지 않는다.
3. `npm run dist:win`이 cloud signing hook을 통해 installer를 만든 후, verifier가 expected publisher, valid timestamp, signer status, `latest.yml`의 filename·size·SHA-512를 모두 확인한다.
4. verifier output artifact를 promotion job의 입력으로 사용하고, 검증 실패 시 GitHub App token 생성·draft release·public publish 모두 실행하지 않는다.

> `--allow-stable` 같은 CLI flag 하나는 stable signing gate가 아니다. stable 허용은 **protected environment + signing evidence + verifier + promotion dependency**의 조합이어야 한다.

## 6. GitHub 웹 UI 적용 순서

1. `trio-releases` public repository를 만든다. source, issue export, private CI artifact, PFX, signing log 원본은 절대 넣지 않는다.
2. GitHub App을 만들고 `trio-releases`에만 설치한다. Repository permissions는 `Contents: Read and write`만 부여한다.
3. private `trio`의 Actions settings에 `TRIO_DELIVERY_APP_CLIENT_ID` variable과 `TRIO_DELIVERY_APP_PRIVATE_KEY` secret을 등록한다. key의 값은 이 문서·git·chat에 넣지 않는다.
4. private `trio`에 `stable-release` environment를 만들고 cloud signer의 OIDC trust 또는 credential을 이 environment로 한정한다. 1인 운영에서는 environment reviewer 설정을 독립 승인으로 표시하지 않으며, candidate digest 고정과 별도 promotion dispatch를 두 단계로 기록한다.
5. cloud signing vendor별 electron-builder hook과 `verify-windows-signing.ps1`를 실제 연결하고, unsigned fixture·wrong publisher·metadata mismatch가 모두 fail하는 test를 추가한다.
6. preview tag에서 package artifact·policy만 확인한다. preview가 public `trio-releases` Release나 stable `latest.yml`을 바꾸면 실패로 처리한다.
7. 별도 test version으로 Windows stable job을 승인·서명·draft 업로드까지 검증하고, anonymous metadata fetch와 installed-app update QA를 통과한 뒤에만 실제 stable promotion을 enable한다.

## 7. 적용 전·후 검증

| 검증 | 적용 전 | 적용 후 |
| --- | --- | --- |
| unsigned stable tag | policy가 fail | protected environment에 접근하지 못하고 fail |
| preview tag | private artifact만 생성 | public delivery Release·stable metadata를 변경하지 않음 |
| transition tag | private transition artifact만 생성 | Main-owned preview QA feed만 조회하고 public stable pointer를 변경하지 않음 |
| bad signer 또는 timestamp | n/a | verifier fail, draft도 생성하지 않음 |
| `latest.yml` mismatch | n/a | verifier fail, public publish 금지 |
| cross-repository 권한 | 기본 token은 target repo 접근 불가 | App token이 `trio-releases`에만 contents write |
| public reachability | private source asset은 404 가능 | published delivery `latest.yml`은 비인증 fetch 성공 |

## References

[1]: [GitHub Docs — About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

[2]: [GitHub Docs — GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)

[3]: [GitHub Docs — GitHub App authentication in Actions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app-in-a-github-actions-workflow)

[4]: [electron-builder — Auto Update](https://www.electron.build/docs/features/auto-update/)

## 8. v0.1.4 digest-bound promotion workflow

The source workflow is split into a read-only `preflight` job and a protected
`stable-promotion` job in [`.github/workflows/promote-stable.yml`](../../.github/workflows/promote-stable.yml).
The dispatch contract is deliberately narrow:

- `candidate_run_id` must be a positive decimal workflow-run ID;
- `tag` must be exactly `v0.1.4`;
- `evidence_sha256` must be lowercase SHA-256 for the canonical
  `release-evidence.json`;
- `confirmation` must be exactly `PUBLISH v0.1.4`.

The Release metadata contract is also exact. Creation uses `tag_name: v0.1.4`,
`name: Trio v0.1.4`, the byte-for-byte UTF-8 contents of
`candidate-assets/RELEASE_NOTES.md`, `draft: true`, `prerelease: false`, and
`generate_release_notes: false`. The anonymous post-publication check requires
the same tag/title/body bytes, `draft: false`, `prerelease: false`, and every
candidate asset byte to match its recorded size and digest.

Before the protected job is entered, the workflow checks out the exact source
tag and requires the candidate run to have `workflow_dispatch`, the exact
candidate workflow identity, matching `head_sha`, `completed`/`success`
conclusion, and exactly one unexpired artifact named
`trio-stable-candidate-<sourceSha>-<candidateRunId>`. It downloads that exact
artifact into a fresh directory, rejects symlinks and unexpected files, binds
the evidence sidecar to the manual digest, and reruns
`scripts/release-candidate-evidence.mjs verify`.

The protected job repeats the source/run/artifact/evidence checks before it
creates the delivery GitHub App token. The token is requested with
`TRIO_DELIVERY_APP_CLIENT_ID` and `TRIO_DELIVERY_APP_PRIVATE_KEY`, scoped to
owner `ksaeil2001`, repository `trio-releases`, and `Contents: write` only.
It does not create a source tag, build, sign, notarize or generate evidence.

### Draft and anonymous verification limitation

GitHub draft Release assets are not anonymously downloadable. The literal
sequence “draft → anonymous download → publish” is therefore impossible using
GitHub Releases. The implemented fail-closed sequence is:

1. create the draft and upload exact assets;
2. authenticated exact asset re-query, fresh download and Task 5A verification;
3. publish the one draft Release;
4. fetch public metadata, HTML and every exact asset without App authentication;
5. if any anonymous check fails, convert that Release back to draft in the same
   workflow step and fail;
6. dispatch `trio-release-published` only after anonymous checks pass.

The Release may be briefly public between steps 3 and 5. The rollback is not a
zero-exposure guarantee. This limitation is recorded in the promotion workflow
and Go/No-Go evidence rather than hidden behind a “draft verification” claim.

The rollback trap preserves the failing step status, calls the scoped App token
to patch the Release back to `draft: true`, and reports manual intervention if
that patch itself fails. `PROMOTION_OK=1` is set only after anonymous metadata,
HTML, exact-asset byte, and evidence checks; the `trio-release-published`
provenance dispatch follows that marker and never precedes it. No live public
repository, Release, signing service, or provenance run is recorded here.

The promotion workflow does not run in this checkout. The public repository,
GitHub App installation, protected environment, secrets and actual candidate
run remain external prerequisites; until they exist and a real run is
observed, v0.1.4 stable remains No-Go.

## 9. Public delivery provenance template

Install [`trio-releases-attest.yml`](../workflow-examples/trio-releases-attest.yml)
in the future public `ksaeil2001/trio-releases` repository. It validates the
repository-dispatch payload and accepts only `v0.1.4` / `0.1.4`, fetches the published Release, checks the exact
asset allowlist, verifies `SHA256SUMS`, `release-evidence.json` and its sidecar,
downloads the bytes without App authentication, and uses `actions/attest@v4`
with explicit `subject-path` entries. It sets `create-storage-record: false`
for the personal-account repository.

The template attests delivery bytes in the public repository. It does not turn
a private-source rebuild into public SLSA source provenance; the canonical
evidence sidecar is the link to the private source SHA. The promotion record
must retain the public attestation run and a successful consumer command such
as `gh attestation verify <asset> --repo ksaeil2001/trio-releases`.
