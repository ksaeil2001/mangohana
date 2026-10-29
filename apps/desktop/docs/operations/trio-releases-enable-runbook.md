# `trio-releases` 연결 및 updater URL 전환 Runbook

> **상태:** 구현 준비 가이드. `ksaeil2001/trio-releases`는 2026-08-18 기준 존재하지 않으며, 이 문서만으로 public repository 생성·GitHub App 생성·stable promotion을 수행하지 않는다.
> **절대 조건:** unsigned stable 차단은 유지한다. GitHub PAT, App private key, cloud-signing credential은 앱·source repository·chat·Issue·Release asset에 넣지 않는다.

## 1. 전환 후의 책임 분리

| 구성 요소 | private `ksaeil2001/trio` | public `ksaeil2001/trio-releases` |
| --- | --- | --- |
| source, tests, docs, CI 구현 | 유지 | 넣지 않음 |
| GitHub Release | source 내부 검증 또는 private preview 용도 | **signed Windows stable installer, `.blockmap`, `latest.yml`, public release notes만** |
| updater provider | source에서 delivery repository를 가리킴 | anonymous fetch 가능한 update metadata 제공 |
| write 권한 | source Actions 기본 token은 source read만 | GitHub App installation token이 Contents write만 가짐 |

이 모델에서 설치 앱은 source code에 대한 access 없이 `https://github.com/ksaeil2001/trio-releases/releases/latest`와 Release download asset만 읽는다. GitHub App은 source repository에 설치하지 않고 `trio-releases` 하나에만 설치한다.

## 2. public repository 준비

공개 여부는 설치 파일·update metadata가 누구나 다운로드 가능해진다는 의미다. source code나 원고는 공개하지 않지만, installer file name·version·release note은 public이 된다. 이 공개 전환은 release owner가 확인한 뒤에만 수행한다.

1. GitHub에서 `ksaeil2001/trio-releases` repository를 **public**으로 생성합니다.
2. README에는 “Trio public update delivery assets only; source code is maintained separately.”라고 명시합니다.
3. Issues, Discussions, Actions, Pages, package registry, sample source upload는 사용하지 않습니다.
4. `v*` tag Release만 만들고, draft asset 목록은 `.exe`, `.exe.blockmap`, `latest.yml`만 허용합니다. source archives는 delivery contract에 필요하지 않습니다.
5. 이미 작성된 [GitHub App 및 stable-release 설정 가이드](github-app-and-stable-environment-setup.md)를 따라 App을 `trio-releases`에만 설치하고 `Contents: Read and write`만 부여합니다.

repository 생성 자체는 공개 external operation이다. 생성 후 URL·visibility만 확인하고, private key나 signing credential 값은 공유하지 않습니다.

## 3. source build configuration 전환

repository와 App installation이 준비된 **stable enable PR**에서만 private source provider를 public delivery provider로 변경합니다.

```diff
  "publish": [
    {
      "provider": "github",
      "owner": "ksaeil2001",
-     "repo": "trio",
+     "repo": "trio-releases",
      "releaseType": "release"
    }
  ]
```

renderer의 “릴리스 보기” URL도 delivery repository로 바꿉니다.

```diff
-export const TRIO_RELEASE_URL = "https://github.com/ksaeil2001/trio/releases/latest";
+export const TRIO_RELEASE_URL = "https://github.com/ksaeil2001/trio-releases/releases/latest";
```

이 두 변경은 반드시 한 PR로 처리합니다. provider만 바꾸고 UI URL을 남기거나, UI만 바꾸고 provider를 남기면 error recovery와 actual updater feed가 서로 다른 repository를 가리킨다.

## 4. runtime channel 분리

현재 `createAutoUpdateController`는 packaged build이면 updater를 시작한다. preview/dev package가 public stable feed를 읽지 않도록, stable enable PR에서 **prerelease version updater를 명시적으로 disable**합니다.

```ts
function getReleaseChannel(version: string): "stable" | "preview" {
  return version.includes("-") ? "preview" : "stable";
}

const autoUpdateController = createAutoUpdateController({
  isPackaged: app.isPackaged,
  isSmokeTest: process.env.CI_SMOKE_TEST === "true",
  isUpdateChannelEnabled: getReleaseChannel(app.getVersion()) === "stable",
  onStateChange: publishUpdateState
});
```

controller는 `isUpdateChannelEnabled === false`면 provider에 network request하지 않고 `unavailable` 상태와 “preview/dev build에서는 stable update를 확인하지 않습니다.”라는 actionless UI message를 반환해야 한다. preview artifacts를 public delivery에 올리지 않는 현재 정책과 이 runtime guard가 함께 있어야 channel leak가 없다.

이 변경과 함께 최소한 다음 test를 추가한다.

| test | 기대 결과 |
| --- | --- |
| stable packaged app | `checkForUpdates()`가 provider에 한 번 요청 |
| preview packaged app | provider request 없음, `unavailable` state |
| `openRelease()` | `shell.openExternal()`이 `trio-releases/releases/latest`만 호출 |
| source URL regression | runtime config·shared status source에 `/trio/releases/latest` 문자열 없음 |

## 5. signed stable promotion의 artifact contract

Windows NSIS stable promotion job은 cloud signing을 **electron-builder packaging 중**에 수행한 뒤 다음 파일만 delivery draft Release로 upload합니다.

```text
Trio-Setup-X.Y.Z.exe
Trio-Setup-X.Y.Z.exe.blockmap
latest.yml
```

현재 Trio artifact name은 legacy 표기다. public delivery enable PR에서는 installer rename을 독립적으로 다루거나 compatibility policy를 정해야 한다. filename을 바꾸면 `latest.yml`의 filename·SHA-512·size와 signed installer가 모두 다시 생성·검증되어야 한다.

promotion job은 다음 순서를 반드시 지킨다.

1. protected `stable-release` environment reviewer 승인
2. cloud signed NSIS package, typecheck, packaged-app smoke
3. expected publisher·timestamp·signature·`latest.yml` hash/size verifier 통과
4. GitHub App token을 job 중에 발급
5. `trio-releases` draft Release에 asset upload
6. App token으로 draft asset allowlist 재확인
7. draft publish
8. **비인증** `latest.yml` GET과 Windows installed-app update QA

signing evidence 또는 metadata verification이 실패하면 step 4 이후가 실행되면 안 된다. public stable release가 `latest.yml` 없이 publish되는 경우도 fail-closed다.

## 6. cutover checklist

| 단계 | release owner 확인 |
| --- | --- |
| repository | `trio-releases` is public, source·secrets·debug config 없음 |
| App | delivery repo만 selected, Contents write만 부여 |
| environment | independent reviewer + self-review 방지 + cloud signing credential/OIDC scope |
| code | provider와 `TRIO_RELEASE_URL`이 `trio-releases`로 일치 |
| workflow | unsigned stable tag는 promotion 전에 fail, preview는 public release 생성 안 함 |
| assets | signed `.exe`, matching `.blockmap`, matching `latest.yml`만 draft upload |
| public fetch | incognito/anonymous `latest.yml` 200, checksum metadata 존재 |
| physical QA | installed old Windows build가 update available → download → restart → target version 확인 |

## 7. rollback

public Release를 delete하거나 `latest.yml`만 수정해 rollback하지 않는다. 잘못 publish된 version은 current latest update pointer가 될 수 있다. installer·metadata mismatch 또는 signing defect가 발견되면 새 signed corrective version을 만들고 stable promotion을 다시 수행한다. 긴급 visibility 대응이 필요한 경우에는 public Release를 draft로 되돌리기 전에 영향 범위와 existing client behavior를 기록하고, updater cache 및 partial download QA를 별도 수행한다.

## References

[1]: [electron-builder — Auto Update](https://www.electron.build/docs/features/auto-update/)

[2]: [GitHub Docs — About releases](https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases)

[3]: [GitHub Docs — GitHub App authentication in Actions](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app-in-a-github-actions-workflow)
