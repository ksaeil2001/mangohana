# 확정 행동의 구현 계약 보완

출처 wire22종은 배포 전 설계였다. Domain Story11/18 및 workspace C03/C04의 확정된 칠하기·번역 취소·계속 작업을 표현하도록 REQUEST_STOP/CANCEL_EXIT/CAPTURE_PAINT_SELECTION과 PAINTED scope를 추가했다. Domain Story59.24의 실제 사용자 WAIT 선택은 CONTINUE_BATCH의 batch revision/실패 request 대조와 원 설정 RETRY_REQUEST로 표현한다. ANY_OVERLAP과 수동 ALLOW는 서버 정책이며 클라이언트가 바꾸지 않는다. pageView.history는 Undo/Redo의 권위 revision/cursor/가능 이유다. RenderSpecification은 결과별 font catalog/minimum/AUTO_FIT 또는 EXACT를 파일과 화면에 보존한다. 블록별 rendererVersion 누락은 pango-canonical-v1의 기존 재현을 뜻한다. 새 사용자 변경·번역 블록은 pango-overflow-v2를 캡처하여 전체 glyph와 실제 배치 QA를 유지하고 미선택/동결된 과거 bytes를 바꾸지 않는다. MANUAL_EDIT.patch.orientation은 기존 geometry.orientation의 가로/세로 값을 명시적으로 수정하며 원문·번역 상태·polygon·기존 cleanup을 유지한다. RenderSpecification.blocks.typesetBox는 원문 geometry와 분리된 사용자 식자 사각형이며 페이지 내부의 유한 좌표와 양수 크기를 사용하고 pango-overflow-v2와 함께 저장한다. MANUAL_EDIT.patch.typesetBox의 명시적 null은 사각형을 삭제하여 원문 영역 배치로 돌아간다. 자기 glyph 넘침은 유효 식자 영역을 기준으로, 다른 region 침범은 원문 polygon과 식자 영역의 합집합을 기준으로 픽셀당 한 번 계산한다. RenderSpecification.blocks.targetOrientation은 원문 geometry.orientation과 분리된 사용자 번역문 쓰기 방향이며 HORIZONTAL 또는 VERTICAL을 pango-overflow-v2와 함께 저장한다. 누락은 기존 원문 방향을 사용하고, MANUAL_EDIT.patch.targetOrientation의 명시적 null은 override를 삭제한다. 원문과 같은 방향을 직접 설정해도 명시적 override로 보존한다. 기존 patch.orientation은 원문 geometry를 수정하는 의미를 유지하며 두 값이 함께 있으면 번역문은 targetOrientation을 우선한다. AI proposal은 기존 사용자 사각형과 쓰기 방향을 덮거나 새 사용자 override를 주입하지 못한다. 명시적으로 설정하지 않은 새 프로젝트의 settings는 null이다. 이미 배포한 v1 독자와의 호환을 주장하지 않는다. 원 설계/해시는 원 프로젝트 artifact와 docs/validation/source-hashes.json에 보존한다.


## 자동 말풍선 배치 정책

기존 rendererVersion의 허용 값에 pango-balloon-v3를 추가한다. 새 DB 열·migration·native private flag·자동 사용자 typesetBox는 추가하지 않는다. 캡처된 v3 정책은 수정·undo/redo·복구·raster·다운로드에서 보존한다. 현재 신규 OCR은 기존 v2를 생성하며, 미검증 v3 기본 활성화와 기존 v1/v2의 임의 승격은 허용하지 않는다. 실제 PNG 비교 후 기본 활성화 여부를 별도로 판단한다.

v3는 사용자 typesetBox가 없는 가로쓰기 한국어 AUTO_FIT에서 기존 cleanup의 닫힌 밝은 공간 추정을 재사용한다. 후보 영역은 텍스트 적합 여부와 독립적으로 예약하고 원문 정수 box의 중심과 전체 범위를 유지한다. 실제 선택 글자 크기가 기준보다 작거나 최소 크기 fallback·잘림·다른 영역 침범이 있으면 기존 배치를 보존한다. 사용자 영역과 EXACT 크기를 우선하며 자동 후보 채택은 REVIEW_REQUIRED다. 원문 geometry·원본·cleanup 픽셀·사용자 원문과 번역·정확한 수동 크기를 바꾸지 않는다.

명시적 MANUAL_EDIT.patch.typesetBox:null은 v3를 pango-overflow-v2로 바꾸어 원문 영역 기준으로 복귀한다. 구형 no-box의 null 무변경 의미는 유지한다. 화면에 보이는 숫자와 점선은 원문 기준이며 실제 추정 영역인 것처럼 표시하지 않는다. 실제 PNG 가독성·그림 보존과 웹 업로드부터 다운로드까지의 검증은 별개다.
