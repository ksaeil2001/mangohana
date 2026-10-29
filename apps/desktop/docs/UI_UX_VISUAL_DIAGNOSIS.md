# UI/UX 체감 변화 점검

## Launcher 전후 비교

| 항목 | 변경 전 | 현재 구현 후 | 판단 |
|---|---|---|---|
| 첫 화면 제목 | 큰 제목 중심의 Workbench 소개 | 작은 `프로젝트` 제목과 컴팩트한 안내 | 정보 구조는 변경됐지만 전체 인상이 여전히 밝은 문서형 화면이라 변화가 작게 느껴질 수 있음 |
| 시작 동작 | 새 프로젝트가 단독 버튼으로 분리 | New Project와 Open Project를 같은 줄에 배치 | 버튼 그룹의 의미는 개선됐지만 시각적 강조가 충분하지 않음 |
| 최근 프로젝트 | 목록 중심 | 목록과 빈 상태는 유지 | 사용자가 프로젝트가 없으면 새 디자인의 차이를 체감하기 어려움 |
| 전반적 톤 | 밝은 회색 기반 | 밝은 회색 기반 | 보고서·슬라이드에서 설명한 다크 데스크톱 Workspace와 실제 Launcher 톤이 일치하지 않음 |

## 결론

현재 artifact에는 `b52fa81` 커밋의 UI 코드가 포함되어 있다. 그러나 화면상 변화는 Launcher 구조 일부와 작업 흐름 쪽에 집중되어 있으며, 첫 화면의 색감과 조형 언어가 기존 밝은 문서형 화면을 크게 벗어나지 못했다. 따라서 사용자가 "똑같다"고 느끼는 것은 타당하다.

다음 보완에서는 실제 제품 화면에 다크 Workspace 톤, 명확한 New/Open action hierarchy, 최근 작업 카드, 시각적으로 구분되는 Workspace canvas를 적용해 체감 차이를 크게 만든다.

## 보완 적용 및 재빌드

기본 테마 선택 로직을 변경하여, 저장된 사용자의 명시적 라이트 선택이 없으면 앱이 **다크 Master Workspace**로 시작하도록 수정했다. 브라우저에서 새 첫 화면을 확인한 결과, 어두운 Canvas 계열 배경, 밝은 텍스트, 블루 강조 버튼이 실제로 적용됐다.

- 보완 커밋: `eef001c` (`fix(ui): make master workspace dark by default`)
- 로컬 검증: TypeScript 검사, App 회귀 테스트 196개, 프로덕션 빌드 통과
- GitHub Actions: `Windows package verification #27`이 `main` 푸시로 시작됨

이 변경은 이전 artifact #26에는 포함되지 않으며, #27이 성공한 뒤 새 artifact를 받아야 한다.

## 최신 다운로드 artifact

`Windows package verification #27`은 **성공**했다. 최신 다운로드 파일은 `trio-windows-x64-27`이며, 크기는 약 **143 MB**, SHA-256 digest는 `5e2636455c3fc1cf1f8689d80e0ddb5f6d01979a9250535502b9fd3fb39d7ee2`이다. 이 artifact에는 `eef001c` 커밋의 다크 기본 Workspace 변경이 포함된다.

## Electron 42 기준 재검증

현재 잠금 파일과 로컬 설치 의존성은 **Electron 42.2.0**을 사용한다. 커밋 `89bb6a9`의 Windows package verification #28은 1분 58초 만에 성공했고 artifact 1개를 생성했다. GitHub Actions workflow 파일에 Electron 42 확인 단계를 추가하려 했으나, 현재 GitHub 연결 권한에는 workflow 파일을 푸시하는 권한이 없어 해당 검사 단계는 원격 저장소에 반영하지 못했다. 다만 기존 workflow는 `npm ci`를 실행하므로 `package-lock.json`에 고정된 Electron 42.2.0으로 artifact를 빌드한다.
