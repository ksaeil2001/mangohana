# A-Grade Translation Workbench Audit and Upgrade Prompt

아래 프롬프트를 새 Codex 세션에 그대로 붙여넣어 실행한다.

```text
Superpowers와 gstack을 사용해서 현재 앱의 사용자 편의성 문제를 실제 화면 기준으로 파악하고, 개인용 캐릭터 대사 번역 편집기를 A등급 작업대로 끌어올려라.

작업 대상:
- Repo root: C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기
- 실제 구현 worktree: C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor
- 실제 이미지: C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\review-assets\page-001.png
- 주요 UI 파일:
  - src/renderer/App.tsx
  - src/renderer/styles.css
  - src/renderer/components/ProjectActionsPanel.tsx
  - src/renderer/components/ImageImportPanel.tsx
  - src/renderer/components/PageImagePanel.tsx
  - src/renderer/components/DialogueTable.tsx
  - src/renderer/components/LineDetailPanel.tsx
  - src/renderer/components/CharacterDictionaryPanel.tsx
  - tests/renderer/App.test.tsx
  - vite.config.ts

필수 방법:
1. 먼저 Superpowers `writing-plans`를 사용해서 구현 계획을 작성하고, `docs/superpowers/plans/YYYY-MM-DD-a-grade-translation-workbench.md`에 저장한다.
2. 구현은 Superpowers `subagent-driven-development`가 가능하면 그 방식으로, 아니면 `executing-plans` 기준으로 task-by-task 진행한다.
3. 완료 전에는 반드시 Superpowers `verification-before-completion` 원칙을 적용한다. 검증 증거 없이 완료, 성공, A등급이라고 말하지 않는다.
4. gstack은 `browse`를 사용해서 실제 렌더링 화면, screenshot, snapshot, console, overflow, DOM metrics를 검증한다.
5. gstack `design-review`는 보조로만 사용한다. 미감/색감/AI Slop 중심으로 흐르지 말고, 번역 작업자 사용자 편의성 중심으로만 판단한다.
6. 일반 기능 QA, 모바일 QA, 태블릿 QA, 랜딩페이지식 디자인 평가는 하지 않는다.

평가 범위:
- 1440px 이상 데스크톱만 평가한다.
- 확인 viewport:
  - 1440x900
  - 1600x900
  - 1920x1080
- 앱은 랜딩페이지/대시보드처럼 만들지 않는다.
- 조용하고 밀도 있는 번역 작업대여야 한다.
- 핵심 반복 흐름은 “이미지 확인 → 대사 선택 → 원문/AI/수정문 비교 → 사용자 수정 → 다음 라인 이동”이다.

초기 확인:
1. `C:\Users\ksaei\.gstack\repos\gstack\VERSION`과 `C:\Users\ksaei\.gstack\last-update-check`를 확인한다.
2. `C:\Users\ksaei\.gstack\repos\gstack\browse\dist\browse.exe`가 존재하는지 확인한다.
3. 이 repo root에는 `.gstack` OneDrive reparse directory 충돌이 있을 수 있다. `browse status`는 `C:\Users\ksaei` 또는 `C:\Users\ksaei\.gstack\repos\gstack`에서 실행한다.
4. 현재 worktree의 dirty state를 확인한다. 사용자 변경을 되돌리지 말고, 필요한 파일만 읽고 수정한다.

실행 명령:
- 작업 디렉터리: `C:\Users\ksaei\OneDrive\문서\영어,일본어 성인 대사 번역기\.worktrees\codex-mvp-editor`
- dev server:
  - `npm run dev`
  - 기본 URL: `http://localhost:4173`
- 타입/테스트:
  - `npm run typecheck`
  - `npm test`
- ngrok:
  - 가능하면 ngrok URL도 확인한다.
  - Vite `allowedHosts` 등으로 막히면 이유를 파일로 기록하고 localhost 기준으로 평가한다.

실제 이미지 연결 조건:
1. 실제 이미지 업로드/연결 흐름을 우선 사용한다.
2. 브라우저 테스트 모드에서 실제 업로드가 어렵다면 앱 코드는 검증 전용으로 바꾸지 말고, 검증용 상태 주입 또는 정적 이미지 서버를 사용해 `.page-image-panel img`에 실제 이미지가 렌더링되도록 한다.
3. 이미지가 실제로 로드된 상태에서만 최종 등급을 판단한다.
4. `.page-image-panel img`의 `naturalWidth`, `naturalHeight`, `clientWidth`, `clientHeight`를 1440/1600/1920 각각에서 기록한다.

반드시 계측할 selector:
- document
- `.left-panel`
- `.right-panel`
- `.table-panel`
- `.page-workspace`
- `.page-dialogue-workspace`
- `.table-row`
- `.row-metadata`
- `.page-image-panel`
- `.page-image-stage`
- `.page-image-panel img`
- `.line-detail-panel`
- `.context-panel`
- `.button-grid`

각 selector마다 기록할 항목:
- clientWidth
- scrollWidth
- overflowX 여부
- 필요하면 clientHeight
- 필요하면 scrollHeight
- 필요하면 overflowY 여부

변경 전 감사:
1. dev server를 실행한다.
2. 실제 이미지가 연결된 상태를 만든다.
3. 1440x900, 1600x900, 1920x1080 각각에서 screenshot을 저장한다.
4. snapshot을 저장한다.
5. console warning/error를 저장한다.
6. 위 selector metrics를 JSON으로 저장한다.
7. 50개 평가 항목을 Pass/Partial/Fail로 판정한다.
8. Fail 또는 A등급을 막는 Partial을 blocker로 분류한다.

구현 방향:
- 첫 작업 순서를 TXT 불러오기 → 프로젝트 저장 → 이미지 업로드 → 대사 수정으로 명확히 만든다.
- 왼쪽 패널은 프로젝트 관리보다 작업 시작/상태 안내 중심으로 정리한다.
- 저장 전/후 이미지 업로드 가능 상태를 명확히 보여준다.
- 이미지 업로드가 막혔을 때 이유와 다음 행동을 같은 위치에서 보여준다.
- 이미지 패널은 번역 참고물로 충분히 보이되 대사 목록을 아래로 밀어내지 않게 한다.
- 1600/1920에서 이미지가 의미 없이 가로로만 늘어나지 않게 max-width, max-height, layout grid를 조정한다.
- 첫 viewport 안에 실제 이미지, 페이지 요약, 대사 목록 첫 row가 함께 보이게 한다.
- 대사 목록 안에서 원문/AI 번역/사용자 수정문 비교가 빠르게 되도록 row 구조를 개선한다.
- 사용자 수정문이 너무 짧게 잘리지 않게 한다.
- 선택 row를 현재 편집 대상이라고 즉시 알 수 있게 한다.
- 선택 row와 오른쪽 inspector가 같은 대상을 보여준다는 연결감을 만든다.
- 오른쪽 inspector는 보조 상세 편집 패널로 축소하고, 목록과 중복되는 “두 번째 작업장” 느낌을 줄인다.
- 반복 작업 흐름을 위해 선택 row, 수정 입력, 다음 라인 이동, 상태 변경이 가까운 위치에서 이어지게 한다.
- 검색/화자 필터/상태 필터/문제 라인만 보기는 세로 공간을 과하게 먹지 않도록 한다.
- 저장, 열기, 내보내기, TXT 불러오기, 이미지 업로드 버튼 순서를 실제 작업 순서에 맞춘다.
- disabled 버튼은 왜 비활성인지 사용자가 바로 알 수 있게 한다.
- 저장하지 않은 변경사항 표시와 저장 버튼 강조가 보이되 작업 흐름을 방해하지 않게 한다.
- 내보내기 버튼이 너무 앞에 있어 작업 흐름을 방해하지 않게 한다.
- console issue인 form field id/name 문제를 접근성 관점에서 정리한다.

50개 A등급 평가 항목:
1. 첫 화면에서 사용자가 다음 행동을 바로 아는가
2. TXT를 먼저 불러와야 하는지, 프로젝트를 먼저 저장해야 하는지 헷갈리지 않는가
3. 저장 전/후 이미지 업로드 가능 상태가 명확한가
4. 이미지 업로드가 막혔을 때 이유와 다음 행동이 보이는가
5. 실제 이미지가 연결된 뒤 현재 페이지 상태가 즉시 이해되는가
6. 사용자가 현재 몇 페이지를 작업 중인지 바로 아는가
7. 현재 페이지의 대사 수, 완료 수, 검토 필요 수가 한눈에 들어오는가
8. 첫 viewport 안에 이미지, 페이지 요약, 대사 목록 시작부가 함께 보이는가
9. 이미지가 번역 참고물로 충분히 크게 보이는가
10. 이미지가 너무 커서 대사 목록을 아래로 밀어내지 않는가
11. 1440px 데스크톱에서 이미지와 목록 사이의 균형이 적절한가
12. 1600px 이상에서 이미지가 의미 없이 가로로만 늘어나지 않는가
13. 1920px에서 시선 이동이 과하게 커지지 않는가
14. 이미지 toolbar의 다시 연결, 맞춤, 100% 의미가 명확한가
15. 이미지 로드 실패 상태가 “무엇을 다시 해야 하는지” 알려주는가
16. 이미지 없음 상태가 다음 행동을 정확히 안내하는가
17. 대사 목록에서 원문과 AI 번역을 빠르게 비교할 수 있는가
18. 대사 목록에서 AI 번역과 사용자 수정문을 빠르게 비교할 수 있는가
19. 사용자 수정문이 너무 짧게 잘려 핵심 차이를 못 보게 만들지 않는가
20. row 높이가 너무 커서 한 화면에 보이는 대사 수를 줄이지 않는가
21. row 높이가 너무 작아 원문/AI/수정문 비교가 힘들지 않은가
22. 선택된 row가 현재 편집 대상임을 충분히 강하게 보여주는가
23. 선택 row와 오른쪽 inspector가 같은 대상을 보여준다는 연결감이 있는가
24. 사용자가 “목록에서 수정해야 하나, 오른쪽에서 수정해야 하나” 헷갈리지 않는가
25. 오른쪽 inspector가 보조 상세 편집 패널로 유용한가
26. 오른쪽 inspector가 두 번째 작업장처럼 느껴져 피로를 늘리지 않는가
27. inspector의 원문/AI/사용자 수정문 textarea 배치가 반복 수정에 적합한가
28. 수정 후 다음 라인으로 이동하는 흐름이 끊기지 않는가
29. 키보드로 다음/이전 라인을 이동하기 쉬운가
30. 마우스로 row 선택 후 바로 수정하기 쉬운가
31. 완료/검토필요/AI초안 상태 변경이 빠른가
32. 상태 변경 버튼이 실수하기 쉬운 위치나 형태는 아닌가
33. 검색이 실제로 라인을 찾는 시간을 줄이는가
34. 화자 필터가 번역 작업 맥락에 도움이 되는가
35. 상태 필터가 검토/미번역 작업 속도를 높이는가
36. 문제 라인만 보기 기능이 눈에 띄고 유용한가
37. 진행률/상태 요약이 너무 많은 공간을 차지하지 않는가
38. 왼쪽 패널의 프로젝트 파일 경로가 작업 집중을 방해하지 않는가
39. 왼쪽 상태 문구가 현재 상태와 다음 행동을 정확히 알려주는가
40. 저장, 열기, 내보내기, TXT 불러오기, 이미지 업로드 버튼 순서가 작업 순서와 맞는가
41. disabled 버튼이 왜 비활성인지 알 수 있는가
42. 저장하지 않은 변경사항 표시가 충분히 보이는가
43. 저장 버튼 강조가 자연스러운가
44. 내보내기 버튼이 너무 앞에 있어 작업 흐름을 방해하지 않는가
45. 긴 번역 세션에서 반복적으로 읽어야 하는 불필요한 문구가 많은가
46. 색 대비와 텍스트 크기가 장시간 작업에 부담을 주지 않는가
47. 패널 구분선과 배경색이 정보 구조를 이해하는 데 도움이 되는가
48. 시선이 이미지, 목록, inspector 사이를 너무 자주 오가게 되는가
49. 사용자가 수정해야 할 라인을 찾는 데 오래 걸리는가
50. 이미지 확인 → 대사 선택 → 수정 → 다음 대사 흐름이 하나의 작업 단위처럼 이어지는가

A등급 판정 규칙:
- 50개 항목 중 Fail이 있으면 A등급이라고 말하지 않는다.
- Partial이 있으면 A등급이라고 말하지 않는다. 단, Partial이 의도된 제품 제약이면 근거를 명시하고 사용자 확인을 받아야 한다.
- 실제 이미지가 `.page-image-panel img`에 렌더링되지 않았으면 A등급이라고 말하지 않는다.
- 1440/1600/1920 screenshot, snapshot, console, overflow metrics 없이 A등급이라고 말하지 않는다.
- `npm run typecheck`와 `npm test`가 통과하지 않으면 A등급이라고 말하지 않는다.

변경 후 검증:
1. `npm run typecheck`
2. `npm test`
3. dev server 재실행 또는 상태 확인
4. 실제 이미지 연결 상태에서 1440x900 screenshot/snapshot/metrics
5. 실제 이미지 연결 상태에서 1600x900 screenshot/snapshot/metrics
6. 실제 이미지 연결 상태에서 1920x1080 screenshot/snapshot/metrics
7. console warning/error 확인
8. `.page-image-panel img` natural/client size 기록
9. 모든 필수 selector overflowX 기록
10. 50개 항목 Pass/Partial/Fail 재판정

산출물 저장 위치:
- 계획: `docs/superpowers/plans/YYYY-MM-DD-a-grade-translation-workbench.md`
- 감사/검증 결과: `review-captures-YYYYMMDD-a-workbench/`
- before screenshot: `before-real-image-<viewport>.png`
- after screenshot: `after-real-image-<viewport>.png`
- final screenshot: `final-real-image-<viewport>.png`
- metrics: `<phase>-metrics-<viewport>.json`
- snapshot: `<phase>-snapshot-<viewport>.txt`
- console: `<phase>-console-warning-error.txt`
- ngrok 결과: `ngrok-allowed-hosts-block.txt` 또는 `ngrok-url.txt`

최종 출력 형식:
- User Convenience Score: A-F
- 한 문장 총평
- 발견한 현재 앱 문제점 요약
- A등급까지 끌어올리기 위해 수정한 항목 요약
- 검증 환경
  - localhost URL
  - ngrok URL 또는 실패 이유
  - viewport 목록
  - console warning/error 결과
- 실제 이미지 렌더링 계측
  - naturalWidth/naturalHeight
  - clientWidth/clientHeight at 1440/1600/1920
  - 이미지 패널 overflow 여부
- screenshot/snapshot 근거
- Overflow 계측 결과
- 50개 평가 항목 Pass/Partial/Fail 표
- A등급 도달 여부
- A를 막는 남은 문제, 있으면 명확히 기록
- 수정한 파일 목록
- 실행한 검증 명령
- 남은 리스크

금지:
- 검증 전 성공/완료/A등급 선언 금지
- screenshot, snapshot, console, overflow 계측 없는 판단 금지
- “예쁘게”, “깔끔하게” 같은 추상 표현 금지
- 랜딩페이지/대시보드식 재디자인 금지
- 모바일/태블릿 QA 금지
- 사용자가 만들지 않은 변경을 되돌리는 행위 금지
- 실제 이미지 없이 최종 등급 판정 금지
```
