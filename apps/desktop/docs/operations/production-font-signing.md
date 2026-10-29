# Production Pretendard 오프라인 서명

Production font는 승인된 publisher의 detached CMS와 manifest/payload hash가 모두
검증되어야 Main이 승인한다. 인증서가 없으면 typeset은 BLOCKED이며 original/cleaned
export의 기존 조건은 유지한다. 테스트의 메모리 내 인증서는 Production 입력이 아니다.

## 입력과 승인 경계

- 고정 입력: `resources/font_ko_fallback/pretendard-1.3.9/`의
  `PretendardVariable.ttf`, `LICENSE.txt`, `resource-manifest.json`.
- manifest SHA-256: `27efedd0315cc2e77e54d2f3c86b1dd321a570c33e9dabcac1682354fd2e1628`.
- font SHA-256: `3090ccde0442bb347aa7685d9ba8b17436a60682df6e8f92a9a670de14056e22`.
- license SHA-256: `b04538c9abec39a3db75108cf0af0fd9c77032fe8aa2cf38345b4d250e98e38e`.
- 실제 publisher가 승인한 유효 기간 내 RSA-3072 / SHA-256 인증서와 대응하는
  오프라인 개인키. 인증서 자체 서명도 SHA-256/RSA이어야 한다.
- CA 발급 인증서라면 signer의 서명을 검증할 issuer 공개 인증서도 CMS에 포함한다.
  Main은 embedded issuer 서명과 **signer DER 전체의 SHA-256 pin**을 모두 확인한다.
  Subject/CN 일치만으로 승인하지 않는다. Windows Authenticode와는 별도 Gate다.

개인키, PFX, 암호와 복구 자료는 repository 및 CI artifact 밖에 보관한다.
아래 `E:\OfflineSigning`은 운영자가 지정할 예시 경로이며 이 작업에서 생성하지 않는다.
기존 `scripts/generate-cms-test-fixtures.sh`는 공개 테스트 fixture 재생성 전용이다.
그 스크립트를 Production 인증서 생성에 사용하지 않는다.

## PowerShell에서 exact bytes 서명

기존 fixture generator와 같은 OpenSSL detached CMS 명령을 사용한다. 별도의
Production key 생성 스크립트는 만들지 않는다. manifest를 다시 저장하거나
줄바꿈/BOM을 변환하면 서명이 달라진다. 먼저 다음 hash를 위의 고정 값과 비교한다.

```powershell
$fontPack = Join-Path $PWD 'resources/font_ko_fallback/pretendard-1.3.9'
$fontManifest = Join-Path $fontPack 'resource-manifest.json'
$fontCert = 'E:\OfflineSigning\approved-font-publisher.pem'
$fontKey = 'E:\OfflineSigning\approved-font-publisher-encrypted.key'
$fontPublicOutput = 'E:\OfflineSigning\public-output'
Get-FileHash -Algorithm SHA256 -LiteralPath $fontManifest
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fontPack 'PretendardVariable.ttf')
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fontPack 'LICENSE.txt')
```

일치할 때만 서명한다. 암호는 OpenSSL의 대화형 입력에만 입력하며 명령행·환경변수·
로그에 넣지 않는다. 공개 출력의 기존 파일도 덮어쓰지 않는다.

```powershell
if (Test-Path -LiteralPath $fontPublicOutput) { throw '새 public-output 경로를 지정하세요.' }
New-Item -ItemType Directory -Path $fontPublicOutput | Out-Null
openssl cms -sign -binary -in $fontManifest -signer $fontCert -inkey $fontKey -md sha256 -outform DER -out (Join-Path $fontPublicOutput 'resource-manifest.p7s')
if ($LASTEXITCODE -ne 0) { throw 'CMS signing failed' }
openssl x509 -in $fontCert -outform DER -out (Join-Path $fontPublicOutput 'font-publisher.cer')
if ($LASTEXITCODE -ne 0) { throw 'Certificate conversion failed' }
$fontPin = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fontPublicOutput 'font-publisher.cer')).Hash
$fontAllowlist = @{ current = $fontPin } | ConvertTo-Json -Compress
[System.IO.File]::WriteAllText((Join-Path $fontPublicOutput 'font-publisher-allowlist.json'), $fontAllowlist, [System.Text.UTF8Encoding]::new($false))
Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $fontPublicOutput 'resource-manifest.p7s')
```

CA 발급 signer는 `openssl cms -sign`에
`-certfile 'E:\OfflineSigning\issuer-chain-public.pem'`을 추가한다.
`-nodetach`, `-nocerts`, 검증 우회 플래그는 사용하지 않는다.
승인된 공개 인증서 지문과 `$fontPin`을 별도 경로로 대조한 뒤 반입한다.
`next` pin은 승인된 키 교체 기간에만 사용하며 `current`와 중복되지 않아야 한다.

## 반입 및 Main 검증

반입 허용 자료는 다음 공개 파일과 비밀값 없는 출처/승인 기록이다.

- `resources/pipeline-resources/font-publisher-allowlist.json`
- `resources/font_ko_fallback/pretendard-1.3.9/resource-manifest.p7s`
- 필요 시 공개 인증서

개인키·PFX·암호·API key·오프라인 저장소 전체는 반입하지 않는다. manifest가
동일하면 lock hash는 변경하지 않는다. 변경되면 승인·재서명·lock 검토를 다시 한다.
Production OCR allowlist와 immutable OCR release는 이 절차의 수정 대상이 아니다.

```powershell
npm.cmd test -- tests/main/productionTypesetFontResource.test.ts tests/main/cmsSignatureVerifier.test.ts tests/main/projectImageExport.test.ts
npm.cmd run pack:win
node scripts/verify-packaged-pretendard.mjs --resources-dir release/win-unpacked/resources --output pretendard-verification.json
```

결과 파일은 새 경로여야 한다. 성공 시 `cmsValid`, `hashValid`, `publisherAllowed`,
`identityMatched`, `glyphCoverageValid`가 모두 `true`다. 이것은 Main 및 glyph 검증이며
실제 번역·인페인팅·저장/재열기·최종 export를 포함하는 Golden E2E와는 구분한다.

정상 서명, 잘못된 publisher, 변경/재직렬화 manifest, 변경 font, 누락/비정상 CMS,
directory junction, preflight 후 font 교체를 테스트한다. 실패하면 Main은 font URL에
404를 반환하고 trusted evidence를 만들지 않는다.

참고: [OpenSSL CMS 공식 명령 설명](https://docs.openssl.org/3.0/man1/openssl-cms/).
