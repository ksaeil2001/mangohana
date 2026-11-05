# 로컬 자동화 후보 검증

기존 Electron Main·preload·OCR·번역·인페인팅 adapter·Canvas 번인을 실제로 연결하는 검증 도구다. 사용자 프로필과 프로젝트를 덮어쓰지 않는다. 결과는 검토용 후보 PNG이며 정식 UI export·사람 검수·처음 보는 작품의 품질 합격과 구별한다.

## 실행

1. 기존 소스와 dirty 변경을 사본·SHA 목록으로 보존하고, **별도 소스 사본 안에서** 저장소의 Electron·Vite 빌드를 실행한다. 원래 `dist-*`를 덮어쓰지 않는다.
2. 기존 모델·런타임·설치 provenance와 SHA를 확인해 서비스 설정 JSON을 작성한다. `services.mjs <서비스 설정 JSON>`으로 전용 로컬 모델 서버를 시작한다.
3. `run.mjs <앱 검증 설정 JSON>`을 로컬 통신이 가능한 실행 환경에서 실행한다. 출력 폴더는 새 경로만 지정한다.
4. 생성된 `run.json`, 단계별 제안·마스크·인페인팅 기록·수정 전후 후보 PNG를 확인한다. `node scripts/local-preview/run.mjs --check-report <run.json>`은 생성 완료/부분 실패/실패를 종료 코드 0/2로 구별한다. 종료 코드 0은 이미지 품질 합격을 뜻하지 않는다.
5. 서비스 출력 폴더에 새 `STOP` 파일을 생성해 자신이 시작한 프로세스 트리를 종료하고, `supervisor.json`에서 종료 결과를 확인한다.

이번 로컬 실행의 설정 예시는 `artifacts/automation-quality-20261105/continuation/*config*.json`에 있다. 모델 경로가 포함된 로컬 실행 기록이며 배포용 기본값이 아니다. Playwright는 기존 `artifacts/mangohana-baseline-20261029`의 설치를 재사용한다. GPU 비교용 ORT와 NVIDIA DLL은 실행 기록에 적힌 별도 venv에 설치하며 제품 `package.json`·기존 CPU Python은 변경하지 않는다.

서비스 설정에는 `output`, `translationPort`(현재 검증 11435), `inpaintingPort`(기존 앱 adapter 기본 8080), `modelAlias`, `llamaServer`, `gemmaModel`, `python`, `lamaBridge`, `lamaWorker`, `lamaModel`이 필요하다. 타일 분할 실험에는 `lamaTileWrapper`를 지정한다. 설치 worker와 모델은 수정하지 않는다. bridge는 loopback 주소에만 bind하며 기존 포트 프로세스를 종료하지 않는다.

앱 설정에는 `repository`, 빌드된 `source`, 비교 기준의 `beforeSource`, 새 `output`, `installedLocalAppData`, `translationEndpoint`, `model`, `inputs`가 필요하다. `LOCALAPPDATA`는 기존 서명 OCR pack을 읽는 데만 사용하며 앱 `userData/sessionData/temp/documents/home`는 전용 경로다. API 키는 전달하지 않는다. 정식 OCR 채택·번역 채택·원문 제거 사용자 승인 IPC는 차단한다.

## 증거의 범위

- OCR·번역 제안을 재사용하면 `reuseDrafts`와 실제 원본 SHA·OCR run ID를 기록하고 새 End-to-End 추론으로 세지 않는다. 번역은 영역 ID·문맥 지문을 검사하며 명시적인 빈 사용자 번역도 우선한다.
- LaMa 마스크는 이진 알파 0 제거/255 보존을 L PNG의 흰색 제거로 변환한다. 투명 픽셀의 보이지 않는 RGB는 Canvas가 정규화할 수 있다. 보존 픽셀의 흰색·크기·바이너리 알파·출력 alpha·마스크 밖 RGB 검증은 유지한다.
- `lama_worker.py`는 고정 512/32 halo의 기존 추론을 재사용하면서 일반 마스크를 덮는 비중첩 core의 격자 시작점만 선택한다. 타일 수가 줄어도 예측된 내부 픽셀과 경계 품질은 달라질 수 있으므로 시각 검토가 필요하다. `lama_profile.py`는 원래 worker의 함수·타일 시간을 기록하는 별도 진단이다.
- 현재 `translation-image` 토큰 URL의 직접 Canvas 로딩은 CORS에 막힌다. 검증 호스트는 기존 세션 검사로 얻은 토큰을 Main에서 읽고 자산 SHA·20MiB 제한을 확인한 뒤 한 페이지의 data URL로 전달한다. 공개 IPC·private protocol 권한은 변경하지 않는다. 이 경로로 저장한 PNG를 정식 UI export 성공으로 세지 않는다.
- `releaseOcrAfterPage: true`는 순차 실행 중 실제 OCR 완료 뒤 자기 child 종료를 최대 5초 안에 확인하는 **검증 호스트 자원 분리 실험**이다. 실패하면 다음 모델로 진행하지 않는다. 제품 런타임의 수명 변경이나 이전 충돌의 OOM 확정 근거가 아니다.
- IPC·번역·식자·Main 전송의 응답 deadline이나 renderer 종료, 자원 해제 미확인은 실행 전체를 중단한다. 후속 페이지를 시작하지 않고 소유 앱의 실제 종료를 확인하며, 이를 모델 재시도로 연결하지 않는다. 강제 종료는 자신이 시작한 자식 PID만 대상으로 하며, 명령 자체도 4초로 제한하고 종료 미확인은 실패로 기록한다. 일반적인 완료된 제공자 오류는 페이지별 실패로 기록한다.
- `lama_cuda.py`는 같은 ONNX Runtime 1.23.2의 CUDA/CPU 혼합 배치를 비교한다. 격리된 NVIDIA DLL 디렉터리는 해당 worker 프로세스에서만 연결한다. 실제 CUDA 연산 배치는 별도의 `--profile` 진단으로 확인하며, 연산마다 대량 기록하는 프로파일은 기본적으로 끈다. CUDA arena 2GiB는 전체 VRAM 상한이 아니다. 메타데이터·원본 모델 SHA·유한 픽셀/범위·마스크 밖 RGB·alpha 검증과 55초 제한은 유지한다.
- `lama_directml.py`는 실패한 별도 제공자 비교 실험의 재현 코드다. 등록 provider 목록만으로 GPU 작업 성공이나 RTX 장치 선택을 선언하지 않는다. CPU와 CUDA의 성공 결과를 실패한 DirectML 실행의 성공으로 합치지 않는다.

현재 제공된 6쌍은 전부 과거 노출 자료다. 사람이 확정한 OCR·좌표·읽기 순서·번역과 미사용 평가 세트가 확보되기 전에는 일반화 성공률을 계산하지 않는다. 자세한 기준·실행 실패·남은 문제는 `docs/validation/2026-11-05-automation-baseline.md`를 따른다.
