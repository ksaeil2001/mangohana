# Trio P1-01 — Windows 실장비 QA 결과

> **대상:** `trio-windows-x64-17` CI artifact  
> **기록 상태:** 진행 중. 결과는 `PASS | FAIL | BLOCKED | NOT RUN` 중 하나만
> 사용한다. 고객 프로젝트·개인정보·비밀값을 사용하지 않은 synthetic 검증만
> 기록하며, CI smoke는 실장비 PASS가 아니다.

| 시나리오 | 결과 | 관찰 | 후속 상태 |
| --- | --- | --- | --- |
| QA-P101 기준 실행·세션 생성 | **NOT RUN** | 설치본이 JavaScript main-process import 오류 없이 열림 | synthetic 프로젝트 저장 검증 대기 |
| QA-P102 최소화 후 두 번째 실행 | **PASS (기존 부분 증거만)** | 기존 최소화 창이 복원되고 foreground focus됨. 새 독립 창은 생성되지 않음. Gate 3 전체 승격 금지. | P1-01 single-instance의 실제 Windows 증거 확보 |
| QA-P103 반복 실행 | **NOT RUN** |  | 빠른 연속 실행 실증 대기 |
| QA-P104 정상 종료·재실행 | **NOT RUN** |  | synthetic 프로젝트 재열기·세션 정리 실증 대기 |
| QA-P105 실패 후 복구 | **NOT RUN** |  | P1-03 저장·복구 QA와 함께 수행 |

테스트 중 표시된 “업데이트 확인 실패”는 P1-01 창·세션 판단과 별개로 [업데이트 실패 진단](update-check-failure-diagnosis.md)에서 관리한다.

현재 실제 Windows 설치본·관리자 권한·DPI·저장/복구·queue·uninstall 증거가
없으므로 P1-01 전체 판정은 **BLOCKED**이다. 기존 QA-P102의 창 복원 관찰은
부분 증거로만 남기며 나머지 시나리오의 `NOT RUN`을 자동으로 PASS로 바꾸지 않는다.
