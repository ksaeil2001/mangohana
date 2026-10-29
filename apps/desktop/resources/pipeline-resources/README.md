# Trio packaged pipeline resources

Production Pretendard signing inputs, exact commands and public-material handoff:
[offline signing runbook](../../docs/operations/production-font-signing.md).

The packaged `pipeline-resources` directory is Main-owned. The production
Pretendard resource is trusted only after all of the following are supplied
and verified offline:

- `font-publisher-allowlist.json` containing the real, release-approved CMS
  publisher certificate thumbprint (`current`, and optionally `next`).
- `resource-manifest.p7s` beside the bundled font pack's
  `resource-manifest.json`, produced by the approved offline signing key.

The detached signature must cover the exact manifest bytes. The signing key
must remain offline and must never be copied into this repository, an app
artifact, CI logs, a PFX/password bundle, or a test fixture. Do not replace
these public files with placeholders or test certificates.

The production font allowlist and detached CMS signature are committed public
trust material. Their signer pin is
`CA17FDAB1BA0435732689799B64C9586EE28219AE5546B952371A97FDB84FF2B`.
Regression tests verify these exact bytes without any private signing material.
Main still fails closed for missing, invalid or unpinned resources. Production
font CMS verification is separate from Windows executable Authenticode.

## Production OCR resource staging

`ocr-publisher-allowlist.json` is the real Production OCR publisher pin. It
contains the SHA-256 digest of the DER certificate that signs the external
`trio-production-ocr-win32-x64` resource pack; it is not a test certificate
or a placeholder.

The signed OCR archive itself is deliberately not checked into this directory.
It is a separately distributable Windows x64 artifact containing the fixed
PP-OCRv6 detector, Baberu ONNX recognizer, embedded Python runtime, and
third-party notices. Its source lock and signed manifest bind every payload
file and license file before installation.

`pipeline-resource-lock.json` binds `ocr_production` to the immutable
`ocr-production-v1.0.0` GitHub Release using versioned HTTPS locations for the
archive, manifest, and detached signature. The Production service still
fails closed unless those exact downloads pass the manifest hash, CMS
publisher allowlist, hardened extraction, and per-file integrity checks.
