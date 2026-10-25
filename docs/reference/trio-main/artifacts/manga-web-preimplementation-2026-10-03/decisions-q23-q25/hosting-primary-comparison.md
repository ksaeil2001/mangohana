# 첫 내부 웹 테스트의 호스팅 후보와 운영 책임

조회일: 2026-10-03. 상태: **공식 문서 조사와 적용 추론 / Q57-A 우선 검토 방향 선택 완료 / 상세 기준D02·최종실사양/예산·계정/지출미승인**. Q54-A의 React/Vite 화면·Node API, Q20-A의 Postgres 권위 저장·별도 TypeScript worker를 같은 전제로 비교한다. 조사 담당은 `/root/hosting_primary_options`이며 메인이 주요 가격·운영 책임·객체 삭제 설명을 대조했다. 계정 생성·로그인·설정·설치·배포·AI/메일 호출·청구·벤치마크는 하지 않았다.

## 1. 공식 원출처와 적용 조건

| ID · 공식 원출처 | 확인한 설명 | 우리 설계에 적용할 때의 조건 |
| --- | --- | --- |
| H01 · [Render Pricing](https://render.com/pricing) | Hobby workspace $0+compute. 작은 유료 API와 worker의 0.5c-512mb 사양은 각각 $7/월, PG 0.1c-256mb는 $6/월이며 관리형 PG로 안내한다. 정적 사이트 배포는 무료다. | 이 세 compute의 명목 합계는 $20/월이다. 객체 저장·트래픽/build 초과·더 큰 사양·인증/메일/AI·세금 등은 별도다. 512MB worker/256MB PG가 이미지·ZIP 작업에 충분한지는 미측정이다. 가격표 기준점이지 우리 전체 운영 견적이 아니다. |
| H02 · [Render 무료 배포](https://render.com/docs/free) | 무료 API는 inbound traffic 15분 비활성 뒤 휴면할 수 있고 재가동 지연이 있다. 재시작·재배포·휴면 때 로컬 변경이 사라진다. 무료 worker는 없다. 무료 PG는 생성 30일 뒤 만료되며 유료 전환 유예 후 삭제되고 backup이 없다. | 무료 PG의 생성 기한을 페이지별 실제 저장 성공부터 30일 보관 규칙으로 사용하지 않는다. 무료 API/PG만으로 지속 실행·재시작 복구를 보장하지 않는다. |
| H03 · [Render 영속 디스크](https://render.com/docs/disks) | mount 범위만 영속이고 한 서비스 인스턴스만 접근한다. 디스크 부착은 다중 인스턴스·무중단 배포를 제한한다. 일별 snapshot을 최소 7일 보관한다. | API와 worker가 한 로컬 디스크의 이미지·ZIP을 공유한다고 가정하지 않는다. 별도 공유 객체 저장과 snapshot 잔존/삭제 범위를 대조해야 한다. |
| H04 · [Railway 가격](https://docs.railway.com/pricing) | Hobby $5/월·Pro $20/월의 구독액은 사용료에 포함된다. Hobby 사용료 $3이면 총 $5, $8이면 총 $8이다. RAM $10/GB-month, CPU $20/vCPU-month, volume $0.15/GB-month, service egress $0.05/GB다. | $5를 API+worker+PG의 실제 총월비용으로 표시하거나 구독액과 포함 사용료를 이중 계산하지 않는다. 실제 시간/CPU·RAM·저장·전송을 측정한다. |
| H05 · [Railway 체험](https://docs.railway.com/pricing/free-trial) | 체험은 최대 30일 또는 일회성 $5 소진까지다. 이후 Free 월 $1 credit이 있으며 Limited Trial은 outbound 제약이 있다. 체험 volume 삭제 기한도 있다. | 실제 계정의 체험 자격·네트워크 접근은 확인하지 않았다. 무료 credit으로 전체 내부 테스트·AI/메일 접근 또는 영속 보존을 보장하지 않는다. |
| H06 · [Railway DB](https://docs.railway.com/databases) | volume은 재배포·재시작 뒤 보존되지만 DB 템플릿은 unmanaged다. backup/재해 복구·성능·보안/접근 통제·모니터링/유지보수는 사용자 책임이며 외부 관리형 DB 연결 등을 안내한다. | Render 관리형 PG와 같은 운영 책임으로 표시하지 않는다. API/worker 플랫폼 선택과 PG 관리 책임 선택을 구분한다. 실제 PG backup/restore·권위 기록의 복구를 검증한다. |
| H07 · [Railway Serverless](https://docs.railway.com/deployments/serverless) | outbound 비활성을 기준으로 약 5~10분 뒤 휴면하며 DB/내부 통신이 휴면을 막을 수 있다. cold start 지연/502가 가능하고 설정은 새 배포 뒤 적용된다. | host 휴면 시계는 사용자 단절 5분·공급사 제한 대기 10분과 별개다. polling worker 휴면/절약이나 재가동 뒤 안전한 외부 호출 재시도를 자동 보장하지 않는다. |
| H08 · [Railway Buckets](https://docs.railway.com/storage-buckets) | private S3-compatible 객체 저장, $0.015/GB-month와 무료 bucket egress/API operations를 안내한다. service가 프록시/업로드하면 service egress 과금은 남는다. object versioning/lifecycle configuration은 미지원이며 전체 bucket 삭제 뒤 52시간 복원이 가능하다. | bucket 삭제와 개별 DeleteObject의 잔존 범위를 구분한다. 자동 30일 실제 삭제·service 전송비 0을 가정하지 않는다. 라이브러리 객체별 삭제/누락 대조·복제/복구 보존 적합성을 확인한다. |
| H09 · [DigitalOcean Droplet 가격](https://www.digitalocean.com/pricing/droplets) | VPS의 Regular Basic 표에 512MiB/1vCPU $4, 2GiB/1vCPU $12, 4GiB/2vCPU $24/월이 있다. Droplet은 IaaS이며 OS·앱·데이터 관리는 사용자 책임이라고 명시한다. | 작은 시작 가격을 우리 사양 추천·총운영비·플랫폼보다 싼 실측 결론으로 사용하지 않는다. API/worker/DB를 같은 VM에 둘지, DB를 별도 관리형으로 둘지에 따라 장애/원가/운영 책임이 달라진다. |
| H10 · [DigitalOcean 서버 설정 안내](https://docs.digitalocean.com/products/droplets/getting-started/recommended-droplet-setup/) | SSH 키, 서버 설정, VPC/모니터링/backup, 비루트 사용자, firewall 설정을 운영자가 준비하는 흐름을 안내한다. | 직접 VPS를 우선하면 OS 보안 갱신·프로세스 재가동·DB backup/restore·장애 대응을 구현 인계에 포함한다. 이 문서의 명령은 실행하지 않았고 실제 서버를 만들지 않았다. |

가격·기능은 바뀔 수 있으므로 실제 채택·예산 승인 직전에 다시 확인한다. Render 가격 페이지를 직접 열었을 때 compute 표가 텍스트로 추출되지 않아 공식 pricing 검색 인덱스의 사양 표와 조사 담당의 결과를 대조했다. PowerShell의 공개 pricing HTTP 읽기는 TLS 인증 오류로 내용을 얻지 못했다. 인증 검증을 해제하거나 계정에 접근하지 않았다. 지역/실제 공급 사양·청구 화면·전체 서비스 비용은 미검증이다.

## 2. 후보 비교와 우선 검토 제안

| 항목 | API·worker 플랫폼 우선 | 직접 운영 VPS 우선 |
| --- | --- | --- |
| 첫 배치 | Render 또는 Railway 계열의 API/별도 worker, 별도 PG·공유 객체 저장 책임 대조 | VM에 API/worker 구성, 자체 또는 별도 관리형 PG·공유 자산 구성 대조 |
| 운영 부담 | 플랫폼 배포/프로세스 운영을 쓰되 앱 복구·보안·삭제·비용 책임은 남는다. Railway 기본 PG는 직접 관리다. | OS/네트워크/프로세스/DB 유지보수와 backup/장애 복구 책임이 늘지만 구성 제어 범위가 넓다. |
| 비용 비교 | Render 작은 compute 합계 $20와 Railway 최소 구독/실사용을 구분. 추가 storage/traffic/auth/AI 반영 | VM 사양표에 backup·객체 저장/트래픽·별도 DB/auth/AI 및 운영 부담을 더해 비교 |
| 공통 필수 조건 | PG 원 기한·발행/수행불명/정산/명령 사실을 재가동 뒤 대조. file 서명/현재 계정·one-context/owner guard 유지 | 같은 조건. VM reboot/자동 restart를 외부 호출 완료·안전 재시도 증거로 취급하지 않음 |

현재 내부 테스트의 구현 준비 부담을 줄이는 방향으로 **API·worker 플랫폼을 먼저 비교하고 PG의 관리 책임을 별도로 확인**하는 순서를 제안한다. 이는 설계 평가/추론이며 사용자 선택·최종 회사 채택·더 낮은 원가/높은 성능을 측정한 결론은 아니다. Q57 후보 질문으로 우선순위만 묻고 지역·사양·월예산·계정/지출 승인은 이후에 정한다.

## 3. 후보 적합성 검증 연결 — 모두 NOT RUN

| ID | 관측과 기대 결과 |
| --- | --- |
| HOV01 중단/휴면·재배포·재가동과 두 시계 | PG에 저장한 원 단절 회차/5분·미시작 공급사 연속 대기/10분을 읽어 판정. 조회/재접속/host restart로 재설정 없음. 앱 session7일·library30일도 별도 근거 유지 |
| HOV02 외부 발행 뒤 worker 종료/새 worker | 수행불명·공급사 조회/대조를 먼저 확인. 결과 불명 동안 추가 비용 호출/같은 실행 중복 발행·무료 환급/잠금 조기 해제 없음. 플랫폼 restart는 재시도 권한 아님 |
| HOV03 실제 객체/사본·복구 보존과 30일 삭제 | 실제 보관 성공별 deadline, current/nonhead/orphan 객체·해당 library 사본/캐시·backup/snapshot 범위 확인. URL 만료/접근 차단·삭제 접수·전체 bucket 삭제만으로 완료하지 않음. 다른 목적의 live asset·ZIP 임시 보존은 각각 계약과 대조 |
| HOV04 자료·동시 작업·월비용 산정 | 첫 7언어 방향, PNG/JPEG 입력·PNG ZIP에서 peak RAM/CPU/temp disk·DB 연결·객체량·전송을 측정. 사양/처리량과 비AI 월비용·별도 AI 원가/예산을 계산하고 미정 상한 전 유료 경로 활성화 없음 |

HOV01~04는 [준비 명세](../../../docs/superpowers/specs/2026-10-03-manga-web-preimplementation-readiness.md)의 G02/G05/G07 및 PGV/EOV/ASV/FX에 연결할 설계다. 실제 host/PG/객체 삭제·품질·전체 견적/제품 성공은 확인하지 않았다. 새 저장 기술을 서비스 확정 계약으로 승격하지 않는다.

후속 사용자 추천안 수락으로Q57-A 플랫폼우선검토를선정했다. 위임D02는Render/같은Singapore PG18·별도API/worker를첫상세검증기준,D03은privateR2공유자산후보다. 실제자원/전체월예산·회사계정/지출/적합성은선정만으로승인·PASS처리하지않는다. 답/이유·대안과gate는추천선정/인계상세를따른다.
