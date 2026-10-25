# 비용·성능·확장·개발 순서 — PROPOSED

2026-09-27 관찰 기준. 이 문서의 견적은 **독립 서비스의 가정 기반 예산**이다. Torii/Ichigo의 실제 원가·마진을 역산한 것이 아니다. 인건비·세금·법무·지원 인력·환불/분쟁·국가별 결제 수수료는 견적 밖이다. 계산 가능한 [CSV](cost-model.csv), [JSON](cost-model.json)을 함께 제공한다.

## 1. 확인한 공개 단가와 가정

| 항목 | 공식 공개 단가 / 가정 | 출처·범위 |
|---|---|---|
| Gemini3.1 Flash-Lite | 입력$0.25/M tokens, 출력$1.50/M tokens | [공식 가격](https://ai.google.dev/gemini-api/docs/pricing), standard text. 미래가격/모델수명은 재확인 |
| Runpod A40 Pod | $0.49/GPU-hour 표시 | [공식 가격](https://www.runpod.io/pricing), 가용지역/재고/스토리지별별도, serverless단가와혼용안함 |
| R2 Standard | $0.015/GB-month, A $4.50/M, B $0.36/M, Internet egress 무료 | [공식 가격](https://developers.cloudflare.com/r2/pricing/), free allowance 미차감·단위반올림미반영 |
| 결제 예시 | 미국 국내카드2.9%+$0.30/transaction | [Stripe 가격](https://stripe.com/pricing), 운영법인·국가/카드에따라달라짐 |
| API/DB/Redis/monitor | 규모별 아래 budget | 벤더 견적이 아닌 명시적 예산 가정; 실제 지역/HA/backup 옵션으로견적대체 |

Stripe는 설계용 adapter 예시다. 한국어 사용자라는 이유로 미국 Stripe 가격/merchant 자격을 적용할 수 없다. 실제 법인·영업국가가 정해진 뒤 지원되는 PSP/MoR와 세무·환불을 선택한다. 이 결정은 pipeline prototype을 막지 않는다.

한 페이지 평균 입력1,500tokens(현재문단900+glossary/context600), 출력400tokens를 가정한다. LLM단가=(1500×0.25+400×1.50)/1e6=$0.000975/page. 긴요약·reasoning·vision·repair 호출은 상한과실사용량으로별도기록한다. 평균값을request별고정요금으로신뢰하지않는다.

GPU processing 가정: detection0.10s + OCR1.50s + complex inpaint30%×1.20s =1.96 GPU-seconds/page, 유효사용률50%. **이 시간은 미측정 설계값**이다. 1k/10k페이지는 월20GPU-hour를 확보하는pilot이며 cold-start를허용한다. 100k는A40한대730h,1M은두대1460h 상시가동 가정이다. 장애대비세번째여유GPU/spot변동은30%예비비안에서가능한지실부하로확인한다. 1M부하에peak10배면추가burst worker가필요할수있다.

평균 총artifact4MB/page, 보존7일로 GB-month=N×0.004×7/30. write5/get10 operations/page. 별도 CPU export $0.0002/page, cross-cloud transfer2MB/page×$0.01/GB는 budget가정이며 R2 Internet egress와중복청구주장이아니다. DB/monitor 원문보관량·backup일수에따라증가한다.

## 2. 월 비용 시나리오 (USD)

| 항목 | 1,000page | 10,000page | 100,000page | 1,000,000page |
|---|---:|---:|---:|---:|
| LLM+context |0.98|9.75|97.50|975.00|
| Detection/OCR/Inpaint GPU |9.80|9.80|357.70|715.40|
| CPU export |0.20|2.00|20.00|200.00|
| Object storage |0.01|0.14|1.40|14.00|
| Object operations |0.03|0.26|2.61|26.10|
| Other transfer budget |0.02|0.20|2.00|20.00|
| API/backend budget |15|35|120|800|
| PostgreSQL budget |0|25|100|400|
| Redis budget |0|10|40|180|
| Monitoring budget |0|10|30|120|
| Infrastructure subtotal |26.04|102.15|771.21|3450.50|
| 30% reserve |7.81|30.65|231.36|1035.15|
| Payment fee example |1.18|11.80|118.00|1180.00|
| **Total** |**35.03**|**144.60**|**1120.57**|**5665.65**|
| **Cost/page** |**0.03503**|**0.01446**|**0.01121**|**0.00567**|

결제항목은 모든500page마다$10결제가한번있다는분리된매출가정이다. 무료사용·미소진크레딧·구독해지·국제카드는반영하지않았다. 1k에서 DB/Redis/monitor0은 로컬/무료pilot이며 HA Production예산이아니다. “월$35로 production가능”이라고읽으면안된다. artifact만원가가낮아보여도 OCR/GPUidle·지원인력·providerfailures·paymentfee가커질수있다.

민감도: 입력tokens3배이면 LLM당0.00075 추가, 출력3배이면0.0012 추가. complex비율30→80%는page당GPU0.6s 추가. 상시GPU한대는$357.70/month가계속발생. 평균artifact4→20MB/보존7→30일은storage가약21.4배. retry10%는실제로재시도하는단계의원가에만가산한다. 배치할인은 chapter순서/지연SLO가허용할때만채택한다.

## 3. 성능 모델

`T_total = upload + normalize + detect/OCR + context_wait + max(translation, inpaint) + typeset/render + publish/download + queue_wait`.

OCR 이후 translation과inpaint는 서로독립이면병렬이다. 같은chaptercontext commit은순서를지켜야한다. 내보내기PNG가전체이미지를다시전송하면network가병목일수있어 preview thumb/region JSON과full-res export를분리한다.

| 구간 | 초기 warm target | 측정 단위 |
|---|---:|---|
| Upload+normalize |0.3–2s|image bytes/resolution/network|
| Detect+OCR |0.2–3s|regions/tiles/GPU model|
| Translation |0.5–5s|provider/tokens/rate limit|
| Inpaint |0.05–2s|mask fraction/complexity|
| Render+publish |0.05–0.8s|glyphs/dimensions/font cache|
| Queue wait |p95<5s|tenant plan/queue age|
| Full image |warm p95<15s initial SLO|accepted≤4MP,通常20regions、限定provider|

이는제안목표이며서로다른p95를더하면전체p95가되지않는다. end-to-end trace로측정한다. 실제관찰: Torii 한장UI3.43s; 자체CPU프로토타입1회7.02s(로딩6.36s); Ichigo정확한latency는계측안함. 서로환경/언어/모델/계측구간이다르므로성능서열을만들수없다.

SLO는availability99.5%(초기), 성공job의p95목표와함께valid input failure≤1%,silent page loss0,duplicate charge0을운영지표로둔다. 빌링정합성과tenantisolation은오류예산으로허용하지않는다. 4MP초과/대규모PDF는별도batchSLO.

## 4. 사용자 규모와 처리량

MAU와page수는같지않다. 아래는 **MAU당월10page** 예시다. DAU/동시세션과peak를실제analytics로대체한다.

| MAU | 월page | 운영모드 | 확장·보호 |
|---:|---:|---|---|
|100|1,000|pilot 단일API/DB, on-demand inference|tenant concurrent1,실패수동검수|
|1,000|10,000|API2replicas 후보, 관리DB, 분리worker|queue age경보,tenant당2,provider bucket|
|10,000|100,000|warmGPU1+burst,API2+,DBbackup|GPUbatch,OCRcache,DLQ,context lane|
|100,000|1,000,000|warmGPU2 baseline+burst,멀티AZ API/DB|fair queue,providerquota증설,readreplica 필요측정|

1M/month의평균은0.386page/s,10배peak는3.86page/s. GPU1.96s/page·유효50%이면평균약1.51GPU-equivalent,peak약15.1. 따라서두대만으로10배peak를즉시처리한다고약속하면안된다. queue대기허용·burst15대까지예약가능성·providerquota가필요하다. `required_workers=arrival_rate×service_time/utilization`으로시작하고p95queueage로autoscale한다. GPUbatch는같은shapebucket로묶되개인/tenantartifact를섞어노출하지않는다.

LLM provider별RPM/TPM계수와retrybudget를분리한다. 429는Retry-After+jitter, 최대 4 attempts(최초1회+재시도3회, 1/4/16s+jitter), 전체deadline60s(초기예) 후DLQ. 잘못된입력/권한오류는retry안함. 장애시같은prompt/schema조건의fallback만사용하고추가비용이reservation을넘으면사용자에게검수상태로전환한다. Redis손실은DBoutbox로복구하며중복전달을전제로한다. [Celery task/idempotency 문서](https://docs.celeryq.dev/en/stable/userguide/tasks.html)

## 5. P0 → P11 개발 Roadmap

기간은2–3인팀계획가정이며작업순서와gate가우선이다. 이번작업은P0의좁은fixture증명만구현했고P1이후는설계다.

| 단계 | dependency | 산출물 | 테스트 / Definition of Done |
|---|---|---|---|
| P0 Technical proof | 권리확인fixture | 이번CLI와stageartifact |2문장실행+mask/overflow검증; 일반데이터셋으로확장필요|
| P1 Core pipeline | 평가셋·schema |detector/OCR/MT/mask/render adapters |JA최소100pagebaseline,CER/recall/비용측정,실패검수경로|
| P2 Web app |P1+private storage+tenant auth|upload→job→result UI/API |실제네트워크job,진행률,재접속/취소/실패재시도|
| P3 Editor |P2+region revisions|원문/cleaned/text layers,undo/redo |revisionconflict,worker늦은응답,zoom좌표,export一致|
| P4 Batch |P2+stage scheduling|여러page manifest+부분성공 |역순완료/재시도/중복메시지에page누락0|
| P5 PDF/ZIP |P4+isolated extraction|archive/import/export |zip-slip/bomb/encryptedPDF/긴이미지fixture;상한거절|
| P6 Extension |P2/P3 계약|MV3activeTab+optionalhosts,overlay/crop |독립테스트사이트lazy/srcset/canvas/iframe/SPA;auth token DOM노출0|
| P7 Context |P4+읽기순서평가|chapter summary+glossary+reset |동일인명/대명사blindreview,stalecontextcommit0|
| P8 Accounts |P2전부터기초auth필수|team/plan/account UX,retention |tenant침범0,탈퇴/삭제/signedURLexpiry;확장은단계8|
| P9 Billing |P8+atomiccredits|PSPcheckout/webhook+ledger+reconcile |동시예약/중복webhook/부분실패refund/만료credits정합성|
| P10 Public API |P1/P9+quotas|scopedkeys/OpenAPI/usage/SDK |idempotency/429/contract compatibility,secret로그0|
| P11 Mobile |웹실사용수요확인|우선responsive upload,그다음native |OSshare-sheet/gallery+storebilling규칙별검토|

MVP의현실적범위는 **JA→EN 단일이미지+최소editor+안전한계정/queue**다. PDF/ZIP/extension/context/유료출시는그후gate로확장한다. 공개SaaS를auth없이출시한뒤P8에서추가하라는뜻이아니다.

## 6. 첫7일 Sprint

| Day | 구체적 작업 | Output | Test / 완료 기준 |
|---|---|---|---|
|1|빈repo,Python/TSlock,fixture권리manifest,검출baseline |100개권리확인crop/page목록,검출overlay |좌표/원본hash추적,최소10page에서누락표 |
|2|MangaOCR/Paddle동일cropbenchmark,세로/가로분리 |CER분석CSV+provideradapter |최소100regions,blankabstain,14자fixture를일반성능과분리|
|3|regionJSONschema,localMTbaseline+유료adapter인터페이스 |schema검증+영문출력,독립promptv1 |region누락/중복거절,credential없이local경로작동|
|4|glyphmask,flatfill,complexcase분류 |mask/cleanedpair,손상평가 |mask밖원본불변,실패시reviewflag|
|5|fontfit·Unicodewrap·rotation,편집command모델 |PNGexport+layoutmanifest |장문/좁은box/없는glyphoverflow거절|
|6|singlejobCLI→FastAPI/DBoutbox연결,localhostUI |upload/job/result 첫E2E |실제inference·취소·재시작·중복job에1결과|
|7|권리확인holdout실행,사람번역review,성능/원가보고 |failuregallery+수정우선순위 |metric누락0,실패제외금지,P1진입결정 |

7일안에유료SaaS출시를약속하지않는다. dataset·모델품질이gate를못넘으면UI나결제개발보다그실패를먼저해결한다.

## 7. Production 진입순서와 release gate

1. **Week1–2, ML gate:** 데이터권리/품질·모델revision 고정,일본어세로CER목표와failure taxonomy.
2. **Week3–4, persistence gate:** schema migrations와tenantFK/RLS,original/artifactretention,transactionaloutbox,workerlease/fencing. kill-worker/replay 테스트.
3. **Week5–6, product gate:** web/editor/undo/pageorder/export,독립사용자가원문오류를수정해결과를받는goldenpath.
4. **Week7–8, batch/context gate:** ZIP/PDF sandbox,tokenbudget,versionedcontext,glossary와다페이지인명일관성.
5. **Week9–10, extension gate:** 임의웹페이지권한최소화,crossorigin/SPAfixture,untrustedmessagevalidation,Chrome/Firefox별별도build/실행.
6. **Week11–12, commerce gate:** 결제testmode,signature/replay/out-of-order events,creditreservation·settlement·refund·reconciliation. 별도실결제승인없이는live결제안함.
7. **Week13–14, operations gate:** staging 부하시험,backup복원,retention삭제검증,provider실패주입,secretrotation,dependency/modellicense검토.
8. **Week15+, release gate:** 제한beta→smallcanary→단계확장. 사용자승인후deployment만진행;계정·법인·region·비용상한결정필요. mobile은수요따라후속.

배포는IaCplan검토→별도staging환경→one-offmigrationlock→compatibleAPI/worker배포→readiness/inferencewarmup→syntheticcanary→1%traffic→errorbudget확인→확장. DB는expand/contractmigration,이전worker가새필드를못읽으면동시운영전환금지. 모델/프롬프트/renderer는독립versionpin과rollback. schema를되돌려데이터를잃기보다forwardfix/featureflagdisable을우선한다. 장애복구는RPO15분/RTO4시간목표로restore drill해실측값을기록한다.

## 8. Monorepo

```text
manga-translator/
  apps/web/                 # React upload/editor/job UI
  apps/extension/           # MV3 popup/content/background, Firefox variant
  apps/api/                 # FastAPI modular API; no model inference in HTTP worker
  apps/worker/              # stage dispatcher, outbox, leases, retry
  packages/contracts/      # JSON Schema/OpenAPI generated TS + Python types
  packages/editor/         # shared commands, coordinate transforms, preview
  packages/db/             # migrations, RLS tests, accounting transactions
  packages/providers/      # detector,ocr,translator,inpainter adapters
  packages/pipeline/       # immutable stage IO, model/prompt versions
  packages/renderer/       # measured layout, font manifest
  tests/fixtures/          # owned/consented inputs + rights manifest
  tests/e2e/               # public pipeline and isolated extension sites
  benchmarks/              # holdout metrics, cost model, failure gallery
  infra/docker/            # CPU/GPU images and pinned model manifests
  infra/terraform/         # storage/IAM/network/DB/queue/monitoring
  docs/adr/                # decisions and rejected alternatives
  docs/runbooks/           # billing,provider,queue,retention,restore
```

첫코드는웹화면보다 `Region` schema와fixturebenchmark에서시작한다. 모든provider출력을같은schema로정규화해야OCR교체·editor·context·renderer가분리된다. 그다음검증된singleimage엔진을job/tenant/usage단위로감싸는순서다. 최초부터많은microservice를만들지않고GPU/CPU부하와securityboundary가필요한worker부터격리한다.

## 9. 주요 위험과 대응

| Risk | 왜 어려운가 | release 전에 필요한 evidence |
|---|---|---|
| Vertical/ruby OCR |문자방향/읽기중복/작은glyph |언어·방향별CER,manualcorrection |
| Reading order |panelgeometry만으로화자순서불충분 |orderlabelset+ambiguity UI |
| Complex inpaint/SFX |그림이텍스트와겹침 |mask밖변경/사람검수+원본복원 |
| Authenticated images |cookie·referer·canvas경계 |hostpermission/crop fallback,권한우회없음 |
| Typography |기하맞춤과언어가독성다름 |fontlicense+glyphcoverage+CJK/RTLgoldens |
| Context cost |N페이지누적은token비용급증 |boundedsummary+tokenmeter+resetrace |
| Billing |at-least-onceevent·취소경합 |concurrency/replay/reconcile tests |
| Privacy |이미지·번역문·URL이민감할수있음 |retentionworker·logredaction·provider정책 |
| Model/license |code license≠모든학습data권리 |model/fonts/datasetprovenance review |

외부AI provider 데이터정책을설정에연결한다. 예를들어Google가격표는free와paid의개선학습사용여부를다르게표시한다. production사용자이미지를무료계층에보내기전에그계약을검토한다. 로그는URLquery와원문본문을기본저장하지않는다. OCR원문삭제요청은이미지뿐아니라context/backup보존정책에도반영한다.

저작권/번역물재배포/상용만화처리/DMCA접수·이의제기절차는서비스국가와대상시장에맞게법률전문가검토가필요하다. 미국Section512는조건이있는제도이며제품에버튼을두는것만으로면책되지않는다. [미국 저작권청 자료](https://www.copyright.gov/512/). 원본을모델학습에사용하는기본값은off로두고별도권리·동의를요구한다. 이번조사는법률적허용판정을제공하지않는다.
