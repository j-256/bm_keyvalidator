#!/bin/bash
# Tests for scripts/deploy.sh -- specifically the host-input resolution
# (sandbox tenant-id parsing, hostname classification) and per-host-kind
# validation rules. The script's network behavior (curl uploads) is not
# exercised; tests stop just before the zip-build step.
#
# Run:    bash test/scripts/deploy.test.sh
# or:     npm test
#
# Compatible with bash 3.2 (the macOS system bash).

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DEPLOY_SCRIPT="$REPO_ROOT/scripts/deploy.sh"

# Build a harness that runs deploy.sh through the validation block but
# stops before any rsync/zip/curl. Sed prints up to the build-zip
# section, then we append our own state dump + exit.
HARNESS="$(mktemp -t kv-deploy-harness.XXXXXX)"
trap 'rm -f "$HARNESS"' EXIT
sed -n '/^set -euo pipefail/,/^# --- build the zip ---$/p' "$DEPLOY_SCRIPT" > "$HARNESS"
cat >> "$HARNESS" <<'EOF'
echo "TARGET_HOST=$TARGET_HOST"
echo "HOST_KIND=$HOST_KIND"
echo "P12_FILE=$P12_FILE"
exit 0
EOF

# --- minimal test framework ---
PASS=0
FAIL=0
FAIL_DETAILS=()

# Run the harness and capture stdout+stderr, exit code. Always supplies
# -V version1 and -u u:p so we don't fall through to interactive prompts.
run_harness() {
    bash "$HARNESS" "$@" -V version1 -u u:p 2>&1
    return $?
}

assert_resolves() {
    local label="$1"
    local input="$2"
    local expected_host="$3"
    local expected_kind="$4"
    local extra_args="${5:-}"
    local output
    local rc
    output="$(run_harness -H "$input" $extra_args)"
    rc=$?
    if [ "$rc" -ne 0 ]; then
        FAIL=$((FAIL + 1))
        FAIL_DETAILS+=("$label: expected success but exit=$rc"$'\n'"  output: $output")
        return
    fi
    local got_host
    local got_kind
    got_host="$(printf '%s\n' "$output" | grep '^TARGET_HOST=' | head -1 | cut -d= -f2-)"
    got_kind="$(printf '%s\n' "$output" | grep '^HOST_KIND=' | head -1 | cut -d= -f2-)"
    if [ "$got_host" != "$expected_host" ] || [ "$got_kind" != "$expected_kind" ]; then
        FAIL=$((FAIL + 1))
        FAIL_DETAILS+=("$label: input=$input"$'\n'"  expected host=$expected_host kind=$expected_kind"$'\n'"  got      host=$got_host kind=$got_kind")
        return
    fi
    PASS=$((PASS + 1))
}

assert_rejects() {
    local label="$1"
    local input="$2"
    local expected_exit="$3"
    local expected_msg_substr="$4"
    local output
    local rc
    output="$(run_harness -H "$input" 2>&1)"
    rc=$?
    if [ "$rc" -eq 0 ]; then
        FAIL=$((FAIL + 1))
        FAIL_DETAILS+=("$label: expected failure but succeeded"$'\n'"  output: $output")
        return
    fi
    if [ -n "$expected_exit" ] && [ "$rc" -ne "$expected_exit" ]; then
        FAIL=$((FAIL + 1))
        FAIL_DETAILS+=("$label: expected exit=$expected_exit got=$rc"$'\n'"  output: $output")
        return
    fi
    if [ -n "$expected_msg_substr" ] && [ "${output#*"$expected_msg_substr"}" = "$output" ]; then
        FAIL=$((FAIL + 1))
        FAIL_DETAILS+=("$label: output didn't contain '$expected_msg_substr'"$'\n'"  output: $output")
        return
    fi
    PASS=$((PASS + 1))
}

# --- sandbox tenant ids ---
assert_resolves 'sandbox: underscore separator' \
    'zzzz_001' 'zzzz-001.dx.commercecloud.salesforce.com' 'sbx'
assert_resolves 'sandbox: hyphen separator' \
    'zzzz-001' 'zzzz-001.dx.commercecloud.salesforce.com' 'sbx'
assert_resolves 'sandbox: full hostname passthrough' \
    'zzzz-001.dx.commercecloud.salesforce.com' \
    'zzzz-001.dx.commercecloud.salesforce.com' 'sbx'

# --- staging full hostnames ---
# Use deploy.sh as a stand-in "real file" so the p12 existence check passes.
assert_resolves 'stg: cert.staging full hostname passthrough' \
    'cert.staging.na01.mybrand.demandware.net' \
    'cert.staging.na01.mybrand.demandware.net' 'stg' \
    '-p '"$DEPLOY_SCRIPT"' -P pass'

# --- non-canonical staging shapes that auto-rewrite to cert.staging.* ---
# All three reach the same instance but reject WebDAV; deploy.sh coerces
# them to the canonical form and emits a stderr note about the swap.

# Bare hyphen form (what the BM address bar shows).
assert_resolves 'stg: staging-* hyphen-bare auto-rewrites to cert.staging.*' \
    'staging-na01-mybrand.demandware.net' \
    'cert.staging.na01.mybrand.demandware.net' 'stg' \
    '-p '"$DEPLOY_SCRIPT"' -P pass'

stg_hyphen_output="$(run_harness -H staging-na01-mybrand.demandware.net -p "$DEPLOY_SCRIPT" -P pass 2>&1)"
if [ "${stg_hyphen_output#*'staging-na01-mybrand.demandware.net is not WebDAV-uploadable'}" != "$stg_hyphen_output" ]; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
    FAIL_DETAILS+=("stg: expected hyphen-bare rewrite note missing from stderr"$'\n'"  output: $stg_hyphen_output")
fi

# Bare dotted form (canonical missing only the `cert.` prefix).
assert_resolves 'stg: staging.* dotted-bare auto-rewrites to cert.staging.*' \
    'staging.na01.mybrand.demandware.net' \
    'cert.staging.na01.mybrand.demandware.net' 'stg' \
    '-p '"$DEPLOY_SCRIPT"' -P pass'

stg_dotted_output="$(run_harness -H staging.na01.mybrand.demandware.net -p "$DEPLOY_SCRIPT" -P pass 2>&1)"
if [ "${stg_dotted_output#*'staging.na01.mybrand.demandware.net is not WebDAV-uploadable'}" != "$stg_dotted_output" ]; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
    FAIL_DETAILS+=("stg: expected dotted-bare rewrite note missing from stderr"$'\n'"  output: $stg_dotted_output")
fi

# Address-bar form with `cert.` slapped on (a natural copy/paste mistake).
assert_resolves 'stg: cert.staging-* address-bar shape auto-rewrites to cert.staging.*' \
    'cert.staging-na01-mybrand.demandware.net' \
    'cert.staging.na01.mybrand.demandware.net' 'stg' \
    '-p '"$DEPLOY_SCRIPT"' -P pass'

stg_certhyphen_output="$(run_harness -H cert.staging-na01-mybrand.demandware.net -p "$DEPLOY_SCRIPT" -P pass 2>&1)"
if [ "${stg_certhyphen_output#*'cert.staging-na01-mybrand.demandware.net is not WebDAV-uploadable'}" != "$stg_certhyphen_output" ]; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
    FAIL_DETAILS+=("stg: expected cert.staging-* rewrite note missing from stderr"$'\n'"  output: $stg_certhyphen_output")
fi

# --- staging without p12 should reject ---
assert_rejects 'stg without --p12 is rejected' \
    'cert.staging.na01.mybrand.demandware.net' 1 'requires mTLS authentication'

# --- dev full hostname (no mTLS required, but warns) ---
assert_resolves 'dev: full hostname passthrough' \
    'development-na01-mybrand.demandware.net' \
    'development-na01-mybrand.demandware.net' 'dev'

dev_output="$(run_harness -H development-na01-mybrand.demandware.net 2>&1)"
if [ "${dev_output#*WARN: uploading directly to a development instance}" != "$dev_output" ]; then
    PASS=$((PASS + 1))
else
    FAIL=$((FAIL + 1))
    FAIL_DETAILS+=("dev: expected WARN: substring missing from output"$'\n'"  output: $dev_output")
fi

# --- production: refused outright ---
assert_rejects 'prd: full hostname refused' \
    'production-na01-mybrand.demandware.net' 1 \
    'refusing to upload directly to a production instance'
assert_rejects 'prd: explanation mentions Code Replication' \
    'production-na01-mybrand.demandware.net' 1 'Code Replication'

# --- bogus inputs ---
assert_rejects 'bogus: random string' \
    'totally garbage~!' 2 "isn't a recognisable hostname or sandbox tenant id"
# Tenant-id shortcuts only cover sandbox (xxxx_NNN); the analogous
# xxxx_stg form is rejected because PIG hostnames embed a realm name
# rather than a 4-letter realm id, so deriving them from a shortcut
# isn't well-defined.
assert_rejects 'bogus: realm-id _stg shortcut not recognised as a tenant id' \
    'abcd_stg' 2 "isn't a recognisable hostname or sandbox tenant id"
assert_rejects 'bogus: missing instance suffix' \
    'abcd' 2 "isn't a recognisable hostname or sandbox tenant id"

# --- unknown full hostname proceeds with kind=unknown ---
assert_resolves 'unknown: arbitrary full hostname is allowed' \
    'some.host.example.com' 'some.host.example.com' 'unknown'

# --- summary ---
echo
echo "tests: $((PASS + FAIL)), passed: $PASS, failed: $FAIL"
if [ "$FAIL" -gt 0 ]; then
    echo
    echo '--- failures ---'
    for detail in "${FAIL_DETAILS[@]}"; do
        echo "$detail"
        echo
    done
    exit 1
fi
exit 0
