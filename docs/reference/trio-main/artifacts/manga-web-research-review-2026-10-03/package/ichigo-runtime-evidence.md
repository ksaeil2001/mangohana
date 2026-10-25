# Ichigo — 실제 한 장 실행

관찰일2026-09-27 KST. 이전 도구 오류를 해소해 정상 UI 키보드 선택으로 실행했다. 이전 `미실행` 기록은 역사적 상태이며 현재 결과는 이 파일이 갱신한다.

| ID | Source | Evidence | Meaning | Classification |
|---|---|---|---|---|
| I-300 | https://ichigo.moe/upload | 사용자 허용 소유 합성 PNG900×650 한 장 제출, 남음5→4, 모델 UI GPT-6 Luna, 목표 한국어 | 로그인 없는 할당량으로 실제 한 장 완료 | CONFIRMED—관찰 |
| I-301 | 완료 화면 다운로드 링크 | `/translate/as-reader-format/download?jobId=[OMITTED]` 제공, jpg 정상 다운로드 | 웹 업로드는 job 식별자와 결과 다운로드 단계를 갖는다. polling/SSE/queue 기술은 미관찰 | CONFIRMED—DOM·다운로드 |
| I-302 | [다운로드 결과](ichigo-translated.jpg) | 가로문장 안녕하세요.; 세로문장 오늘은 날씨가 좋네요.; footer 유지, 우하단 ichigo.moe gpt6-luna watermark | 원문 제거+한국어 렌더링 실제 확인. 좁은 세로영역의 단어가 여러 줄로 잘려 가독성 한계 | CONFIRMED—시각 검사 |

[완료 화면](ichigo-runtime-result.png), [입력](japanese-synthetic.png).

한 장 완료는 전체 품질·정확한 서버 모델·context·extension 성공을 증명하지 않는다. 자동 업로드 실행 시 UI 기본 언어가 한국어였고 Torii는 English였다. 동일한 입력으로 업로드→출력 경로를 검증했지만 같은 언어의 번역 품질·속도 비교 실험은 아니다. Ichigo의 upstream OCR·LLM 호출, 세부 timing, 비용 분해는 보지 못했다. jobId 값은 산출물 URL에서 제외했다.
