#!/usr/bin/env bash
set -euo pipefail

temp_dir="${TRIO_MAC_SIGNING_TEMP_DIR:-}"
keychain_path="${TRIO_MAC_KEYCHAIN_PATH:-}"
api_key_path="${TRIO_MAC_API_KEY_PATH:-}"
[[ -z "$temp_dir" && -z "$keychain_path" ]] && exit 0
[[ -n "$temp_dir" && -n "$keychain_path" ]] || exit 1
[[ -n "$api_key_path" ]] || api_key_path="$temp_dir/trio-notarization-key.p8"

temp_parent="${TMPDIR:-/tmp}"
case "$temp_dir" in
  "${temp_parent%/}"/trio-mac-signing.*) ;;
  *) echo "Refusing to remove an unexpected macOS signing temp path." >&2; exit 1 ;;
esac
case "$keychain_path" in
  "$temp_dir"/trio-signing.keychain-db) ;;
  *) echo "Refusing to remove an unexpected macOS signing keychain." >&2; exit 1 ;;
esac
case "$api_key_path" in
  "$temp_dir"/trio-notarization-key.p8) ;;
  *) echo "Refusing to remove an unexpected Apple API key path." >&2; exit 1 ;;
esac

previous_keychains_path="$temp_dir/previous-keychains.txt"
cleanup_failed=0
if [[ -f "$previous_keychains_path" ]]; then
  previous_keychains=()
  while IFS= read -r line; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    line="${line#\"}"
    line="${line%\"}"
    [[ -n "$line" ]] && previous_keychains+=("$line")
  done < "$previous_keychains_path"
  if (( ${#previous_keychains[@]} > 0 )); then
    if ! security list-keychains -d user -s "${previous_keychains[@]}" >/dev/null 2>&1; then
      cleanup_failed=1
    fi
  fi
fi
if ! security delete-keychain "$keychain_path" >/dev/null 2>&1; then
  cleanup_failed=1
fi
if [[ -e "$api_key_path" ]] && ! rm -f -- "$api_key_path"; then
  cleanup_failed=1
fi
if [[ -d "$temp_dir" ]] && ! rm -rf -- "$temp_dir"; then
  cleanup_failed=1
fi
exit "$cleanup_failed"
