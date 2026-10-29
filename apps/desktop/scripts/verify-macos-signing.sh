#!/usr/bin/env bash
set -euo pipefail

APP_PATH="${1:-${TRIO_MAC_APP_PATH:-}}"
DMG_PATH="${2:-${TRIO_MAC_DMG_PATH:-}}"
ZIP_PATH="${3:-${TRIO_MAC_ZIP_PATH:-}}"
OUTPUT_PATH="${4:-${TRIO_MAC_SIGNING_OUTPUT:-}}"
EXPECTED_IDENTITY="${TRIO_MAC_DEVELOPER_IDENTITY:-}"

fail() {
  echo "$1" >&2
  exit 1
}

[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || fail "The signed macOS app bundle is missing."
[[ -n "$DMG_PATH" && -f "$DMG_PATH" ]] || fail "The signed macOS DMG is missing."
[[ -n "$ZIP_PATH" && -f "$ZIP_PATH" ]] || fail "The signed macOS ZIP is missing."
[[ -n "$OUTPUT_PATH" ]] || fail "A sanitized macOS verification output path is required."
[[ -n "$EXPECTED_IDENTITY" ]] || fail "TRIO_MAC_DEVELOPER_IDENTITY is required."

verify_app_bundle() {
  local candidate_path="$1"
  local candidate_label="$2"
  local codesign_display_output
  local spctl_output

  if ! codesign_verify_output="$(codesign --deep --strict --verbose=2 --verify "$candidate_path" 2>&1)"; then
    fail "$candidate_label codesign verification failed."
  fi
  if ! codesign_display_output="$(codesign --display --verbose=4 "$candidate_path" 2>&1)"; then
    fail "$candidate_label codesign identity inspection failed."
  fi
  grep -Fq "Developer ID Application" <<<"$codesign_display_output" || fail "$candidate_label is not signed with Developer ID Application."
  grep -Fq "$EXPECTED_IDENTITY" <<<"$codesign_display_output" || fail "$candidate_label signing identity does not match."
  grep -Eiq "flags=.*(runtime|0x10000)" <<<"$codesign_display_output" || fail "$candidate_label hardened runtime flag is missing."

  if ! spctl_output="$(spctl --assess --type execute --verbose=4 "$candidate_path" 2>&1)"; then
    fail "Gatekeeper rejected the $candidate_label."
  fi
  grep -Eiq "accepted|source=Notarized Developer ID" <<<"$spctl_output" || fail "Gatekeeper did not accept the $candidate_label."
}

verify_app_bundle "$APP_PATH" "signed macOS app"

# ZIP archives are untrusted input. Validate every member before extraction,
# extract only into a fresh private directory, and reject symlinks so no entry
# can escape the directory or cause the source artifact to be modified.
if ! zip_listing="$(unzip -Z1 -- "$ZIP_PATH" 2>&1)"; then
  fail "Unable to inspect the signed macOS ZIP archive."
fi
while IFS= read -r zip_entry; do
  [[ -n "$zip_entry" ]] || continue
  [[ "$zip_entry" != /* ]] || fail "ZIP archive contains an unsafe path: $zip_entry"
  IFS='/' read -r -a zip_components <<< "$zip_entry"
  for zip_component in "${zip_components[@]}"; do
    [[ "$zip_component" != ".." && "$zip_component" != "." ]] || fail "ZIP archive contains an unsafe path: $zip_entry"
  done
done <<<"$zip_listing"

if ! zip_type_listing="$(unzip -Z -l -- "$ZIP_PATH" 2>&1)"; then
  fail "Unable to inspect ZIP archive member types."
fi
while IFS= read -r zip_info_line; do
  zip_member_type="${zip_info_line:0:1}"
  case "$zip_member_type" in
    l)
      fail "ZIP archive contains a symbolic link member."
      ;;
    b|c|p|s|h)
      fail "ZIP archive contains an unsafe special member."
      ;;
  esac
done <<<"$zip_type_listing"

zip_extract_dir="$(mktemp -d "${TMPDIR:-/tmp}/trio-macos-zip.XXXXXXXX")" || fail "Unable to create a private ZIP extraction directory."
cleanup_zip_extract() {
  rm -rf -- "$zip_extract_dir"
}
trap cleanup_zip_extract EXIT

if ! unzip -qq -- "$ZIP_PATH" -d "$zip_extract_dir"; then
  fail "Unable to extract the signed macOS ZIP archive."
fi
if find "$zip_extract_dir" -type l -print -quit | grep -q .; then
  fail "ZIP archive contains a symbolic link."
fi

zip_app_count=0
zip_app_path=""
while IFS= read -r -d '' candidate; do
  zip_app_count=$((zip_app_count + 1))
  zip_app_path="$candidate"
done < <(find "$zip_extract_dir" -type d -name 'Trio.app' -print0)
[[ "$zip_app_count" -eq 1 && -n "$zip_app_path" ]] || fail "ZIP archive must contain exactly one app bundle."

verify_app_bundle "$zip_app_path" "ZIP app"

if ! stapler_app_output="$(xcrun stapler validate "$APP_PATH" 2>&1)"; then
  fail "The app notarization ticket is not stapled."
fi
if ! stapler_zip_output="$(xcrun stapler validate "$zip_app_path" 2>&1)"; then
  fail "The ZIP app notarization ticket is not stapled."
fi
if ! stapler_dmg_output="$(xcrun stapler validate "$DMG_PATH" 2>&1)"; then
  fail "The DMG notarization ticket is not stapled."
fi
grep -Eiq "validate|staple|ticket" <<<"$stapler_app_output$stapler_zip_output$stapler_dmg_output" || fail "The notarization ticket validation output was invalid."

output_directory="$(dirname "$OUTPUT_PATH")"
mkdir -p "$output_directory"
printf '%s\n' '{"developerIdIdentityMatched":true,"hardenedRuntime":true,"codesignValid":true,"spctlAccepted":true,"notarizationAccepted":true,"staplerValidated":true}' > "$OUTPUT_PATH"
