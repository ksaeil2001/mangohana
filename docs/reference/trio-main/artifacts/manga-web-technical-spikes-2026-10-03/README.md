# 웹 기술 조사용 로컬 프로토콜 실험

이 폴더는 제품 구현과 분리한 일회성 연구용 코드·실행 결과다. [기술 요구·후보 비교](../../docs/superpowers/specs/2026-10-03-manga-web-technical-options.md) 5절이 결과와 한계를 설명한다.

2026-10-03 01:50 KST에 Windows / Node v24.11.1 / SQLite3.50.4에서 실행했다. `node:sqlite`는 해당 Node에서 experimental 경고를 출력한다. 추가 의존성·외부 계정·실제 AI/결제·사용자 자료는 사용하지 않았다. 서버는 loopback만, DB는 새 OS 임시 폴더만, 종료 대상은 직접 생성한 child process만이다. 합성 서명 키는 메모리에만 있고 결과 파일에 넣지 않았다.

실제 실행 명령:

```powershell
node --check artifacts/manga-web-technical-spikes-2026-10-03/protocol-spikes.mjs
node artifacts/manga-web-technical-spikes-2026-10-03/protocol-spikes.mjs
```

두 명령 exit0, P01~P06 여섯 그룹 PASS. 결과는 [results.json](results.json)이며 당시 코드 SHA-256은 `BD3C11C274CE52CCD7AA317CED54282449665861EABFEB7968C3D084A34502DA`다. 결과 기록은 `wx`로 기존 파일 덮어쓰기를 거부하므로 동일 폴더 재실행의 결과 저장은 거부된다. 기록을 재사용하려고 기존 결과/DB를 삭제하지 않는다.

5/10분은 주입 시계의 경계다. SQLite·fake HTTP·합성 현재 접근·byte manifest·서명 primitive의 실행을 Postgres/Temporal/Cloudflare, 실제 browser/account/provider/file 성공으로 확대하지 않는다. 실제 파일 컨테이너·이미지 decode·키 보존/회전·계정 인증과 기존 S01~S31 제품 인수는 NOT RUN이다.

OS 임시 DB 경로는 results.json에 기록했다. 원본 사용자 자료는 없으며 그 DB를 제품 저장소나 복구 산출물로 사용하지 않는다. 로컬 가짜 공급사는 실행을 실제로 처리한 뒤 응답을 끊거나 worker 종료를 기다리고, 조회 가능한 경우 원 수행의 근거를 반환한다. 조회 미지원 경우는 불명으로 유지한다. 이 지원을 실제 공급사에서 확인했다는 뜻은 아니다.
