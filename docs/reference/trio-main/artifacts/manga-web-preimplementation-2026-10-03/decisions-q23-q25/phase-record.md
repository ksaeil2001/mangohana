# Q20~Q57 선택 반영과 선정 기반 상세 준비 단계

일자: 2026-10-03. 최신범위: 직접38답+위임20선정·schema/SQL/현재권한·측정gate/새웹인계의문서준비작성완료. 최종문서검사1605개PASS이며product/PG/auth/file/browser/provider/host는NOT RUN·새범위독립검토미완료다. 아래중간기록은당시상태다.

| 질문 | 명시적 응답 | 확정 내용 |
| --- | --- | --- |
| Q20 | A | Postgres 권위 저장+별도 TypeScript 실행서버 |
| Q21 | A | 서비스 전자서명+만든 계정의 현재 접근 확인 |
| Q22 | A | 유효 접근·지원 형식 동안 최소 발행/검증 근거 유지 |
| Q23 | A | 지정된 내 내부 테스트 계정의 전체 흐름, 실제 판매/일반 이용자는 후속 |
| Q24 | B | Google+이메일 자체 가입·로그인 |
| Q25 | A | PC·태블릿 마우스/터치 편집, 스마트폰 전체 편집은 후속 |
| Q26 | A | 이메일 일회용 코드 |
| Q27 | A | 접근 검증 후 명시적 새 로그인 수단 추가, 안정된 내부 계정 유지 |
| Q28 | A | 일반 만화 페이지 묶음, 긴 세로 웹툰은 후속 |
| Q29 | B | 일본어·중국어·영어 원문→한국어·영어·일본어의 지원/평가 준비 |
| Q30 | B | Windows Chrome/Edge·Android 태블릿 Chrome·iPad Safari |
| Q31 | B | 파일별 유효 이미지 반영·실패 목록·실패분 새 업로드 |
| Q32 | A | 재번역 영향 이력 무효화·비겹침 이력 의존성 확인 |
| Q33 | A | 현재 확정 결과/순서의 시점 ZIP·후속 변경은 다시 생성 |
| Q34 | A | 페이지별 실제 자동 보관 성공부터 각각 30일 |
| Q35 | A | 현재 페이지별 수동 이력·같은 맥락의 명시적 인계 뒤 유지 |
| Q36 | A | 필수 렌더 실패는 전체 ZIP 실패·같은 캡처 재시도 |
| Q37 | A | 저장 공정만 제한 자동 재시도·계속 실패 안내 |
| Q38 | A | Auth0+서비스 명시적 연결 기록의 우선 상세 설계/적합성 검증 |
| Q39 | A | 명시적 fresh 인증부터 앱 로그인 최대7일 |
| Q40 | A | 파일명 숫자 정렬/미리보기·실패분 새 묶음 맨뒤 |
| Q41 | A | bytes 중복분의 별도 페이지 추가 항목 확인 |
| Q42 | A | 페이지 반영 후보 수용 초과는 이번 후보 전체 미반영 |
| Q43 | A | 간체 중국어 원문부터·번체 후속 |
| Q44 | A | 같은 언어 자동 AI 처리 제외·수동 편집/출력 유지 |
| Q45 | A | 정지 PNG/JPEG 첫 업로드·원본 bytes 보존 |
| Q46 | A | 모든 ZIP 이미지 PNG 출력부터 |
| Q47 | A | 모든 수단/앱 로그인 상실은 원 provider 계정 복구 |
| Q48 | A | 남길 수단 재인증 후 제거·마지막 수단 보호·대상 앱 세션 철회 |
| Q49 | A | 활성 요청 종결 확인 뒤 새 업로드 |
| Q50 | B | 미래 요청 설정 변경 허용·기존 접수 설정 유지 |
| Q51 | A | 활성 요청 종결 확인까지 제외·스킵·순서 잠금 |
| Q52 | B | 현재/모든 앱 session logout 별도 명시 동작 |
| Q53 | A | 계정 전체 한 live 편집 맥락·기존 작업 자동 폐기 없음 |
| Q54 | A | React/Vite/TypeScript 화면+Node API 첫 상세 설계 기준 |
| Q55 | A | 정상 저장/최신 file 보관 확인 뒤 current logout |
| Q56 | B | 연결 수단 새 접근 proof/손실 명시 확인 뒤 전체 app logout·현재 맥락 종료 |
| Q57 | A | API/worker 운영 플랫폼 우선 상세 비교 |

업무 원본은 `docs/manga-translation-domain-story.md` 3/16/22/24/25·59절이다. 구현 전 준비·기술 후보·기존 플랜·Torii/Ichigo 적용 보고서·주 설계/워크스페이스 계약의 현재 상태를 관련 범위로 갱신했다. 초기 미선택/검토 당시 상태는 시점을 표시해 보존한다. 선정한 Postgres·TypeScript 요청 수명 초안을 별도 설계 문서로 연결했다.

기초 스냅샷은 `baseline.json`의 9개 파일이고 변경 전 hash와 OS 임시 폴더의 원본을 보존한다. 제품 코드와 사용자 자료를 수정하지 않았다. AGENTS·package.json은 바이트 비교로 보존했다. 기존 워크스페이스 계약은 현재 DB 미선정 문구 두 곳만 현행화하고 R/C/E/K/U/S 식별자와 행동은 보존했다. 선언한 수정은 `declared-edits.json`, 단계별 hash는 `after-hashes.json`, 새 PG 초안의 초기 내용은 `created-documents.json`에 기록한다.

공식 인증 기초 근거는 [official-auth-evidence.md](official-auth-evidence.md), 후속 후보의 researcher 조사/메인 대조는 [auth-candidate-comparison.md](auth-candidate-comparison.md), 선정 DB 근거는 [official-postgres-evidence.md](official-postgres-evidence.md)에 둔다. 질문 검토는 [architect-question-reviews.md](architect-question-reviews.md), 열두 선택+PG 요청 수명 초안의 독립 검토/지적 반영 확인은 [architect-final-review.md](architect-final-review.md)을 따른다. 전체 준비 완료로 확대하지 않는다.

Q20~Q57 서른여덟 질문은 실제 응답 또는 추천안의 명시 수락으로 선택 완료다. 최종 인증 제품 채택/계정 생성 승인은 아니다. 선택지를 추천값으로 확정하지 않는다. 선택의 단일 원본은 Domain Story 59절로 연결한다.

Q32~Q34 추가 반영과 다음 질문의 architect 재호출은 `agent thread limit reached`로 불가했다. 이전 사용자 지시대로 진행했고 메인이 원본/현재 상태·CF/OB/FX를 대조했다. 그 당시 추가 반영·후속 인증 후보 비교의 독립 검토는 미완료였으며 기존 열두 선택+PG 초안의 완료 범위와 구분한다.

문서 검사는 `audit-documents.py`로 선언 수정의 baseline 재현/현재 hash·기존 지침/제품 설정 보존·실제 선택과 미응답·C/K 등 식별자·PGV 사례·새 로컬 링크/anchor·표/fence·diff check를 확인한다. 최종 결과·정확한 검사 수는 [document-checks.json](document-checks.json)을 따른다. 검사 통과는 문서 범위이며 제품 동작/전체 구현 준비 완료가 아니다. 전체 문서 변경의 diff도 `diffs/`에 보존한다.

제품 코드·의존성 설치·계정 생성·메일/OAuth·선택 DB/실행기·서명 파일·브라우저·AI/결제·배포 실행은 하지 않았다. S/APV/SEC/FX/AUTHV/FILEV/PGV는 모두 NOT RUN이다. 전체 구현 전 준비·상세 인계는 계속 진행 중이다.

새 architect `/root/preimplementation_q35_q37_review`의 상세 초안 계획/후속 질문 검토는 정상 수행했다. Q38·Q39를 보완해 실제 발송했고 만료 직전 전송 질문은 실제30일 삭제와의 양립 근거 확인 전까지 보류했다. 변경 후 전체 원문/추가 초안의 최종 독립 대조는 아직 미완료다. 계획 검토 근거는 [architect-q35-q37-plan-review.md](architect-q35-q37-plan-review.md)다.

Q38-A/Q39-A를 실제 응답으로 반영하고 추가 편집/출력/파일 상세 초안을 생성·연결했다. 최초 내용은 created-documents.json에 추가했고 EOV01~EOV15도 모두 NOT RUN이다. 최종 새 원문 독립 검토와 문서 검사는 별도다.

변경 후 architect 읽기 전용 검토의 필수 보완3건을 반영했다. 현재 페이지의 정상 종료 마무리/단절 차단 구분, 비현행/고아 보관 객체의 원 기한/삭제 추적, 다단계 Undo/Redo cursor 순서와 EOV16을 추가했다. 지적 반영의 후속 확인은 별도다. 다음 Q40·Q41·Q42를 실제 발송했고 응답 대기다.

architect의 지적 반영 후 원문 확인은 추가 필수 보완 없음으로 종결했다. 이번 제한된 최신 문서/초안 검토와 이전 호출 실패/검토 범위를 구분한다. 실제 제품 실행/전체 준비 완료가 아니다. 그 검토 시점 다음 Q40·Q41·Q42는 응답 대기였으며 이후 모두 A로 선택됐다.

Q40-A/Q41-A/Q42-A 실제 답변을3.1절/CF01/OB02/FX·상세초안10절/EOV17~19에 반영했다. 현재 미응답 질문은 없고 다음 준비를 계속한다. 이전20선택/추가 상세의 독립 검토 완료와 이번 업로드 추가 반영/상세의 검토를 구분한다. 실제 제품 실행은 NOT RUN이다.

Q40~Q42 추가 반영/업로드 상세·다음 질문의 architect 재호출은 agent thread limit reached로 불가했다. 이번 추가 범위 독립 검토는 미완료이며 이전20선택/상세 검토 종결과 구분한다. Q43·Q44·Q45는 실제 발송·응답 대기로 기록했다.

Q43~Q48 실제 선택은 모두 A로 반영했다. 이전 Q43~Q45 응답 대기 기록은 당시 상태이며 Q43~Q48 반영 시점 미응답은 없었다. 인증·세션 초안 최초 내용/hash를 created-documents.json에 추가하고 공식 auth 근거·ASV01~10·지원7방향·PNG/JPEG/EOV20~21을 연결했다. 최신 추가 범위 독립 검토는 미완료이며 이전 범위 종결/한도 기록과 구분한다. 실제 실행 NOT RUN·전체 준비 IN PROGRESS다.

현재 Q20~Q48 선택29개를 반영했고 실제 후속 Q49/Q50/Q51을 발송·응답 대기로 기록했다. 처리 중 UI 잠금/명령 허용·현재 revision/캡처/충돌 사례는 선택 뒤 연결한다.

Q49-A/Q50-B/Q51-A를 원본/CF/상세11절·EOV22~24·PG8.3에 반영했다. 현재 명시 선택32개·미응답 없음, 실제 실행 NOT RUN·신규 독립 검토 미완료·전체 준비 진행 중이다.

새 architect의 Q40~Q51/신규 인증·업로드·처리 중 설계 검토와 두 상태 지적 재확인이 종결됐다. 이전 thread limit/미완료는 당시 상태로 보존한다. 실제 제품/전체 준비와 구분하며 현재32선택·실제 Q52/Q53/Q54 응답 대기다.

Q52-B/Q53-A/Q54-A 실제 선택을 반영해 현재35선택/미응답 없음이다. 이전32문서 범위 종결과 새 범위 독립 확인 대기를 구분한다. logout 파일/종료/proof·선정 기반 host/버전/HTTP/코드·공정/품질/운영/전체 인계는 후속이고 제품 실행은 NOT RUN이다.

사용자 지시(2026-10-03): 결정/근거/질문/응답/진행·미검증은 기존 프로젝트 문서로 기록하며 별도 메모리 저장 없음. PLAN9.9·PRE11.20에 연결했다. Q52~Q54의 기존/새 architect 호출은 모두 agent thread limit reached로 실패했고 새 범위 독립 검토는 미완료다. 기존 Q40~Q51 종결은 보존한다. 메인의 자체 대조/문서 검사와 공식 hosting 근거/HOV01~04는 별도 경계이며 실제 질문 발송 전 정책/host 미선택·실행 NOT RUN을 유지한다.

Q55-A/Q56-B/Q57-A는 실제 질문의 추천 표기를 사용자 응답으로 수락했다. 현재38선택/실제 미응답 없음. 질문 전문/원답은 questions-q55-q57.json, 이후 추천 설계 위임은 Domain Story59.21/PLAN9.10에 기록했다. 직접 답과 위임 선정/실제 지출·제품 실행을 구분하고 모든 선택 근거·영향/미검증은 프로젝트 문서에 남긴다.

이후위임선정D01~D15와추천선정/구현인계상세를작성했다. 직접38질문답과후속15선정은구분하며공식근거/고른답·영향/미검증·RSG와예정경로/scripts/환경을문서로보존했다. 전체schema/DDL·실compatibility/품질/원가/host·최종독립검토는남음/전체G01~G08진행중·제품NOT RUN·메모리저장없음.

D16~D20/최종schema·SQL 인계를작성해G01~G08문서준비기준을마쳤다. 실제명령22종/3schema·47DB기록과25합성입력/모든정의·FK/finite금액의573오프라인검사가PASS다. 직접답38개와위임20개는분리하며runtime/실제PG grammar/파서·auth/기기/provider/host·품질/수치/가격/지출·신규독립검토는후속gate/NOT RUN/미완료다. 실제product/memory쓰기없음. 최종docaudit후메타데이터를확정한다.

최종문서감사1605개PASS(12변경문서:기존7+신규5,baseline2보존·38답/20위임·92local링크/189표·460선언수정). 별도계약573정적검사/25합성입력PASS,실제PG/auth/file/browser/provider/host와신규독립검토는앞서명시한NOT RUN/미완료다. 메인최종diff/내용/기존dirty보존범위를확인했다.
