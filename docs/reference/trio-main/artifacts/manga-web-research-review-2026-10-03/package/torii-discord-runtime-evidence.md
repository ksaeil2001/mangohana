# Torii — 로그인 후 Discord·실행 증거

관찰일 2026-09-27 KST. 사용자 정상 로그인, 공식 초대 링크에서 연결된 서버. 민감정보·인증값은 수집하지 않았다. 개발자 발언은 **진술이 확인됨**을 뜻하며 서버 코드·가중치의 독립 검증을 뜻하지 않는다. 날짜는 Discord 표시 KST이며 UTC는 하루 전일 수 있다. 기존 T-001…T-108과 분리한 보충 원장이다.

| ID | Source / Author / Date | Evidence | Technical meaning | Classification |
|---|---|---|---|---|
| T-200 | [FAQ](https://discord.com/channels/1291766586591547413/1291767625487220928/1418628906604433420), stringie, 게시2025-09-20·수정2026-05-23 | BYOK에도 OCR/서버/처리/GPU/DB 등의 원가 때문에 기본1크레딧 | LLM 비용과 영상 파이프라인 원가를 분리 | CONFIRMED—개발자 설명 |
| T-201 | [FAQ](https://discord.com/channels/1291766586591547413/1291767625487220928/1475796320961953833), stringie, 2026-02-24 | Lemon Squeezy 주문완료 신호가 늦으면 지급 스크립트가 실행되지 않아 수동 크레딧 보정 | 결제와 entitlement 사이 운영 실패 사례. 약1/200은 발언이지 측정 검증 아님 | CONFIRMED—사례 진술 |
| T-202 | [업데이트](https://discord.com/channels/1291766586591547413/1297888673953480724/1550906478754267296), stringie, 2026-09-20 | extension UI를 website와 맞추도록 재작성, editor 성능 개선 | 최신 전환 시점 추가. 60fps 주장은 벤치마크 미검증 | CONFIRMED—배포 공지 |
| T-203 | [업데이트](https://discord.com/channels/1291766586591547413/1297888673953480724/1553195684285653034), stringie, 2026-09-26 | usage graph 및 API usage endpoint 공지 | 과거 /updates 수집 이후 최신 운영 기능 보강 | CONFIRMED—공지 |
| T-204 | [원문 대화](https://discord.com/channels/1291766586591547413/1291766589107998837/1542922646918930522), stringie, 2026-08-29 00:43 | LLM은 문단 번역에만 사용하고 검출·클리닝 등은 별도 파이프라인 | 이미지 전체를 LLM에 보내는 단일 단계 구조라는 주장을 반박 | CONFIRMED—개발자 설명 |
| T-205 | [OCR 답변](https://discord.com/channels/1291766586591547413/1291766589107998837/1542925396092129280), stringie, 2026-08-29 00:54 | Comic Text Detector를 쓰냐는 질문에 수개월간 자체 OCR engine을 만들었다고 답변 | 자체 엔진 진술. base 모델/학습 데이터/외부 OCR 조합은 UNKNOWN | CONFIRMED—개발자 설명 |
| T-206 | [Inpaint 답변](https://discord.com/channels/1291766586591547413/1291766589107998837/1542926168024682557), stringie, 2026-08-29 00:57 | “it's an optimized lama yeah” | LaMa 계열 최적화 사용 진술. 정확한 fork/checkpoint/runtime UNKNOWN | CONFIRMED—개발자 설명 |
| T-207 | [Typeset 답변](https://discord.com/channels/1291766586591547413/1291766589107998837/1542926669197615114), stringie, 2026-08-29 00:59 | typesetting의 Pillow 사용을 긍정 | 서버 식자에 Pillow 사용 진술. web editor 라이브러리를 뜻하지 않음 | CONFIRMED—개발자 설명 |
| T-208 | [추가 검출기](https://discord.com/channels/1291766586591547413/1291767392204099594/1540156859162431628), stringie, 2026-08-21 09:33 | 하트 기호를 덮도록 inpaint 영역을 확장하는 두 번째 검출 모델 추가 | 인식 정확도 개선과 제거 mask 개선은 별개; 모델 이름 UNKNOWN | CONFIRMED—개발자 설명 |
| T-209 | [문단 순서](https://discord.com/channels/1291766586591547413/1291767392204099594/1540161674739191908), stringie, 2026-08-21 09:52 | OCR이 문단을 top-to-bottom으로 번역에 전달 | 전통 만화의 panel-aware RTL 순서를 보장하지 않음 | CONFIRMED—개발자 설명 |
| T-210 | [Context](https://discord.com/channels/1291766586591547413/1366831921983783115/1540847990120390666), stringie, 2026-08-23 07:19 | 이미지별 처리, context sharing으로 이미지 간 번역 연결 | public API context 왕복과 일치. 내부 queue 기술은 여전히 UNKNOWN | CONFIRMED—설명 |
| T-211 | [Context 수명](https://discord.com/channels/1291766586591547413/1291766589107998837/1551341299532304435), stringie, 2026-09-21 06:16 | 새로고침/페이지 변경 시 context 소실 설명 | 세션 수명 제약 진술. 모든 클라이언트에 동일하게 일반화하지 않음 | CONFIRMED—설명 |
| T-212 | [실제 web 실행](https://toriitranslate.com/image), 2026-09-27 | 소유한900×650 합성 PNG 한 장, English, Gemini3.1 Flash Lite, None reasoning. 결과와 상세 패널 생성 | 실제 한 장 성공. extension/mobile/API 직접 실행과 대규모 품질 검증은 아님 | CONFIRMED—관찰 |
| T-213 | 동일 실행 상세 | 1.10 credits=OCR1+translation0.10; total3.43s; Torii1.09s/network2.33s; upload1.15s,OCR0.21s,inpaint0.13s,translation0.86s,render0.02s,download0.44s,other0.61s; input294/output48/reasoning0 | 서비스가 표시한 계측값. 단계 합이 total과 반올림 차이 있으며 병렬 단계 가능; 외부 stopwatch/서버 tracing 검증 아님 | CONFIRMED—UI 보고 |
| T-214 | 동일 실행 Export Texts | 원문4블록: 今日はいい天気 / Independent synthetic research fixture / こんにちは。 / Ο. 번역: The weather is nice today. / 그대로 footer / Hello. / O | 세로 일본어 의미는 처리했으나 종결점이 독립 O로 인식되는 오류 관찰 | CONFIRMED—관찰 |

## 증거 파일과 제한

- [원본](japanese-synthetic.png), [결과 화면](torii-runtime-result.png), [상세 패널](torii-runtime-details.png).
- 사용자 승인 범위 내 한 장만 처리했다. 잔액 표시는 반올림되므로 정확한 과금 근거는 상세 패널1.10을 사용한다.
- 결과 ZIP 내보내기는 UI 선택까지 했으나 도구의 download event가 시간 초과되어 다운로드 파일 확보는 미검증. 번역 성공 자체는 별도 결과/텍스트/상세로 확인했다.
- 모델 문자열은 선택·보고된 ID이며 upstream provider의 실제 호출을 독립 입증하지 않는다.
- Discord 검색: inpaint→OCR→원문 대화에서 LaMa/Pillow 발견; context 검색으로 문단·이미지간 전달 수명 보강. GPU 검색은 결과 없음이었으며 GPU 부재로 해석하지 않는다.
- 일반 대화, 개인 신상, 다른 서버 정보는 조사 산출물에 포함하지 않았다. 메시지를 게시하거나 반응하지 않았다.
