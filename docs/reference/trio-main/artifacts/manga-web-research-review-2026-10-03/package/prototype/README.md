# 독립 로컬 기술 프로토타입

이 코드는 실제 OCR·기계번역 모델을 실행한다. Torii/Ichigo API를 호출하거나 그 배포 코드를 복제하지 않는다. **평평한 흰 말풍선에 한정한 기술 증명**이며 범용 만화 번역 SaaS가 아니다.

## 실제 실행 결과

[최종 이미지](run-002/translated.png), [검출 상자](run-002/detection.png), [텍스트 mask](run-002/mask.png), [제거 결과](run-002/inpainted.png), [측정 JSON](run-002/result.json), [fixture 검증](run-002/evaluation.json).

- 검출: 이미지의 밝은 연결영역과 그 내부의 어두운 글자 성분을 계산. 입력 좌표나 정답 문자열을 pipeline에 하드코딩하지 않음.
- OCR: 로컬 MangaOCR 가중치로 두 영역에서 `こんにちは。`, `今日はいい天気。`를 실제 인식.
- 번역: 로컬 Marian/OPUS-MT로 `Hello.`, `It's a nice day.` 생성. 정답 번역문을 주입하지 않음.
- 제거: 검출한 글자 mask를 팽창하고 흰 내부에만 fill. AI/LaMa를 실행했다고 주장하지 않음.
- 식자: 단어 단위 줄바꿈, Pillow 실제 측정, 이진 탐색 font fit. 최소 크기에도 안 들어가면 명시적 오류.
- Windows Python3.10/CPU에서 최종 실행 종료코드0, 측정 구간7.02s 중 모델 로딩6.36s. 다운로드 시간은 제외. 1회 값이므로 p95나 GPU성능으로 일반화하지 않음.
- 첫 실행은 이미지·JSON 저장 후 Windows 콘솔 인코딩에서 실패했다. stdout을 ASCII JSON으로 바꾸고 `run-002`에서 성공했다. `run-001`은 이전 근거를 보존한다.
- 직접 회귀 검증6개 통과: 빈 이미지 abstain, mask 밖 불변, font fitting, overflow 거절, 잘못된 이미지 거절, 과대 바이트 거절.

## 실행

새로운 가상환경에서 `requirements.txt`를 설치한다. Windows 경로 예시이며 다른 OS에서는 사용 가능한 font 경로로 바꾼다. Arial/MS Gothic 폰트 파일은 재배포하지 않는다. 제품에는 배포 라이선스를 확인한 Noto 계열 등을 별도로 준비한다.

```powershell
python -m venv .venv
.\.venv\Scripts\python -m pip install -r requirements.txt
.\.venv\Scripts\python fetch_models.py --models ./models
.\.venv\Scripts\python pipeline.py ../japanese-synthetic.png --output ./my-run --models ./models --font C:/Windows/Fonts/arial.ttf
.\.venv\Scripts\python evaluate_fixture.py ./my-run
.\.venv\Scripts\python -m pytest test_pipeline.py -q
```

현재 작업환경의 모델은 workspace `work/models`에 내려받았다. weights는 결과 패키지에 포함하지 않는다. 공개 repo/정확한 revision은 `pipeline.py`에 고정되어 있다. downloader는 명시적으로 `token=False`이며 자격증명이나 사용자 파일을 전송하지 않는다. 추론은 `local_files_only=True`, `weights_only=True`, 원격 Python code 실행 없음. PyTorch2.6 이상을 유지해야 안전한 weights-only 로드를 지원한다.

## 검증하지 못한 것

SFX, 후리가나, 복잡한 배경, 텍스트 회전, 자유형 말풍선, 중국어·한국어 OCR, 장 단위 context, LLM 유료 API, API서버·queue·billing·extension·mobile은 이 실행에 포함되지 않는다. 일본어 OCR 모델은 없는 글자를 생성할 수 있어 빈 영역 차단과 편집 검수가 필요하다. 2개의 쉬운 문장 CER0은 일반 만화 정확도의 추정값이 아니다. 단순 검출기를 PaddleOCR 등으로 교체하기 전에 별도 데이터셋에서 비교해야 한다.

## 공개 의존성 근거

- [MangaOCR](https://github.com/kha-white/manga-ocr), [model card](https://huggingface.co/kha-white/manga-ocr-base): 일본어 가로/세로 OCR 후보, Apache-2.0 표기.
- [OPUS-MT ja-en](https://huggingface.co/Helsinki-NLP/opus-mt-ja-en): Japanese→English Marian, Apache-2.0 표기. 저비용 로컬 baseline이며 현대 LLM context 대안과 품질이 같다는 뜻이 아님.
- [Pillow ImageDraw](https://pillow.readthedocs.io/en/stable/reference/ImageDraw.html): 텍스트 길이와 bounding box 측정 API.

모델·코드 라이선스 표기와 학습 데이터의 권리 판단은 별개다. 상용 배포 전 모델/폰트/data provenance를 별도로 검토한다.
