# NotebookLM 전체 구현 전 준비 학습 근거

조회·직접 읽기일: 2026-10-03. 대상은 [기존 노트북](https://notebook.google.com/notebook/edd4a227-15b0-47e8-8f08-b9481c58a7b2)의 이미 선택된 29개 강의다. 새 자료 추가·원본 프로젝트/이미지/파일 업로드·공유 권한 변경은 하지 않았다.

## 1. 완료 범위와 증거의 종류

- 소스 목록 29개를 관측하고 소스 viewer의 전체 표시 전사문 29개/163,888자를 직접 읽었다. 정석 7개, 로드맵 6개, 구조 10개, 체계 6개다.
- `source-inventory.json`은 관측한 제목 목록이며 `transcript-capture-manifest.json`은 전체 viewer의 캡처 과정·paragraph 수·이전 전사문 대조 기록이다. `transcript-manifest-verified.json`에 전체 파일별 byte/문자 수·SHA-256을 추가해 29개/네 묶음을 검사했다.
- 원본 MP4를 재생하거나 음성·슬라이드·전사 정확성을 대조하지 않았다. 이 기록에서 원문은 **NotebookLM 소스 viewer에 표시된 전사문**을 뜻한다. 전사 오기와 분할 강의의 문장 잘림이 있을 수 있다.
- 생성 답변은 강의 원문과 다르다. 완료 답변 두 개를 따로 보존하고 직접 전사문과 대조했다. 첫 답변의 근거 없는 일반화는 아래 3절에서 구분한다.
- 루트의 초기 `source-*.txt` 중 일부는 마지막 paragraph만 담았다. 기존 읽기에서 놓친 앞/뒤 paragraph를 전체 `transcripts/`와 대조하여 읽었다. 초기 파일은 보존하며 **전체 캡처 증거로는 사용하지 않는다**.
- `answer-01-anchor-miss.txt`는 답변 추출 anchor가 맞지 않아 저장된 1자 진단 산출물이다. 완성 답변으로 세지 않는다. 완성된 첫 답변은 `answer-01-dom.txt`다.

## 2. 전체 소스의 읽기·적용 분류

아래 설명은 직접 읽은 원문의 용도를 요약한 것이다. 제안된 아키텍처/테스트·운영 선택은 사용자 정책 확정을 뜻하지 않는다.

| 묶음/part | 전체 표시 전사문 | 확인한 내용·적용 범위 |
| --- | --- | --- |
| 정석 001 | [전사문](transcripts/design-part001.txt) | 기획 맥락·방향 피드백과 화면/업무/데이터 책임 분리. 사례의 짧은 MVP 시간은 이 프로젝트 일정 보장 아님 |
| 정석 002 | [전사문](transcripts/design-part002.txt) | 계층 책임·테스트 가능성·공통/기능 컴포넌트의 균형. 모든 서비스가 순수 함수라는 보장으로 채택하지 않음 |
| 정석 003 | [전사문](transcripts/design-part003.txt) | 맥락 지침, 설계와 중요한 논의점, 타입/식별과 clock 주입 사례. 모든 작은 결정 질문·계획 무한 확장 금지 |
| 정석 004 | [전사문](transcripts/design-part004.txt) | 라이브러리·계층/검증의 장단점, 세션 종료 시 코드에 없는 의도 기록. 보안 validation 완화나 일괄 코드 문서화로 일반화하지 않음 |
| 정석 005 | [전사문](transcripts/design-part005.txt) | 도입 실험·효과 확인·팀 역할·의도/인계 기록. 기존 스택 학습 캡처와 normalized text 일치 |
| 정석 006 | [전사문](transcripts/design-part006.txt) | 기술 밖 사업 맥락과 PM 역할, 주로 개발자 채용/학습 조언. 책 전부 구매/암기를 구현 전 요구로 만들지 않음 |
| 정석 007 | [전사문](transcripts/design-part007.txt) | 바이브코더에게 개발자 책 목록 전부가 필수는 아니라는 마무리 |
| 로드맵 001 | [전사문](transcripts/roadmap-part001.txt) | 도구/공식 문서와 개념 학습, 도메인 관계·역할 이해. Mac/Zsh·터미널 명령 예시는 수행 지시 아님 |
| 로드맵 002 | [전사문](transcripts/roadmap-part002.txt) | 중요한 기술 미정을 AI 인터뷰로 좁히고 사용자 맥락으로 명세 확정. 사용자에게 전문 문서 직접 작성을 요구하지 않음 |
| 로드맵 003 | [전사문](transcripts/roadmap-part003.txt) | 동기/비동기·transaction/부수 효과·Redis 등 장단점과 과한 계획. 기존 캡처 일치 |
| 로드맵 004 | [전사문](transcripts/roadmap-part004.txt) | 개인 자동화·영상/메신저·SimpleClaw 사례와 학습 조언. 메일/계정/전송 허가를 주는 내용 아님 |
| 로드맵 005 | [전사문](transcripts/roadmap-part005.txt) | 불편함/Domain Story/용어집, 기획 뒤 E2E 목표와 필요한 unit 작성 시점. 통합 검증 불필요·운영비 0·월요금 손실 없음 주장은 채택하지 않음 |
| 로드맵 006 | [전사문](transcripts/roadmap-part006.txt) | 개인 도구 제약·경량화·업무 역할과 Q&A 마무리. 새 제품 스택의 채택 근거로 직접 사용하지 않음 |
| 구조 001 | [전사문](transcripts/structure-part001.txt) | 개인 에이전트·사람 인증 개입·변경 전 E2E/재구조화 순서. 민감 권한 자동 승인/새 웹의 Electron 리팩터링 근거 아님 |
| 구조 002 | [전사문](transcripts/structure-part002.txt) | 사용자 PM/개발 에이전트 역할, 중요한 논의점·기존 동작 보존. 승인 경계 완화로 적용하지 않음 |
| 구조 003 | [전사문](transcripts/structure-part003.txt) | 공식 문서·개념 이해와 테스트 대역 계약 정확성, 개발자 면접 Q&A. PM이 모든 프레임워크를 암기할 요구 아님 |
| 구조 004 | [전사문](transcripts/structure-part004.txt) | 외부 token/한도 영향을 줄이는 fake와 실제 계약 대조. fake 결과를 실제 AI 품질로 사용하지 않음 |
| 구조 005 | [전사문](transcripts/structure-part005.txt) | 리팩터링 전 E2E·의도 파일·역할/복잡도·유지보수. 독립 검토 지침이나 기억 보존 지침을 취소하지 않음 |
| 구조 006 | [전사문](transcripts/structure-part006.txt) | 평가 기준 먼저 작성·우선순위 피드백·세션/문서 조언. 70% 수치는 강사 선호이며 자동 목표 중단 조건 아님 |
| 구조 007 | [전사문](transcripts/structure-part007.txt) | 폴더 책임·인터페이스·이해 가능한 코드 구성. 세부 경로마다 사용자 선택을 요구하지 않음 |
| 구조 008 | [전사문](transcripts/structure-part008.txt) | 이름/역할과 재구조화 개발 조언. 주로 구현 중의 유지보수 내용 |
| 구조 009 | [전사문](transcripts/structure-part009.txt) | 기존 코드 보존·재구조화/재작성·인계·느린 검증 최적화. 기존 Electron을 웹 권위로 전용하지 않음 |
| 구조 010 | [전사문](transcripts/structure-part010.txt) | 마무리·후속 콘텐츠 안내 |
| 체계 001 | [전사문](transcripts/system-part001.txt) | 기본 구조·기술 스택/인프라·TS 선호. 특정 언어/도구를 보편적 강제 조건으로 만들지 않음. 기존 캡처 일치 |
| 체계 002 | [전사문](transcripts/system-part002.txt) | 메인/관리/서버·모노레포·SDK 결합/이전 선호. 책임 분리와 별도 배포를 구분. 기존 캡처 일치 |
| 체계 003 | [전사문](transcripts/system-part003.txt) | 구조·비즈니스 인터뷰·도구 비용/이전 의견. 인증/RLS 등 권한 검사를 제거하는 근거로 사용하지 않음 |
| 체계 004 | [전사문](transcripts/system-part004.txt) | 맥락·세 영역/책임·외부 제공자와 spec/검증 장치. client/server 분리만으로 보안 완료를 보장하지 않음 |
| 체계 005 | [전사문](transcripts/system-part005.txt) | 스펙/검증 장치·브라우저 작업·인증 방식·인프라 지연. cookie와 session을 배타적으로 설명하지 않음 |
| 체계 006 | [전사문](transcripts/system-part006.txt) | API–DB 반복 왕복과 지역, 브라우저 인프라 조사·전문 밖 RPA Q&A. exact latency/지역을 확정하지 않음 |

## 3. 질문·생성 답변과 보정

1. [전체 준비 질문](query-01-readiness.txt) → [완료 답변](answer-01-dom.txt): 서비스 전체 준비 영역을 넓히는 데 사용했다. 13개 분류는 생성된 정리이며 원문이 제정한 필수 절차가 아니다. 이전 스택 단계에서 네 원문을 읽었다는 정보를 전체 이전 학습량으로 읽은 부분과 이미 읽은 파일을 미확인으로 제안한 부분은 최신 29개 캡처로 정정했다.
2. [원문 근거 정정 질문](query-02-source-clarification.txt) → [인용이 붙은 완료 답변](answer-02-source-clarification-dom.txt): 원문/사례/프로젝트 제안, 사용자/에이전트 결정, 명세/실행 증거를 구분하도록 요청했다. 실제 답변의 6가지와 직접 읽은 내용은 겹치지만 일치한 필수 순서/완료 알고리즘을 뜻하지 않는다.

첫 답변의 `MacOS 변경`, `0~53절`로 고정한 오래된 범위, 모든 명령을 순수 함수로 강제하는 표현, SDK/RLS 회피의 강제화, 70% 중단·스파이크/품질 도구 이미 완료로 읽힐 수 있는 문구는 채택하지 않았다. 원가·품질·시간 보장은 강의와 구분한다.

최종 답변도 `Architecture.md/Glossary.md/Agent.md/ADR.md` 등 새 정책 원본 파일들을 제안했다. 이를 그대로 만들지 않고 기존 Domain Story·설계/후보·플랜의 참조를 재사용했다. 외부 API 키/구매/약관·민감 접근의 실제 권한은 사용자/현재 도구 지침을 따르며 강의 사례에서 얻지 않는다. 이 사용자의 결정은 Q1~Q19와 현재 새 선택 상태를 따른다.

정정 답변의 외부 수행 멱등성 헤더/암호화 조사 권고는 자동 멱등성 또는 파일의 creator만 열기 보장을 뜻하지 않는다. 이미 확인한 timer·worker·DB/스토리지 근거와 이번 Google/OIDC/OWASP 공통 조사에 이어 선택한 후보/모델/파일의 실제 지원을 확인해야 한다.

## 4. 프로젝트에 연결한 결과와 한계

주 산출물은 [구현 전 준비 명세](../../docs/superpowers/specs/2026-10-03-manga-web-preimplementation-readiness.md)다. 전체 G01~G08·흐름/책임·공통 보안 사례 SEC01~SEC10·사용자 질문 의존 순서·H01~H06 인계를 정리했다. 기존 플랜 9절을 현재 진행 원본으로 재사용하고, Domain Story 59절에는 실제 질문한 Q23~Q25와 미응답을 기록했다.

공식 Google/OIDC/OWASP 원문은 준비 명세 5절에 직접 연결한다. 기존 researcher가 분리 조사한 근거를 메인에서 주요 원문과 대조했다. 보안/권한/파일/정산/비용 수치/실제 runtime은 원문 확인과 구현 PASS가 다르다.

Q23~Q25는 응답 전, Q20~Q22와 비교 우선순위도 미선택이다. 전체 준비 목표는 **진행 중**이다. 실제 새로운 stack/schema/API 구현·runtime·auth·UI/두 탭·project file·AI/결제/배포 실행, S/APV/SEC 제품 인수 사례는 NOT RUN이다. 이전 P01~P06 연구 프로토콜 검증은 그 범위의 증거로 유지한다.

이번 architect 호출도 `agent thread limit reached`로 거절되어 독립 검토 미완료다. 사용자가 한도 때문에 멈추지 말라고 한 기존 지시에 따라 학습·문서 준비를 수행했다. researcher의 자료 조사·메인의 대조·문서 검사는 architect 독립 검토를 대신하지 않는다.

완료 답변·원문 인용과 표시 source 29개가 보이는 [결과 화면](notebooklm-preimplementation-principles.png), 질문/완료 답변 시작이 보이는 [완료 화면](notebooklm-preimplementation-complete.png)을 보존했다. 화면 캡처와 문서 검사도 제품 실행 증거가 아니다.
