# 현재 MVP 플랫폼 범위

2026-09-17 제품 결정: **macOS는 TRIO MVP 지원 대상이 아니다.**

현재 MVP의 Production OCR 계약은 Windows x64 CPU다. macOS 패키지, unsigned
acceptance, Developer ID, notarization, Gatekeeper, Apple signing과 macOS 실장비
QA는 현재 MVP Release Gate에서 제외한다. 향후 지원을 재개하려면 별도 제품 결정과
실제 플랫폼 검증이 필요하다.

`package.json`의 `pack:mac:future`, `dist:mac:future`와 mac builder 설정,
Apple signing helper, 아이콘 및 일반 `darwin` 분기는 향후 사용을 위한 코드다.
현재 candidate/promotion CI와 공개 asset allowlist는 macOS 자산을 요구하거나
게시하지 않는다. macOS를 다시 포함하려면 관련 정책과 검증을 함께 변경해야 한다.

Linux의 기존 AppImage 설정, CI와 updater-disabled 정책은 이번 결정으로 변경하지
않는다. 이를 근거로 Linux를 MVP 지원 대상으로 새로 선언하거나 승격하지 않는다.

과거 다중 플랫폼 계획과 QA 문서의 macOS 항목은 **non-MVP / future scope**다.
과거 실행 결과는 역사적 증거이며 현재 후보의 PASS나 blocker 판정을 대신하지 않는다.
Windows Authenticode, 실제 Production OCR, 실제 Translation/Inpainting Golden E2E,
Production Pretendard 검증은 각각 독립적으로 판정한다.
