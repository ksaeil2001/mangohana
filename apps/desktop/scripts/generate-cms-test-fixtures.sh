#!/usr/bin/env bash
set -euo pipefail

# Regenerates public CMS test fixtures only. Private keys live in a temporary
# directory and are discarded when this script exits.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FIXTURE_DIR="$ROOT_DIR/tests/fixtures/pipeline-signing"
MANIFEST="$FIXTURE_DIR/pipeline-manifest.json"
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

create_certificate() {
  local name="$1"
  local bits="$2"
  local subject="$3"
  openssl req -x509 -newkey "rsa:${bits}" -nodes \
    -keyout "$WORK_DIR/${name}.key" \
    -out "$WORK_DIR/${name}.crt" \
    -sha256 -days 3650 -subj "$subject" >/dev/null 2>&1
}

sign_manifest() {
  local certificate="$1"
  local signature="$2"
  local digest="$3"
  openssl cms -sign -binary -in "$MANIFEST" \
    -signer "$WORK_DIR/${certificate}.crt" \
    -inkey "$WORK_DIR/${certificate}.key" \
    -outform DER -out "$FIXTURE_DIR/${signature}" \
    -md "$digest" >/dev/null 2>&1
}

create_certificate "current" 3072 "/CN=Test Pipeline Publisher/O=Fixture Only"
create_certificate "untrusted" 3072 "/CN=Untrusted Pipeline Publisher/O=Fixture Only"
create_certificate "same-subject" 3072 "/CN=Test Pipeline Publisher/O=Fixture Only"
create_certificate "rsa2048" 2048 "/CN=RSA-2048 Pipeline Publisher/O=Fixture Only"

openssl x509 -in "$WORK_DIR/current.crt" -outform DER -out "$FIXTURE_DIR/test-publisher.cer"
openssl x509 -in "$WORK_DIR/rsa2048.crt" -outform DER -out "$FIXTURE_DIR/rsa2048-publisher.cer"

sign_manifest "current" "valid-signature.p7s" sha256
sign_manifest "untrusted" "untrusted-signature.p7s" sha256
sign_manifest "same-subject" "same-subject-signature.p7s" sha256
sign_manifest "current" "sha1-signature.p7s" sha1
sign_manifest "rsa2048" "rsa2048-signature.p7s" sha256

echo "Regenerated public CMS fixtures in $FIXTURE_DIR"
