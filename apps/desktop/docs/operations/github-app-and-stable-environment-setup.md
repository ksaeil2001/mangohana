# GitHub App 및 `stable-release` Protected Environment 설정 가이드

> **대상:** private source `ksaeil2001/trio`에서 build·sign·verify를 수행하고 public `ksaeil2001/trio-releases`에 검증된 Windows stable Release만 게시하려는 운영자  
> **원칙:** source code, GitHub App private key, cloud signing credential, PAT를 installer·repository·Issue·채팅에 넣지 않는다. unsigned stable tag는 계속 차단한다.

## 1. 시작 전 확인: 1인 2단계 운영 계약

v0.1.4는 독립 reviewer가 없는 1인 2단계 release다. 첫 단계는 immutable
candidate와 evidence digest를 만들고, 두 번째 단계는 release owner가 exact
inputs로 수동 dispatch를 실행하는 promotion이다. `stable-release`
environment는 두 번째 job에만 App private key와 client ID를 제공하고 접근·실행
기록을 남기는 secret scoping/audit 경계다. environment approval이나 독립
승인을 현재 release gate로 주장하지 않는다.

GitHub plan에 따라 environment secret과 선택적 protection UI가 달라질 수
있지만, Required reviewers와 Prevent self-review는 현재 v0.1.4 gate가 아님을
전제로 한다. 해당 기능이 보이지 않아도 이 1인 2단계 계약 자체는 바뀌지 않는다.[1]

| 확인 항목 | 통과 조건 | 통과하지 못하면 |
| --- | --- | --- |
| private `trio`의 **Settings → Environments** 접근 | `stable-release` 생성 화면과 environment secret/variable 설정 화면이 보임 | App credential을 protected job 범위로 제한할 수 없어 stable 유지 차단 |
| 1단계 candidate | exact source SHA·evidence digest·candidate artifact가 고정되고 검증됨 | 두 번째 promotion dispatch를 실행하지 않음 |
| 2단계 manual dispatch | `candidate_run_id`, `v0.1.4`, evidence SHA, `PUBLISH v0.1.4`가 exact contract를 통과함 | stable promotion을 실행하지 않음 |
| public delivery repository | `ksaeil2001/trio-releases`가 public이며 source가 없음 | App을 설치·asset을 게시할 destination이 없음 |

> 선택적 미래 운영 모델: 조직이 독립 reviewer를 추가하기로 결정하면 별도
> change-management 문서와 GitHub plan을 검토할 수 있다. 이는 현재 1인
> 2단계 v0.1.4 gate가 아니며, 현재 설정에 Required reviewers 또는 Prevent
> self-review를 요구하는 근거로 사용하지 않는다.

## 2. GitHub App의 역할과 최소 권한

App은 **private source repository에 설치하지 않는다.** stable promotion job이 실행 중에만 installation token을 발급하고, 그 token은 public delivery repository의 Release·asset 관리에만 사용한다. `GITHUB_TOKEN`은 workflow repository 범위에 한정되므로 이 cross-repository 경계에는 적합하지 않다.[2]

| 설정 | 권장 값 | 이유 |
| --- | --- | --- |
| App 표시 이름 | `Trio Public Delivery Publisher` 같은 고유 이름 | audit log에서 역할을 식별 |
| 소유자 | `ksaeil2001` 개인 계정 | delivery repository의 소유자와 동일 |
| 설치 범위 | **Only on this account** | 다른 계정 설치를 허용하지 않음 |
| OAuth callback / device flow | 사용 안 함 | user token이 필요 없는 CI-to-Release 작업 |
| Webhooks | **Active 해제**, event 구독 없음 | webhook receiver가 없고 event-driven 동작도 필요 없음 |
| Repository permissions | **Contents: Read & write**만 | Release·asset 관리에 필요한 최소 범위 |
| 그 밖의 repository / organization / account 권한 | **No access** | Actions, Workflows, Administration, Secrets, Pull requests 등 불필요 권한 배제 |

`Contents` permission은 repository contents, downloads, releases와 merges에 대한 access를 포함한다. workflow file을 App token으로 고치지 않는 설계이므로 `Workflows: write`는 요구하지 않는다.[3]

## 3. GitHub App 생성 절차

### 3.1 App 등록

1. GitHub 우측 상단 프로필 메뉴에서 **Settings**로 이동합니다.
2. 좌측 **Developer settings → GitHub Apps → New GitHub App**을 선택합니다.
3. 이름에는 `Trio Public Delivery Publisher`처럼 명확하고 고유한 이름을 입력합니다. 설명은 “Publishes verified Trio release assets to the public delivery repository.” 정도로 적습니다.
4. Homepage URL에는 계정 또는 public delivery repository URL을 넣습니다. OAuth callback, Setup URL, Device Flow는 비워 둡니다.
5. **Active** webhook을 끕니다. 수신 서버가 없으므로 webhook URL·secret도 등록하지 않습니다.
6. **Repository permissions**에서 `Contents`만 `Read and write`로 선택하고, 모든 나머지 권한은 `No access`인지 다시 확인합니다.
7. **Where can this GitHub App be installed?**에서는 `Only on this account`를 선택한 후 **Create GitHub App**을 누릅니다.

GitHub App은 기본적으로 권한이 없으므로 필요한 최소 권한만 명시적으로 선택해야 한다.[3] 등록 화면의 세부 경로와 설치 범위 선택은 GitHub의 App registration 절차를 따른다.[4]

### 3.2 public delivery repository에만 설치

1. 생성한 App의 설정 화면에서 **Install App**을 선택합니다.
2. 설치 대상 account로 `ksaeil2001`을 선택합니다.
3. **Only select repositories**를 선택합니다.
4. 목록에서 **`trio-releases`만** 선택합니다. private source `trio`는 선택하지 않습니다.
5. 설치 후 account Settings → **Applications → Installed GitHub Apps → Configure**에서 repository access가 `trio-releases` 하나인지 재확인합니다.

App installation은 App이 요청한 권한과 별도로 어떤 repositories에 접근할지를 정한다. 설치 후에도 `Only select repositories`로 access 목록을 축소·변경할 수 있다.[5]

### 3.3 private key를 environment secret으로 보관

1. App 설정의 **Private keys → Generate a private key**를 클릭합니다. PEM 파일은 한 번만 다운로드됩니다.
2. PEM 파일을 개인 password manager 또는 접근 제어된 vault에 보관합니다. 일반 텍스트 메모, sync folder, repository, email, chat에는 두지 않습니다.
3. 아래 §4의 `stable-release` environment를 만든 뒤, `trio` repository의 **Settings → Environments → stable-release → Environment secrets → Add secret**에서 다음 이름으로 전체 PEM 내용을 등록합니다.

| Environment secret/variable | 값 | 노출 규칙 |
| --- | --- | --- |
| `TRIO_DELIVERY_APP_PRIVATE_KEY` | GitHub App PEM 전체 | `stable-release` job에만 제공. 출력·artifact·로그에 쓰지 않음 |
| `TRIO_DELIVERY_APP_CLIENT_ID` | App client ID | secret은 아니지만 같은 environment variable로 제한 가능 |
| cloud signing credential / OIDC config | vendor별 값 | stable environment 또는 vendor trust에만 두며, vendor 확정 전 이름을 만들지 않음 |

GitHub은 App private key가 application authentication의 핵심 secret이며 hard-code하지 말 것을 권고한다. private key는 만료되지 않으므로 compromise 시 새 key를 추가·secret 교체·검증한 뒤 기존 key를 삭제하는 rotation 절차가 필요하다.[6]

### 3.4 workflow에서 token을 발급하는 방식

템플릿의 `promote-windows-stable` job은 `stable-release` environment를 참조한 뒤, GitHub-owned action으로 단명 installation token을 발급합니다.

```yaml
environment: stable-release

- id: delivery-token
  uses: actions/create-github-app-token@bcd2ba49218906704ab6c1aa796996da409d3eb1 # v3
  with:
    client-id: ${{ vars.TRIO_DELIVERY_APP_CLIENT_ID }}
    private-key: ${{ secrets.TRIO_DELIVERY_APP_PRIVATE_KEY }}
    owner: ksaeil2001
    repositories: trio-releases
    permission-contents: write
```

환경 approval 전에는 이 job이 실행되지 않고 environment secret도 제공되지 않는다.[1] `repositories: trio-releases`와 `permission-contents: write`를 명시해 token의 usable scope를 줄이며, token은 job 종료 시 revoke되는 기본 동작을 변경하지 않는다.

## 4. `stable-release` protected environment 설정

현재 private source workflow는 candidate bundle만 만들고 public Release를 생성하지 않는다. 이 environment는 signing credential 경계이며 독립 reviewer가 있는 것으로 표시하지 않는다. 1인 운영의 promotion은 candidate manifest digest를 고정한 뒤 별도의 수동 dispatch에서 같은 digest를 재검증하는 2단계 절차로 기록한다.

### 4.1 생성 경로

private `trio` repository에서 **Settings → Environments → New environment**로 이동해 이름을 정확히 `stable-release`로 입력한 뒤 **Configure environment**를 선택합니다. repository owner 또는 organization admin만 environment를 구성할 수 있다.[7]

먼저 workflow가 이 environment를 참조하기 전에 UI에서 protection rules·secrets를 모두 설정합니다. 존재하지 않는 environment를 workflow가 먼저 참조하면 GitHub가 아무 protection rule이나 secret 없이 environment를 만들 수 있으므로, 이를 설정 완료로 간주하면 안 된다.[7]

### 4.2 권장 protection rule

| 화면 항목 | 권장 값 | 목적 |
| --- | --- | --- |
| Environment secrets/variables | `TRIO_DELIVERY_APP_PRIVATE_KEY`와 `TRIO_DELIVERY_APP_CLIENT_ID`만 등록 | 두 번째 `stable-promotion` job에만 App credential 제공 |
| Required reviewers | **현재 사용하지 않음** | 현재 1인 2단계 release를 독립 승인으로 표시하지 않음 |
| Prevent self-review | **현재 요구하지 않음** | 두 번째 단계는 release owner의 수동 dispatch이며 독립 승인이라고 주장하지 않음 |
| Deployment branches and tags | 설정 시 exact stable tag 정책과 일치하도록 제한 | preview가 `stable-release`를 참조하지 않도록 보조 경계 구성 |
| Allow administrators to bypass | 기본값 0; 선택적 운영 정책으로만 검토 | environment secret 범위와 candidate/evidence 검증이 현재 핵심 경계 |
| Wait timer | 기본값 0분 | 시간 지연보다 signature·metadata 증거를 우선; 필요 시 운영 정책으로 추가 |
| Custom deployment protection | 현재 사용 안 함 | cloud signer 또는 change-management system이 확정될 때까지 확장하지 않음 |

GitHub의 tag pattern은 glob이고 regex가 아니다. 이 workflow의 stable
promotion은 수동 입력에서 tag를 정확히 `v0.1.4`로 검증하고, preview job은
`environment: stable-release`를 참조하지 않는다. environment rule을 추가하더라도
이 exact tag·candidate/evidence 검증을 대체하거나 독립 승인으로 표시하지 않는다.[1]

### 4.3 secret·variable 등록

현재 1인 2단계 계약에서는 별도 approval rule을 전제로 하지 않습니다. **Environment secrets**에 `TRIO_DELIVERY_APP_PRIVATE_KEY`를, **Environment variables**에 `TRIO_DELIVERY_APP_CLIENT_ID`를 추가하면 해당 environment를 참조하는 `stable-promotion` job에만 제공됩니다. environment 접근과 secret 사용은 audit 기록으로 남깁니다.[1]

cloud signing vendor가 정해지기 전에는 placeholder secret을 만들지 않습니다. vendor가 OIDC federation을 지원하면 static credential보다 `id-token: write`가 있는 protected job의 workload identity를 우선 검토합니다. vendor가 key/password를 요구한다면 정확한 secret 이름·rotation owner·revocation 절차를 release signing 문서에 추가한 뒤에만 등록합니다.

### 4.4 workflow 연결 확인

현재 promotion 계약에서 credential이 필요한 job은 `stable-promotion` 하나이며,
이 job만 `environment: stable-release`를 참조합니다.

```yaml
stable-promotion:
  environment: stable-release
  permissions:
    contents: read
    actions: read
```

`preview-package`에는 environment, App secret, `id-token: write`, public delivery token이 없어야 합니다. preview tag는 private artifact만 만들며 public `trio-releases` Release 또는 stable `latest.yml`을 변경하지 않습니다.

## 5. 1인 2단계의 실제 운영 절차

1. release owner가 protected `main`에서 version·release note·signing hook 변경을 검토·병합합니다.
2. release owner가 exact source tag `v0.1.4`에서 candidate workflow를 실행하고 source SHA·asset·evidence digest를 고정합니다.
3. candidate run이 성공한 뒤 release owner가 `candidate_run_id`, exact tag, lowercase evidence SHA와 `PUBLISH v0.1.4`를 입력해 `promote-stable.yml`을 수동 dispatch합니다.
4. `stable-promotion` job은 `stable-release`에서 App credential을 읽고, 같은 source/candidate/evidence를 다시 검증합니다. environment는 secret scoping과 audit 기록을 제공하며 별도 reviewer 승인을 의미하지 않습니다.
5. workflow는 public delivery App token을 발급하고 draft Release 생성, exact asset upload, authenticated metadata/byte verification, publish, anonymous verification을 순서대로 수행합니다. anonymous 검증 실패 시 같은 단계에서 Release를 draft로 되돌리고 실패합니다.
6. 모든 검증이 통과하면 exact `trio-release-published` payload를 dispatch합니다. release owner는 tag·asset filename·checksum·설치 QA 결과를 release record에 남기며 key·token·실제 프로젝트 데이터는 기록하지 않습니다.

선택적 미래 운영 모델에서 독립 reviewer와 required reviewer 절차를 별도 도입할 수
있지만, 그것은 현재 1인 2단계 v0.1.4 gate가 아니다. 현재 workflow를
`Waiting for review`, `Approve and deploy`, 또는 Prevent self-review 전제로
운영하지 않는다.

## 6. 설정 완료 전 점검표

| 점검 | 기대 결과 |
| --- | --- |
| App permission | `Contents: Read & write`만, webhook·OAuth 미사용 |
| App installation | `trio-releases`만 selected, `trio` 미선택 |
| key storage | PEM은 `stable-release` environment secret + protected vault에만 존재 |
| environment contract | `stable-promotion`만 secret을 읽고, 1인 2단계 source/evidence 재검증과 audit 기록을 수행; independent reviewer는 현재 요구하지 않음 |
| preview separation | preview workflow/job은 environment·App token·public publish step 없음 |
| stable evidence | signing hook·signature verifier·`latest.yml` checksum test가 모두 존재 |
| failure behavior | signer/verifier/candidate/evidence 검증 실패 시 public Release가 생기지 않음 |
| rotation | 새 App key → environment secret 교체 → controlled dry-run → 기존 key revoke 순서가 준비됨 |

## References

[1]: [GitHub Docs — Deployments and environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments)

[2]: [GitHub Docs — GITHUB_TOKEN](https://docs.github.com/en/actions/concepts/security/github_token)

[3]: [GitHub Docs — Choosing permissions for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)

[4]: [GitHub Docs — Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)

[5]: [GitHub Docs — Reviewing and modifying installed GitHub Apps](https://docs.github.com/en/apps/using-github-apps/reviewing-and-modifying-installed-github-apps)

[6]: [GitHub Docs — Managing private keys for GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)

[7]: [GitHub Docs — Managing environments for deployment](https://docs.github.com/en/actions/deployment/targeting-different-environments/using-environments-for-deployment)

## 7. Exact 1-person 2-stage promotion contract

The protected environment is not an independent reviewer in this project. It
scopes the delivery App private key and records the second, manually dispatched
stage after an immutable candidate digest has been fixed. Do not describe the
environment approval as independent review or self-review prevention.

The source workflow is [`.github/workflows/promote-stable.yml`](../../.github/workflows/promote-stable.yml).
Its required inputs are `candidate_run_id`, exact tag `v0.1.4`, lowercase
`evidence_sha256`, and exact confirmation `PUBLISH v0.1.4`. The first job has
`contents: read` and `actions: read` only. It requires a successful
`workflow_dispatch` run of the exact candidate workflow, matching source/tag
SHA and package version, and one non-expired exact candidate artifact.

Only the dependent `stable-promotion` job references `stable-release` and the
delivery App credentials. The `actions/create-github-app-token` action is pinned
to an immutable commit and receives only:

```yaml
owner: ksaeil2001
repositories: trio-releases
permission-contents: write
```

No Actions, Workflows, Administration, Secrets or source-repository write
permission is requested. The token is created only after the second fresh
candidate/evidence verification succeeds.

### Public verification and rollback

Because GitHub draft Release assets cannot be anonymously downloaded, the
workflow performs authenticated draft verification first, publishes once, then
performs anonymous metadata and exact-asset verification. An anonymous failure
immediately invokes the scoped App token to return the Release to draft in the
same step and fails the run. This can leave a short public interval; it is not a
zero-exposure rollback guarantee. Public provenance is dispatched only after
anonymous verification succeeds.

The public repository must install
[`trio-releases-attest.yml`](../workflow-examples/trio-releases-attest.yml),
which uses pinned `actions/attest@v4` and explicit subject paths. Until the
repository/App/environment are actually created and a real promotion plus
attestation run is observed, the environment setup is incomplete and stable is
No-Go.
