# 공급자 어댑터 근거와 현재 활성화 경계

2026-10-03 공식 원문과 원저자 고정 코드를 대조했다. 코드의 fake transport 검증과 실제 계정·네트워크·요금·품질은 별도다. 실제 연결 및 기능 실행은 미검증이며 실제 호출 gate는 OFF다.

`gemini-3.5-flash-lite` Stable, 이미지 입력·structured output·thinking의 문서 근거는 [공식 모델](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)에서 확인했다. 선택한 generateContent의 LOW/MEDIUM/HIGH는 [공식 thinking](https://ai.google.dev/gemini-api/docs/generate-content/thinking)과 [REST enum](https://ai.google.dev/api/generate-content#ThinkingConfig)을 따라 같은 값으로 직렬화한다. 모델/수준 fallback, 숫자 budget 전환, 로그 저장·도구·검색·캐시 사용을 추가하지 않는다. structured output은 [generateContent 안내](https://ai.google.dev/gemini-api/docs/generate-content/structured-output)와 REST schema를 대조하고 로컬 strict JSON/schema/좌표·scope 검증을 별도로 수행한다.

[usage 계약](https://ai.google.dev/api/generate-content#UsageMetadata)의 prompt/candidate/thought/cached/total 값을 보존한다. 누락한 사고·캐시 값을 0으로 확정하지 않는다. [가격표](https://ai.google.dev/gemini-api/docs/pricing#gemini-3.5-flash-lite)의 Standard 입력 $0.30/1M, 응답+사고 $2.50/1M은 확인일의 문서 값이며 실제 적용 tier/가격 version의 증명이 아니다. token 비용 계산과 측정된 전체 공정 원가 확인은 다른 인터페이스다. 전체 원가 근거가 없으면 Observation.costUsd는 null이다.

선택한 endpoint의 client 멱등 POST·개별 수행의 권위 GET은 DOCUMENTED_CAPABILITY_NOT_FOUND다. responseId/modelStatus/local journal은 수행 부재 증명이 아니다. timeout/유실/불명 HTTP 오류는 UNKNOWN으로 유지하며 lookup으로 원 POST를 재실행하지 않는다. MAX_TOKENS는 checkpoint 성공으로 처리하지 않는다. 외부 입력 material loader의 crop/mask 범위, 실제 계정 모델/상한·사용량/전체 원가를 검증하기 전에는 활성화하지 않는다.

LaMa는 [원저자 commit](https://github.com/advimman/lama/commit/786f5936b27fb3dacd2b1ad799e4de968ea697e7)의 Apache-2.0 코드와 [이미지·마스크 합성](https://raw.githubusercontent.com/advimman/lama/786f5936b27fb3dacd2b1ad799e4de968ea697e7/saicinpainting/training/trainers/default.py)을 근거로 한다. 가중치·별도 사용 조건·hash·runtime·자원·만화 배경 품질은 미검증이다. 앱이 출력 크기를 대조하고 binary mask 밖 원본 RGBA를 다시 합성한 뒤 실제 변경 0을 검사한다. provider success와 background QA·사용자 승인은 합치지 않는다.

R2는 [S3 API 호환](https://developers.cloudflare.com/r2/api/s3/api/)의 If-None-Match/HEAD/DELETE와 [강한 일관성](https://developers.cloudflare.com/r2/reference/consistency/)을 근거로 한다. 2026-10-04에는 [AWS SigV4 원문과 공개 예제](https://docs.aws.amazon.com/AmazonS3/latest/developerguide/sig-v4-header-based-auth.html)를 기준으로 순수 서명 helper와 R2 endpoint의 bounded HTTP transport를 구현하고 오프라인 공개 예제 4개를 대조했다. 선정한 완료 응답은 [PutObject의 200](https://docs.aws.amazon.com/AmazonS3/latest/API/API_PutObject.html), [DeleteObject의 204](https://docs.aws.amazon.com/AmazonS3/latest/API/API_DeleteObject.html)뿐이며 예상 밖 2xx는 종결 성공으로 취급하지 않는다. 이는 S3 계약을 좁혀 구현한 근거이며 실제 R2 계정에서의 응답·권한·호환성 확인을 대신하지 않는다.

PG의 immutable PUT intent와 append-only storage confirmation을 별도로 보관한다. 첫 reserve 객체에만 한 번의 제출 권한을 부여하고 복사·조회·재시작으로 되살리지 않는다. 같은 account/bucket/key는 평생 한 intent만 가지며 transport terminal과 최초 시각은 CAS로 확정한다. HEAD의 attempt/SHA/길이/성공 시각과 실제 GET bytes를 원 intent에 대조하고 ETag를 SHA-256으로 쓰지 않는다. read마다 현재 HEAD/GET을 각 한 번 확인하며 과거 confirmation은 현재 객체 존재의 cache가 아니다.

403/timeout/미결 PUT 뒤 HEAD 부재는 삭제 완료가 아니다. 정확한 저장 bytes를 확인해도 RESERVED/SENDING/UNKNOWN의 미결 transport는 해제하지 않고 DELETE를 보류한다. journal 없는 key도 삭제를 확정하지 않는다. ACK와 일치하는 저장 confirmation이 있는, 앞으로 같은 key에 PUT할 수 없는 경우만 DELETE/현재 부재를 대조한다. 삭제 후 과거 confirmation과 원 성공 시각은 보존하지만 읽기와 재PUT은 허용하지 않는다. process crash로 종결 확인이 없는 intent는 운영 대조 전까지 보류 상태가 유지된다.

fake credential·HTTP와 실제 API/worker LOGIN의 격리 PG18에서 응답 유실, 재시작·경합·늦은 응답, 현재 bytes/metadata 불일치, 삭제 뒤 읽기·재PUT, 예상 밖 2xx, bucket 오조립, timeout/응답 크기를 검증했다. R2 관련 12개와 migration 4개는 PASS이며 실제 credential/private bucket/외부 호출은 NOT RUN/OFF다. lifecycle만으로 정확한 30일 접근 차단·실제 삭제 완료를 보장하지 않는다.

2026-10-04 Gemini 응답 수신은 fetch와 성공/오류 body 전체에 deadline/선언·실제 bytes 제한을 적용했다. 끝나지 않는 cancel에 묶이지 않으며 늦은 응답은 START/비용/data를 반영하지 않는다. 이 검증은 fake HTTP의 네트워크 수신 범위이고 전체 CPU·native 메모리 제한이나 실제 Gemini 실행·원가의 증거가 아니다.

scoped material은 저장 INPUT/account/asset digest·dimensions/font/license/profile을 대조하고 immutable GEMINI_MATERIAL 계획을 보관한다. 선택 whole polygon 및 raw stroke 밖 RGBA는 crop 전에 모두 대체하며 PAGE만 전체 source를 전송 대상으로 삼는다. known reading order/geometry 대응이 모호하면 거부한다. novel PAINT polygon의 실제 binary cleanup union은 captured stroke 밖·기존 block mask와의 충돌을 거부한다. 번역은 선택한 OCR 텍스트만 전송 대상으로 삼고 이미지·미선택 텍스트를 포함하지 않는다. 자체 데이터의 직접 회귀11개는 PASS다. 실제 worker LOGIN DB 연결6개는 `pg-aVDePW`의5개 통과와 `pg-F5y7np`의 마지막1개 통과로 확인했다. 이전 ENOSPC/시간 제한과 중복 digest가 DB UNIQUE에 거부된 fixture 실패를 보존했다. 마지막 fixture는 동일 digest 거부를 먼저 검증한 뒤 별도 digest의 상충 계획을 넣어 loader의 다중 계획 거부/원 기록 보존을 검사한다. cleanup 영향21개도 E:의20개와 C:의 시간 제한 사례1개 재검증으로 확인했으며 E: PG의 지연된 정상 종료 로그와 pid 소멸을 확인했다. 미측정 profile/전체 원가·권리/실제 제공자 검증 gate는 OFF로 유지한다.
