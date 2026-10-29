# Trio Windows 업데이트 확인 실패 진단

## 1. 관찰 결과

`trio-windows-x64-17`을 실행하면 앱은 시작에 성공하지만 자동 업데이트 상태 UI가 “업데이트를 확인하지 못했습니다”를 표시했다. 이는 `autoUpdater.checkForUpdates()`에서 발생한 예외를 앱이 안전하게 잡아 사용자 상태로 변환한 결과이며, 메인 프로세스 crash 또는 Windows dump 생성은 아니다.

## 2. 확인한 사실과 원인

| 확인 항목 | 결과 | 의미 |
| --- | --- | --- |
| 저장소 가시성 | `ksaeil2001/trio`는 private | 설치된 일반 앱은 GitHub Release asset에 인증 없이 접근할 수 없음 |
| v0.1.3 Release | published non-prerelease이며 `latest.yml`과 NSIS setup asset이 존재 | 메타데이터 누락이 원인은 아님 |
| 비인증 `latest.yml` URL | GitHub Release download URL이 HTTP 404 반환 | private asset 접근 제한과 일치 |
| 인증된 GitHub CLI | 같은 `latest.yml`을 정상 다운로드 | asset 자체는 유효하며 접근 자격 차이가 원인 |
| 앱 자체 파일 로그·crashReporter | `crashReporter`, `setAppLogsPath`, `electron-log` 설정 없음 | 이번 오류는 catch된 업데이트 확인 실패이므로 Trio 전용 log/dump가 생성되지 않음 |

**분류:** `UPDATER_PRIVATE_RELEASE_ASSET_UNREACHABLE` — private GitHub Release를 provider로 쓴 패키지 앱이 인증되지 않은 상태에서 update metadata를 받을 수 없다.

## 3. 로그·덤프 경로 점검 범위

이번 오류는 dump를 기대할 사건이 아니다. 그래도 별도 프로세스 crash가 의심될 때만, QA 장비의 현재 사용자 범위에서 아래 Windows Error Reporting 위치를 조회한다.

```powershell
$paths = @(
  "$env:LOCALAPPDATA\CrashDumps",
  "$env:LOCALAPPDATA\Microsoft\Windows\WER\ReportArchive",
  "$env:LOCALAPPDATA\Microsoft\Windows\WER\ReportQueue"
)
$paths | ForEach-Object {
  if (Test-Path $_) { Get-ChildItem $_ -Recurse -ErrorAction SilentlyContinue }
}
```

덤프·WER 보고서에는 사용자 경로, 메모리 조각 또는 프로젝트 정보가 들어갈 수 있다. 공개 Issue나 채팅에 업로드하지 않는다. 파일명·생성시각·크기·예외 코드만 먼저 기록하고, 실제 파일 공유는 별도 승인 절차가 있을 때만 고려한다.

## 4. 안전한 진단 절차

1. Windows artifact 설치본에서 업데이트 확인 실패 상태를 재현한다.
2. artifact 이름·앱 버전·발생시각·인터넷 연결 상태·상태 UI 문구만 기록한다.
3. DevTools console, token, API key, 전체 사용자 경로, 실제 원고는 수집하지 않는다.
4. 위 WER 경로에서 새 crash 파일이 없으면 오류는 catch된 network/update provider failure로 분류한다.
5. private Release asset URL을 브라우저 로그아웃 상태나 별도 비인증 HTTP client에서 조회해 404 여부만 확인한다. 인증 token을 URL·로그·Issue에 넣지 않는다.

## 5. 개선 방향과 release blocker

| 선택지 | 적합성 | 주의점 |
| --- | --- | --- |
| public GitHub Release assets | 개인 사용자 대상 자동 업데이트에 적합 | release asset·update metadata가 공개됨 |
| 인증된 자체 update server | private 배포에 적합 | token을 앱에 정적으로 포함하지 않고 사용자/조직 인증·서명 검증을 설계해야 함 |
| private GitHub Release + 앱 내 PAT | 부적합 | extractor가 가능한 credential을 배포물에 넣게 되어 사용하면 안 됨 |
| CI artifact | 수동 QA에만 적합 | stable update feed 또는 일반 사용자 배포 수단이 아님 |

현 정책상 unsigned stable release는 차단되어 있다. cloud signing과 공개/인증 update delivery 설계가 확정되기 전에는 CI artifact에서 자동 업데이트를 성공 조건으로 삼지 않는다. P0-02의 실제 업데이트 전환 QA는 feed 접근 모델을 확정한 뒤에 재개한다.
