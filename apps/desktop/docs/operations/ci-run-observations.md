# GitHub Actions 실행 관찰 기록

> 2026-09-17 범위 갱신: 이 문서의 macOS 항목은 **non-MVP / future scope**이며 현재 MVP 지원이나 Release Gate 요구가 아닙니다. Linux 범위는 변경하지 않습니다. [현재 플랫폼 정책](mvp-platform-scope.md)을 우선합니다.
> 이전 시점의 실행 결과와 gate 상태는 역사적 기록이며 현재 후보 판정은 [최신 Release Gate 보고서](../release/2026-09-17-mvp-release-gate.md)를 따릅니다.

## 2026-08-18 — package-release #16

| 항목 | 관찰값 |
| --- | --- |
| 실행 | [Package, smoke test, and release Trio #16](https://github.com/ksaeil2001/trio/actions/runs/32117634774) |
| 기준 커밋 | `f42235a` (`ci: gate unsigned stable releases`) |
| 확인 시각 | 2026-08-18 08:47 GMT+9 |
| release-policy | 0초 완료로 표시됨; `main` push이므로 tag signing policy는 package 실행을 차단하지 않음 |
| 패키지 matrix | Windows x64·macOS x64·Linux x64 package/smoke가 모두 성공 |
| artifact | 3개 업로드 완료: `trio-windows-x64-16`, `trio-macos-x64-16`, `trio-linux-x64-16` |
| Release job | tag push가 아니므로 실행 대상이 아님 |

**최종 결과:** 성공, 총 5분 37초. `release-policy`는 0초 완료, package matrix는 3/3 완료, `Create GitHub Release`는 main push에서 0초 스킵 처리되었다.

## 2026-08-18 — package-release #17

| 항목 | 관찰값 |
| --- | --- |
| 실행 | [Package, smoke test, and release Trio #17](https://github.com/ksaeil2001/trio/actions/runs/32120360661) |
| 기준 커밋 | `812749e` (`fix: load electron updater through CommonJS interop`) |
| 최종 결과 | 성공, 총 3분 41초 |
| package matrix | Windows x64·macOS x64·Linux x64 package/smoke 모두 성공 |
| Release job | main push이므로 0초 스킵 |
| Windows artifact | `trio-windows-x64-17`, 96.7 MB, `sha256:c1c15e5df5be086ada86aa7253124661b1f1688d58c25e0c56d603c4bcbf4cde` |
| macOS artifact | `trio-macos-x64-17`, 231 MB, `sha256:1bb5487d4784ca2b5fd86737107e0e0416c38db13eca062c3845c4cefc4e8f13` |
| Linux artifact | `trio-linux-x64-17`, 118 MB, `sha256:fb11278c37b7613c2d22349631fa2f6c1ef3fef981e1cbec2aee2a58cf660bcc` |

세 플랫폼은 `actions/upload-artifact@v4`의 Node.js 20 target이 runner에서 Node.js 24로 강제 실행된다는 동일한 비차단 경고를 남겼다. artifact 업로드와 package smoke는 모두 성공했다.

현재 Actions annotation에는 `actions/upload-artifact@v4`가 Node.js 20 target을 사용하지만 runner에서 Node.js 24로 강제 실행됐다는 경고가 있다. 이 경고는 업로드 실패가 아니며, 액션의 향후 Node runtime 호환성 점검 항목으로 기록한다.
