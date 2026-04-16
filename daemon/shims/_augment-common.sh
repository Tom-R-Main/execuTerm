#!/usr/bin/env bash
# cmux augment common helpers. Sourced by shims. Must be robust: never
# change the real command's exit status or stdout/stderr ordering except
# to append a trailing semantic-match section on stdout on success.

# Find the *real* binary of $1 by walking PATH and skipping our shim dir.
_cmux_augment_real_path() {
  local name="$1"
  local shim_dir="${CMUX_AUGMENT_BIN:-}"
  local IFS=:
  local dir
  for dir in $PATH; do
    [ -z "$dir" ] && continue
    # Skip our own shim dir (resolve both absolute and symlink-ish)
    if [ -n "$shim_dir" ]; then
      case "$dir" in
        "$shim_dir"|"$shim_dir/") continue ;;
      esac
    fi
    local candidate="$dir/$name"
    if [ -x "$candidate" ] && [ ! -d "$candidate" ]; then
      # Ensure we're not about to re-exec ourselves
      local resolved
      resolved="$(cd "$(dirname "$candidate")" 2>/dev/null && pwd -P)/$(basename "$candidate")"
      if [ "$resolved" != "${BASH_SOURCE[1]:-}" ]; then
        printf '%s\n' "$candidate"
        return 0
      fi
    fi
  done
  return 1
}

# Extract the first non-flag positional arg as the query. Very conservative:
# we only look at the short scan of argv. Anything ambiguous → empty query,
# which disables augmentation.
_cmux_augment_extract_query() {
  local saw_dashdash=0
  local arg
  for arg in "$@"; do
    if [ "$saw_dashdash" = "1" ]; then
      printf '%s' "$arg"
      return 0
    fi
    case "$arg" in
      --) saw_dashdash=1 ;;
      -e|--regexp|--regex)
        # Next arg is the pattern — skip handling, let user's explicit -e win
        # by returning empty (we don't try to decipher multi-pattern).
        return 0
        ;;
      -*) ;;
      *)
        printf '%s' "$arg"
        return 0
        ;;
    esac
  done
  return 0
}

# Decide whether to augment at all. Returns 0 if yes, 1 if no.
_cmux_augment_should_run() {
  local query="$1"
  [ "${CMUX_AUGMENT:-0}" = "1" ] || return 1
  [ -n "${CMUX_AUGMENT_EXF_BIN:-}" ] || return 1
  local min="${CMUX_AUGMENT_MIN_QUERY_LEN:-3}"
  [ "${#query}" -ge "$min" ] || return 1
  # Reject queries that start with a regex metachar (heuristic: likely a
  # pattern the user wants matched literally, not a concept for semantic).
  case "$query" in
    '') return 1 ;;
    [\.\*\+\?\^\$\\\[\]\{\}\(\)\|]*) return 1 ;;
  esac
  return 0
}

# Fire-and-forget log to the daemon. Never block on this.
_cmux_augment_log() {
  [ -n "${CMUX_AUGMENT_LOG_URL:-}" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  local body="$1"
  (
    curl -sS -m 1 -X POST \
      -H 'Content-Type: application/json' \
      --data "$body" \
      "$CMUX_AUGMENT_LOG_URL" >/dev/null 2>&1 || true
  ) &
  disown 2>/dev/null || true
}

# Portable millisecond clock. macOS /bin/date doesn't support %N, so we fall
# back through gdate → perl → seconds*1000. Always prints an integer.
_cmux_augment_now_ms() {
  if command -v gdate >/dev/null 2>&1; then
    gdate +%s%3N
    return 0
  fi
  if command -v perl >/dev/null 2>&1; then
    perl -MTime::HiRes=time -e 'printf "%d\n", int(time()*1000)'
    return 0
  fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time()*1000))'
    return 0
  fi
  echo "$(( $(date +%s) * 1000 ))"
}

# JSON-escape a string for embedding as a JSON value (no surrounding quotes).
_cmux_augment_json_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\r'/\\r}"
  s="${s//$'\t'/\\t}"
  printf '%s' "$s"
}
