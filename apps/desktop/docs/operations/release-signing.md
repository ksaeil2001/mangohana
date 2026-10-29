# Trio Release Signing Gate

> **정책 상태:** v0.1.4 P0-01  
> **적용일:** 2026-08-18

## 목적

Trio는 Windows 코드 서명 credential과 클라우드 서명 제공자 연동이 검증되기 전까지 unsigned installer를 stable 채널에 게시하지 않는다. 이 정책은 Windows SmartScreen 경고를 제거한다고 주장하기 위한 것이 아니라, 사용자가 stable Release에서 검증되지 않은 배포물을 받지 않도록 하는 최소 release gate다.

## 태그 채널 규칙

| 태그 형식 | 채널 | 현재 허용 여부 | 사용 목적 |
| --- | --- | --- | --- |
| `vX.Y.Z` | stable | 차단 | 클라우드 서명 구현과 NSIS 서명 검증이 완료될 때만 허용 |
| `vX.Y.Z-preview.N` | preview | 허용 | Windows 우선 업데이트·설치·복구 QA용 unsigned 후보 |
| `vX.Y.Z-dev.N` | preview | 허용 | 개발·통합 검증용 unsigned 후보 |
| 그 외 | 해당 없음 | 차단 | 모호한 채널·배포 정책 우회를 방지 |

현재 private source workflow는 stable tag trigger 또는 Release mutation을 사용하지 않는다. `workflow_dispatch`의 stable-candidate 입력도 `scripts/release-channel-policy.mjs`가 unsigned stable tag를 계속 차단하는지 확인하고, 서명·공증·Pretendard·evidence가 모두 통과한 private candidate artifact만 생성한다. preview/dev QA는 public stable feed를 변경하지 않는다.

## 클라우드 서명 연동 준비 조건

클라우드 서명 제공자는 아직 선택하지 않았다. 제공자가 확정되기 전까지 workflow에 provider CLI, 인증서 파일, private key 또는 인증 정보를 임의로 추가하지 않는다. 다음 항목을 결정한 뒤 별도 P0-01 PR에서 stable gate를 “차단”에서 “서명·검증”으로 전환한다.

| 결정 | 완료 증거 |
| --- | --- |
| 제공자·계정·비용 모델 | 개인 개발자 김세일의 승인과 계정 소유자 기록 |
| 인증 방식 | OIDC 또는 provider가 지원하는 단기 토큰 방식; 장기 private key의 저장소 보관 금지 |
| Windows 서명 명령 | 생성된 NSIS `.exe`에 서명하고 타임스탬프를 포함하는 CI 명령 |
| 검증 명령 | Windows runner의 `signtool verify /pa /all` 또는 동등한 provider 검증 결과 |
| Release 증거 | checksum·서명 검증 요약을 Release 자산과 노트에 게시 |

민감한 credential은 GitHub Actions Secrets 또는 provider의 승인된 identity federation에만 설정한다. 채팅, Git, Issue, artifact, release note, workflow log에는 PFX, private key, 인증서 비밀번호 또는 장기 토큰을 넣지 않는다.

## 테스트

다음 명령은 local policy test로 stable 차단·preview 허용·모호한 태그 거부를 검증한다.

```bash
npm run test:release-policy
```

workflow 수준에서는 preview tag를 푸시해 패키징·smoke·prerelease 업로드가 성공하는지 확인한다. stable tag는 provider integration이 완료되기 전에는 만들지 않는다. 이 policy gate를 확인하기 위해 stable tag를 시험 생성하지 않고 local policy test로 차단 동작을 검증한다.

## Public delivery and promotion boundary

Signing evidence is an input to the private candidate bundle, not permission to
publish by itself. The separate [digest-bound promotion workflow](../../.github/workflows/promote-stable.yml)
requires the exact source tag, successful candidate run, exact artifact name,
evidence sidecar digest and `PUBLISH v0.1.4` confirmation before creating the
delivery App token. It creates a draft, performs authenticated exact
re-download verification, publishes once, and performs anonymous checks. If an
anonymous check fails, the same step returns the Release to draft and fails.

GitHub draft assets are not anonymously downloadable, so a short public interval
between publish and anonymous verification is possible. This is documented as a
limitation, not presented as zero-exposure rollback. Public attestation is
dispatched only after anonymous verification and remains an external evidence
item until the future `trio-releases` workflow run is observed.

The promotion workflow is not executed locally. No signing credential, GitHub
App, public repository, protected environment, tag or Release was created by
this change; unsigned stable remains blocked.
