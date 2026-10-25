# L2 소스와 TS 가짜 포트 구현 결과

현재 단계는 승인 제품6·검사3의 소스 구현·TS 가짜 포트 검증이다. C++ 실행 검증은 승인 밖이며 아직 하지 않았다. 최종 독립 검토는 C0/I0/M0으로 SOURCE_AND_TS_FAKE 범위를 수락했다. 전체 L2 실행·실서비스 품질 수락은 아니다.

## 구현 내용

- L1 read/write의 hold 두 곳을 n에서2n으로 바꿔 JS backing과 native scratch를 복사·호출 전에 같이 예약한다. cap은 유지했다. 기존 client60개 시나리오 중 예산 기대값9행만 수정했고 신규7개를 추가했다.
- 새 loader는 Node24.11.1/NAPI8·x64PE·export/import·원 파일 지문·승인 lease와 exact createBinding/open/channel을 대조한다. 같은 addon에서도 context를 새로 만들고 함수와 원 Promise를 고정한다. 실제 loader 공급자는 없다.
- 새 build script는 닫힌 입력·순수 명령계획·fake/real 분리·신뢰 executor의 입력 보호·원 실행/로그/소유/종료 manifest를 조립한다. 기본 CLI는 보호된 파일 권위가 없으면 읽기 전 차단한다. 실제 compiler를 호출하는 executor는 없다.
- core/Win32 bridge와 가짜 C++13그룹을 작성했다. 실제 N-API 참조 정리를 확인한 뒤에만 I/O·open 거절·closed를 완료하고, 미완 deferred가 있는 슬롯은 재사용하지 않도록 소스 순서를 보완했다. 컴파일/실행/실제 SDK·N-API 검증은 NOT RUN이다.

## 검증과 보존

실제 TS 선택 명령은 Windows 고정 Node24.11.1로 vitest binding/client/broker 3파일을 native config loader·threads·cache=false로 실행했다. l2-joint-green-06은 binding84/client67/broker79=230PASS, exit0이다. 제품 child·네트워크·addon load 차단 guard를 통과했다. 전체tsc07 및 변경 TS5 lint06 exit0이다. 그 뒤 C++3파일만 변경했고 TS5는 동일하여 해당 검증은 유효하다. C++ 검사를 이 숫자에 더하지 않는다.

직접 TS 실패 재현은 원2n 예산3건, factory 부재 assertion2건과 파생 오류1건의 구분, 상한2건, PE6건, 입력 보호/기록/CLI10건, 후속 해제 실패/이름 없는 export4건을 각각 원 로그/사본으로 보존했다. 최초 예산RED의 stdout 원문은 도구 chunk d591e9이며 root의 요약과 원 도구 출력을 혼동하지 않는다. tsc03/04/06의 검사 타입 오류·준비 스크립트 오류는 기능RED와 구분하고 보존했다.

원 source321중 허용2파일만 변경, 다른319는 SHA동일이다. 신규7파일을 더한 기록은328이다. SQL·Python·broker·설정·AGENTS·의존성은 변경하지 않았다. 새 소스 UTF8/CJK0/trailing0, client 제품의 정확 hold2곳과 기존 검사 예산9행을 대조했다. 원 L1 증거280도 해시가 그대로이며 과거 검증을 새로 실행하거나230개에 합산하지 않았다. 기존 canonical은 append만 했으며 원 prefix를 보존했다.

## 최종 독립 검토

TS 검토 Banach와 통합 검토 Plato의 최종 판정은 각각 C0/I0/M0이다. 통합 검토가 발견한 참조 정리 선행·동기 거절·미완 deferred 슬롯 재사용과 검사 타입 누락을 허용 파일 안에서 보완한 최종 source9를 수락했다. C++13그룹은 계속 NOT RUN이다. whole-architect-initial/followups/final.md와 ts-architect-final.md에 원 판정을 구분 보존했다.

## 입력과 실행 경계

현재9 source와 대표 tool30·설치 고지4의 파일/SHA를 수집했다. 입력 완성은 BLOCKED_INPUT이다. 빠진 조건은 Node 전체 LICENSE/제3자 고지·전체 실제 사용 header/library/tool closure·도구 사용권 근거·강제 한도/원 tree 회수의 실제 executor·보호된 파일 공급자·정확 실행 패키지 승인이다. 원 파일 목록을 갖췄다는 이유로 이 조건이 충족됐다고 하지 않는다.

이번에 compiler/linker/C++ fake executable/real build/addon load/제품 pipe·Win32/native child/외부 API·모델/PG·운영/배포/다운로드·설치/commit은 수행하지 않았다. Node/PowerShell/TS 검사 도구 자체의 내부 OS 동작까지 Win32 호출0이라는 뜻은 아니다.

다음 작업은 이 실행 환경의 공급자와 입력 보호·정확 사용 파일·라이선스 근거를 설계/확정하는 것이다. 실제 도구·fake executable 실행은 해당 환경과 정확 입력 패키지를 승인한 뒤에만 연다. 실제 한 페이지·새 만화의 자동 품질은 미검증이다.

## 변경 파일과 고정 근거

| 파일 | bytes | SHA256 |
| --- | ---: | --- |
| [packages/native/src/windows-pipe-client.ts](C:/Users/ksaei/Documents/Codex/trio-manga-web/packages/native/src/windows-pipe-client.ts) | 27625 | b635a4fbd62239e29bf4f8e3c8b95e2eca9f0185ffb0c16f424fa5b28845fac6 |
| [packages/native/src/windows-pipe-client-binding.ts](C:/Users/ksaei/Documents/Codex/trio-manga-web/packages/native/src/windows-pipe-client-binding.ts) | 13063 | c86611b1c16d6894215010401dfeace0c2d540289bad4fb38bc9aca8ff5caa0a |
| [packages/native/windows-pipe-client/client-core.h](C:/Users/ksaei/Documents/Codex/trio-manga-web/packages/native/windows-pipe-client/client-core.h) | 7990 | 2d631b635c4695ca92573cc43cba6641833b702539175dc61bed527512d20419 |
| [packages/native/windows-pipe-client/client-core.cc](C:/Users/ksaei/Documents/Codex/trio-manga-web/packages/native/windows-pipe-client/client-core.cc) | 16329 | db1d9356a24052601fa6999759e3b57838929ffa0a66651d9c2b1136d88972fd |
| [packages/native/windows-pipe-client/client-win32.cc](C:/Users/ksaei/Documents/Codex/trio-manga-web/packages/native/windows-pipe-client/client-win32.cc) | 47513 | a21ace5b29b6c097a41e755283766d67a35d0738d42680ccde3eef07b0f8ab2c |
| [scripts/build-windows-pipe-client.ts](C:/Users/ksaei/Documents/Codex/trio-manga-web/scripts/build-windows-pipe-client.ts) | 26048 | 75052d8430a6bbc18fd24cc382f7e825759682c0b5954e2f71adb3d35e592a11 |
| [tests/domain/windows-pipe-client.test.ts](C:/Users/ksaei/Documents/Codex/trio-manga-web/tests/domain/windows-pipe-client.test.ts) | 35261 | a27b6594a209619c387dc15c6807445694b5ccf9f32dbd259894dc83b0835068 |
| [tests/domain/windows-pipe-client-binding.test.ts](C:/Users/ksaei/Documents/Codex/trio-manga-web/tests/domain/windows-pipe-client-binding.test.ts) | 39194 | f6cd8e2f2e3e81ddb6d68f7f0dea07da77c96147eedf7a8574f048b8c493f62e |
| [tests/native/windows_pipe_client_test.cc](C:/Users/ksaei/Documents/Codex/trio-manga-web/tests/native/windows_pipe_client_test.cc) | 26820 | c0d61bcd4a477d52b195a89472c4582300d7aef326b890dae5394a28c9d2f981 |

최종 감사는 final-audit.json, 원 검증은 l2-joint-green-06.log/l2-types-07.log/l2-lint-06.log, 입력 미완료는 input-package-inventory-final-02.json, 원 산출물 지문은 evidence-manifest.json이다. 원 예산 RED stdout은 root에 재구성한 로그가 아닌 도구 chunk의 기록이며 l2-budget-red-01-observed.json과 구분한다.
