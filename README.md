# Mangohana

Trio 만화 번역 웹서비스의 현재 소스와 연결된 설계·조사 기록을 보존하는 저장소입니다. 업로드한 만화를 OCR → 문맥 번역 → 원문 제거 → 자동 식자로 처리하고, 검수·취소·복구·저장·다운로드로 연결하는 것을 목표로 합니다.

2026-10-25 게시본은 기존 `trio-manga-web` 작업 폴더의 코드·테스트·설정·검증 기록을 복사한 소스 스냅샷입니다. 원본 Electron 저장소의 다른 미커밋 변경과 Git 이력은 가져오지 않았습니다. 제품 코드와 기존 기록의 바이트를 보존했으며 이 README만 게시 안내로 추가했습니다.

실제 모델로 만든 한 페이지 결과와 웹서비스 전체 품질은 아직 합격 판정을 받지 않았습니다. 이 게시 작업에서 테스트·빌드·앱·모델·native 작업을 실행하거나 외부 추론 API를 호출하지 않았으며, GitHub 게시가 운영 활성화나 배포를 뜻하지 않습니다.

| 경로 | 내용 |
|---|---|
| `apps/api`, `apps/worker`, `apps/web` | API·worker·React 웹 UI |
| `packages` | 계약·도메인·저장·제공자·미디어·native 경계 |
| `db/migrations` | 기존 데이터베이스 migration |
| `scripts`, `tests` | 기존 개발·격리 검증 도구와 테스트 |
| `docs/validation` | 과거 선택 검증과 조사 근거 |
| `assets/fonts` | 고정된 Noto CJK 폰트·catalog·OFL 고지 |

설계와 진행 상태는 다음 문서 사본에서 확인할 수 있습니다.

- [Domain Story](docs/reference/trio-main/docs/manga-translation-domain-story.md)
- [Canonical 계획·검증 기록 — 최신 10.196](docs/reference/trio-main/docs/superpowers/plans/2026-10-02-manga-web-workspace-contracts-and-validation-plan.md)
- [웹서비스 계약 참조](docs/reference/trio-main/docs/superpowers/specs/2026-10-03-manga-web-contract-reference.md)
- [로컬 작업 폴더의 원래 연결 정의](docs/source-reference.json)
- [기존 검증 하네스](docs/agent-harness.md)

`docs/reference/trio-main`에는 핵심 설계·지침·용어집과 연결된 조사·검토 Markdown 65개를 원래 상대경로 구조로 보존했습니다. 개발 환경의 `docs/source-reference.json`과 AGENTS.md는 원문을 유지하므로 Windows 절대경로가 남아 있습니다. GitHub에서는 위 사본 링크를 사용하면 됩니다. 과거 임시 경로, Electron 소스, 모든 JSON·SQL·이미지 증거까지 복사한 것은 아니므로 모든 내부 링크가 완결됐다는 의미는 아닙니다. 이 사본은 게시 시점 기록이며 별도의 새 canonical 원장을 만들지 않습니다.

최근 결정은 당근망가 설치판으로 `08_08.webp` 한 장의 실제 무보정 PNG를 먼저 평가하는 방향입니다. 10.195·10.196에는 고정 소스 조사, PC·자산 확인, 라이선스의 미확정 범위, 설정·중단·종료 조건과 다음 승인 범위가 있습니다. 모델·런타임의 다운로드·설치·실행은 이 저장소 게시로 승인되지 않습니다.

L2 작업의 [보존 보고서](docs/reference/l2-preservation/report.md)와 [최종 감사 기록](docs/reference/l2-preservation/final-audit.json)을 함께 보존했습니다. 소스·TS 합성 포트 범위의 기존 수락과 전체 L2 수락을 구분합니다. 기록상 `wholeL2Accepted=false`이며 C++ 13개 그룹은 `NOT RUN`입니다. 이번 게시에서 그 검사를 재실행하거나 실제 native·모델 검증으로 확대하지 않았습니다.

개발 환경과 명령은 [package.json](package.json)을 기준으로 합니다. Node 범위는 `>=24.11.1 <25`이고, 데이터베이스 검증 기록은 PostgreSQL 18 계열의 격리 환경을 사용합니다. 제공자·비용·native 실행 조건은 별도 설정·승인과 근거가 필요합니다. [.env.example](.env.example)의 실제 제공자·유료 실행·구매 플래그는 비활성 예시입니다.

게시본에는 의존성 폴더, 빌드 산출물, 모델 가중치·설치 런타임, 사용자 원본 이미지, 실제 환경 비밀 파일과 외부 도구 바이너리를 포함하지 않았습니다. TLS 테스트의 PEM은 [fixture 설명](tests/fixtures/native-controller-tls-certs/README.md)에 명시된 합성 고정 재료입니다. 운영 자격 증명으로 사용하지 않습니다.

폰트는 [catalog](assets/fonts/catalog.json)의 세 OTF와 [SIL OFL 1.1 고지](assets/fonts/OFL.txt)를 함께 보존했습니다. 이 고지를 저장소 전체 코드나 조사 대상 모델의 라이선스로 확대하지 않습니다.
