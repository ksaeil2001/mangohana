#!/usr/bin/env bash
set -euo pipefail
umask 077

fail() {
  echo "$1" >&2
  exit 1
}

certificate_base64="${TRIO_MAC_CERTIFICATE_BASE64:-}"
certificate_password="${TRIO_MAC_CERTIFICATE_PASSWORD:-}"
expected_identity="${TRIO_MAC_DEVELOPER_IDENTITY:-}"
api_key_base64="${APPLE_API_KEY_P8_BASE64:-}"
api_key_id="${APPLE_API_KEY_ID:-}"
api_issuer="${APPLE_API_ISSUER:-}"
team_id="${TRIO_MAC_TEAM_ID:-}"
[[ -n "$certificate_base64" ]] || fail "TRIO_MAC_CERTIFICATE_BASE64 is required."
[[ -n "$certificate_password" ]] || fail "TRIO_MAC_CERTIFICATE_PASSWORD is required."
[[ -n "$api_key_base64" ]] || fail "APPLE_API_KEY_P8_BASE64 is required."
[[ "$api_key_id" =~ ^[A-Za-z0-9]{10}$ ]] || fail "APPLE_API_KEY_ID must be a 10-character key ID."
[[ "$api_issuer" =~ ^[[:xdigit:]]{8}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{4}-[[:xdigit:]]{12}$ ]] || \
  fail "APPLE_API_ISSUER must be a UUID."
[[ "$team_id" =~ ^[A-Z0-9]{10}$ ]] || fail "TRIO_MAC_TEAM_ID must be a 10-character team ID."
[[ "$expected_identity" == "Developer ID Application:"* ]] || \
  fail "TRIO_MAC_DEVELOPER_IDENTITY must be a Developer ID Application identity."
[[ "$expected_identity" == *"($team_id)" ]] || \
  fail "TRIO_MAC_DEVELOPER_IDENTITY does not match TRIO_MAC_TEAM_ID."

temp_parent="${TMPDIR:-/tmp}"
temp_dir="$(mktemp -d "${temp_parent%/}/trio-mac-signing.XXXXXX")"
keychain_path="$temp_dir/trio-signing.keychain-db"
certificate_path="$temp_dir/trio-developer-id.p12"
api_key_path="$temp_dir/trio-notarization-key.p8"
previous_keychains_path="$temp_dir/previous-keychains.txt"
cleanup_on_failure() {
  security delete-keychain "$keychain_path" >/dev/null 2>&1 || true
  rm -f -- "$api_key_path"
  rm -rf -- "$temp_dir"
}
trap cleanup_on_failure EXIT

# The certificate and password are read only from protected environment values.
# Neither value is echoed or put in a workflow argument list or artifact.
if ! security list-keychains -d user > "$previous_keychains_path" 2>/dev/null; then
  fail "Unable to record the existing macOS keychain search list."
fi
if base64 --decode </dev/null >/dev/null 2>&1; then
  decode_flag="--decode"
else
  decode_flag="-D"
fi
printf '%s' "$certificate_base64" | base64 "$decode_flag" > "$certificate_path" || \
  fail "TRIO_MAC_CERTIFICATE_BASE64 is not valid base64."
printf '%s' "$api_key_base64" | base64 "$decode_flag" > "$api_key_path" || \
  fail "APPLE_API_KEY_P8_BASE64 is not valid base64."
chmod 600 "$api_key_path"
grep -Fq -- "-----BEGIN PRIVATE KEY-----" "$api_key_path" || \
  fail "The Apple API key is not a PKCS#8 private-key file."
grep -Fq -- "-----END PRIVATE KEY-----" "$api_key_path" || \
  fail "The Apple API key is not a complete PKCS#8 private-key file."

security create-keychain -p "" "$keychain_path" >/dev/null
security set-keychain-settings -lut 900 "$keychain_path" >/dev/null
security unlock-keychain -p "" "$keychain_path" >/dev/null
security import "$certificate_path" -k "$keychain_path" \
  -P "$certificate_password" -T /usr/bin/codesign >/dev/null
security set-key-partition-list -S apple-tool:,apple: -s -k "" \
  "$keychain_path" >/dev/null
security list-keychains -d user -s "$keychain_path" >/dev/null

identity_output="$(security find-identity -v -p codesigning "$keychain_path" 2>/dev/null)" || \
  fail "Unable to inspect the temporary macOS signing keychain."
identity_count="$(grep -F 'Developer ID Application' <<<"$identity_output" | wc -l | tr -d '[:space:]')"
[[ "$identity_count" == "1" ]] || \
  fail "The temporary keychain must contain exactly one Developer ID Application identity."
grep -Fq "\"$expected_identity\"" <<<"$identity_output" || \
  fail "The expected Developer ID Application identity was not imported."

if [[ -n "${GITHUB_ENV:-}" ]]; then
  {
    printf 'TRIO_MAC_SIGNING_TEMP_DIR=%s\n' "$temp_dir"
    printf 'TRIO_MAC_KEYCHAIN_PATH=%s\n' "$keychain_path"
    printf 'TRIO_MAC_CERTIFICATE_PATH=%s\n' "$certificate_path"
    printf 'TRIO_MAC_API_KEY_PATH=%s\n' "$api_key_path"
    printf 'CSC_LINK=%s\n' "$certificate_path"
    printf 'CSC_KEYCHAIN=%s\n' "$keychain_path"
    printf 'APPLE_API_KEY=%s\n' "$api_key_path"
    printf 'APPLE_API_KEY_ID=%s\n' "$api_key_id"
    printf 'APPLE_API_ISSUER=%s\n' "$api_issuer"
    printf 'TRIO_MAC_TEAM_ID=%s\n' "$team_id"
    # The build step maps the protected password to CSC_KEY_PASSWORD without
    # persisting the secret in this environment file.
  } >> "$GITHUB_ENV"
fi

trap - EXIT
printf '%s\n' '{"configured":true,"developerIdIdentityMatched":true}'
