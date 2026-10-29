# Trio UI/UX 시각 검토 기록

## Launcher 기준선 비교

1440×900 headless Chromium 기준으로 기존 Launcher와 통합 후 Launcher를 비교했다. 변경 전 화면은 큰 제품 소개형 heading, 넓은 onboarding 영역, start card와 빈 recent 영역이 세로 공간을 크게 차지했다. 변경 후에는 **Trio 표식과 프로젝트 제목**, **New/Open의 명확한 두 작업**, **Recent 목록**, **TXT 대체 흐름**만을 순차적으로 제시한다.

| 항목 | 변경 전 | 변경 후 | 검토 결과 |
|---|---|---|---|
| 최상위 목적 | 소개형 “번역 프로젝트를 시작합니다.” heading | Project Launcher의 New/Open/Recent 흐름 | 별도 Dashboard 없이 프로젝트 진입점으로 수렴 |
| 정보 계층 | 헤드라인과 Start card가 시선을 점유 | 앱 표식 → Start action → Recent 순서 | 작업 버튼이 즉시 보임 |
| 시각 밀도 | 큰 여백과 넓은 카드 영역 | 얇은 구분선과 compact toolbar형 헤더 | 데스크톱 도구 톤에 더 적합 |
| 보존 기능 | New, Open, Recent, TXT, 환경 준비, 설정 | 동일 callback과 진입점을 보존 | 기능 삭제 없음 |

> 캡처 파일은 `/home/ubuntu/trio_launcher_baseline.png` 및 `/home/ubuntu/trio_launcher_after.png`에 보관되어 있다. Headless 환경의 파란 focus outline은 현재 포커스된 요소를 나타내며 제품 고유 장식으로 판단하지 않았다.

## 다음 시각 검토 대상

프로젝트 생성 화면과 content가 있는 Workspace는 실제 Electron 세션 및 로컬 파일 선택이 필요하다. 구현 뒤에는 New Project, Empty Workspace, Text Selected, OCR/Review, 하단 Review drawer 순서로 점검한다.
