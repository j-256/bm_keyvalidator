#!/bin/bash
# Zip the cartridge, upload it to a SFCC instance via WebDAV, and unzip
# it server-side. The result is the cartridge live at:
#
#     /on/demandware.servlet/webdav/Sites/Cartridges/<code-version>/bm_keyvalidator/cartridge/...
#
# Activation of the code version (Administration > Site Development >
# Code Deployment) is intentionally left to the operator.
#
# Sandbox vs PIG (stg / dev / prd):
#   - Sandbox accepts plain Basic auth over HTTPS.
#   - Staging is the ONLY tier that requires mTLS, and only via the
#     cert.staging.<realm>.demandware.net hostname. Pass --p12.
#   - Dev accepts plain auth, but uploads trigger a warning: some code
#     caches are only refreshed by Code Replication from staging, so
#     direct dev uploads can produce inconsistent runtime behavior.
#     Prefer staging + replicate.
#   - Production cannot be uploaded to directly: the script refuses.
#     Deploy to staging and use BM Code Replication.
#
# Host input:
#   The -H/--host argument accepts either:
#     - A full hostname:
#         zzzz-001.dx.commercecloud.salesforce.com  (sandbox)
#         cert.staging.na01.mybrand.demandware.net  (staging, mTLS)
#         development-na01-mybrand.demandware.net   (dev)
#         production-na01-mybrand.demandware.net    (prd, refused)
#     - A sandbox tenant id (xxxx_NNN or xxxx-NNN); the script derives
#       the hostname:
#         zzzz_001  ->  zzzz-001.dx.commercecloud.salesforce.com
#         zzzz-001  ->  zzzz-001.dx.commercecloud.salesforce.com
#       Both `_` and `-` are accepted as separators.
#   PIG instances must be passed as a full hostname; tenant-id shortcuts
#   for stg/dev/prd are not supported because the realm naming convention
#   doesn't lend itself to a clean abbreviation.
#
# Usage:
#     scripts/deploy.sh [-H host-or-sandbox-id] [-V code-version] [auth] [mtls]
#     scripts/deploy.sh <host-or-sandbox-id> <code-version> [auth] [mtls]
#
# Flags:
#     -H, --host          target instance: hostname OR sandbox tenant id
#     -V, --code-version  target code version (e.g. version1)
#     -u, --user          WebDAV credentials as user:pass (Basic auth)
#     -t, --token         OAuth bearer token (alternative to -u)
#     -p, --p12           path to .p12 client certificate (engages mTLS)
#     -P, --p12-pass      passphrase for the .p12 file
#     -h, --help          show this usage and exit
#
# Examples:
#     # sandbox via tenant id, prompt for creds
#     scripts/deploy.sh -H zzzz_001 -V version1
#
#     # staging, Basic + mTLS
#     scripts/deploy.sh -H cert.staging.na01.mybrand.demandware.net -V version1 \
#         -u me@example.com:secret -p ~/staging.p12 -P p12pass
#
#     # staging via Bearer + mTLS, env-driven
#     SFCC_WEBDAV_TOKEN="$ACCESS_TOKEN" \
#     SFCC_WEBDAV_P12=~/staging.p12 SFCC_WEBDAV_P12_PASSWORD=p12pass \
#         scripts/deploy.sh -H cert.staging.na01.mybrand.demandware.net -V version1
#
# Auth source order (flag overrides env, both override prompt):
#     user:pass  -- -u/--user > SFCC_WEBDAV_USER+SFCC_WEBDAV_PASSWORD > prompt
#     token      -- -t/--token > SFCC_WEBDAV_TOKEN
#     p12 file   -- -p/--p12 > SFCC_WEBDAV_P12 > "$USER-$HOSTNAME.p12" in CWD
#     p12 pass   -- -P/--p12-pass > SFCC_WEBDAV_P12_PASSWORD > prompt
#
#     -u and -t are mutually exclusive. If neither is given and only env
#     is available, SFCC_WEBDAV_TOKEN wins over SFCC_WEBDAV_USER+PASSWORD.

set -euo pipefail

usage() {
    sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//' >&2
    exit 2
}

# --- arg parsing ---
HOST_INPUT=''
CODE_VERSION=''
USER_PASS=''
TOKEN=''
P12_FILE=''
P12_PASS=''

while [ $# -gt 0 ]; do
    case "$1" in
        -H|--host)
            [ $# -ge 2 ] || { echo "deploy: $1 requires a value" >&2; exit 2; }
            HOST_INPUT="$2"
            shift 2
            ;;
        -V|--code-version)
            [ $# -ge 2 ] || { echo "deploy: $1 requires a value" >&2; exit 2; }
            CODE_VERSION="$2"
            shift 2
            ;;
        -u|--user)
            [ $# -ge 2 ] || { echo "deploy: $1 requires user:pass" >&2; exit 2; }
            USER_PASS="$2"
            shift 2
            ;;
        -t|--token)
            [ $# -ge 2 ] || { echo "deploy: $1 requires a token value" >&2; exit 2; }
            TOKEN="$2"
            shift 2
            ;;
        -p|--p12)
            [ $# -ge 2 ] || { echo "deploy: $1 requires a path" >&2; exit 2; }
            P12_FILE="$2"
            shift 2
            ;;
        -P|--p12-pass)
            [ $# -ge 2 ] || { echo "deploy: $1 requires a passphrase" >&2; exit 2; }
            P12_PASS="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        --)
            shift
            break
            ;;
        -*)
            echo "deploy: unknown flag: $1" >&2
            exit 2
            ;;
        *)
            if [ -z "$HOST_INPUT" ]; then
                HOST_INPUT="$1"
            elif [ -z "$CODE_VERSION" ]; then
                CODE_VERSION="$1"
            else
                echo "deploy: unexpected argument: $1" >&2
                exit 2
            fi
            shift
            ;;
    esac
done

[ -n "$HOST_INPUT" ] || { echo "deploy: hostname or tenant id required" >&2; usage; }
[ -n "$CODE_VERSION" ] || { echo "deploy: code-version required" >&2; usage; }

# --- resolve hostname + classify ---
# Sets TARGET_HOST and HOST_KIND (sbx|stg|dev|prd|unknown).
TARGET_HOST=''
HOST_KIND=''

case "$HOST_INPUT" in
    *.*)
        # Has a period -- treat as a full hostname; classify by pattern.
        TARGET_HOST="$HOST_INPUT"
        # Only `cert.staging.<segs>.demandware.net` accepts WebDAV uploads.
        # The other staging-shaped hostnames the user might paste -- the
        # bare dotted form, the bare hyphenated form, or the address-bar
        # value with `cert.` slapped on -- all reach the same instance
        # but reject WebDAV. Coerce each into the canonical form and
        # echo a note so the swap is visible.
        #
        # Helper: turn the hyphen-bare form into the canonical form by
        # stripping the `staging-` prefix + `.demandware.net` suffix,
        # converting hyphens between segments to periods, and wrapping
        # back in `cert.staging.` ... `.demandware.net`.
        _to_cert_staging_from_hyphenbare() {
            local h="$1"
            local stripped="${h#staging-}"
            stripped="${stripped%.demandware.net}"
            local dotted
            dotted="$(printf %s "$stripped" | sed 's/-/./g')"
            printf 'cert.staging.%s.demandware.net' "$dotted"
        }

        case "$TARGET_HOST" in
            *.dx.commercecloud.salesforce.com) HOST_KIND='sbx' ;;
            cert.staging.*.demandware.net)     HOST_KIND='stg' ;;
            staging.*.demandware.net)
                # Missing `cert.` prefix on an otherwise-canonical form.
                TARGET_HOST="cert.${TARGET_HOST}"
                HOST_KIND='stg'
                echo "note: ${HOST_INPUT} is not WebDAV-uploadable; using ${TARGET_HOST} instead" >&2
                ;;
            cert.staging-*.demandware.net)
                # Address-bar form (hyphens) with `cert.` prepended -- a
                # natural mistake, since the address bar shows the
                # hyphenated form. Strip the prefix and run the same
                # hyphen-bare normalization as the next arm.
                TARGET_HOST="$(_to_cert_staging_from_hyphenbare "${TARGET_HOST#cert.}")"
                HOST_KIND='stg'
                echo "note: ${HOST_INPUT} is not WebDAV-uploadable; using ${TARGET_HOST} instead" >&2
                ;;
            staging-*.demandware.net)
                # Bare hyphen form (the address-bar shape). Same coercion.
                TARGET_HOST="$(_to_cert_staging_from_hyphenbare "$TARGET_HOST")"
                HOST_KIND='stg'
                echo "note: ${HOST_INPUT} is not WebDAV-uploadable; using ${TARGET_HOST} instead" >&2
                ;;
            development-*.demandware.net)      HOST_KIND='dev' ;;
            production-*.demandware.net)       HOST_KIND='prd' ;;
            *)                                  HOST_KIND='unknown' ;;
        esac
        ;;
    *[_-][0-9][0-9][0-9])
        HOST_KIND='sbx'
        _instance="${HOST_INPUT##*[_-]}"
        _realm="${HOST_INPUT%[_-]${_instance}}"
        _realm_hyphen="$(printf %s "$_realm" | sed 's/_/-/g')"
        TARGET_HOST="${_realm_hyphen}-${_instance}.dx.commercecloud.salesforce.com"
        ;;
    *)
        echo "deploy: '$HOST_INPUT' isn't a recognisable hostname or sandbox tenant id" >&2
        echo "  Hostnames contain a period (e.g. zzzz-001.dx.commercecloud.salesforce.com" >&2
        echo "  or cert.staging.na01.mybrand.demandware.net)." >&2
        echo "  Sandbox tenant ids end in _NNN (e.g. zzzz_001). Both _ and - are accepted" >&2
        echo "  as separators (zzzz_001 == zzzz-001). PIG instances must be passed as a" >&2
        echo "  full hostname." >&2
        exit 2
        ;;
esac

# Sanity: derived hostnames should always contain a period.
case "$TARGET_HOST" in
    *.*) ;;
    *)
        echo "deploy: failed to resolve a valid hostname from '$HOST_INPUT'" >&2
        exit 2
        ;;
esac

# --- early reject for prd ---
if [ "$HOST_KIND" = "prd" ]; then
    echo "deploy: refusing to upload directly to a production instance ($TARGET_HOST)" >&2
    echo "  Production does not accept direct code uploads." >&2
    echo "  Deploy to the matching staging instance instead, then use:" >&2
    echo "    Administration > Replication > Code Replication" >&2
    echo "  to push the code version from staging to production." >&2
    exit 1
fi

echo "target: $TARGET_HOST ($HOST_KIND) :: code version $CODE_VERSION" >&2

# --- resolve auth header ---
if [ -n "$USER_PASS" ] && [ -n "$TOKEN" ]; then
    echo "deploy: pass either -u/--user or -t/--token, not both" >&2
    exit 2
fi
if [ -z "$USER_PASS" ] && [ -z "$TOKEN" ]; then
    if [ -n "${SFCC_WEBDAV_TOKEN:-}" ]; then
        TOKEN="$SFCC_WEBDAV_TOKEN"
    elif [ -n "${SFCC_WEBDAV_USER:-}" ] && [ -n "${SFCC_WEBDAV_PASSWORD:-}" ]; then
        USER_PASS="$SFCC_WEBDAV_USER:$SFCC_WEBDAV_PASSWORD"
    else
        printf 'WebDAV username for %s: ' "$TARGET_HOST" >&2
        IFS= read -r SFCC_USERNAME
        printf 'WebDAV password: ' >&2
        IFS= read -rs SFCC_PW
        printf '\n' >&2
        USER_PASS="$SFCC_USERNAME:$SFCC_PW"
    fi
fi

CURL_AUTH=()
if [ -n "$TOKEN" ]; then
    CURL_AUTH=(-H "Authorization: Bearer $TOKEN")
else
    CURL_AUTH=(--user "$USER_PASS")
fi

# --- resolve mTLS (optional, but required for stg/dev) ---
[ -z "$P12_FILE" ] && P12_FILE="${SFCC_WEBDAV_P12:-}"
if [ -z "$P12_FILE" ]; then
    DEFAULT_P12="$USER-$TARGET_HOST.p12"
    [ -f "$DEFAULT_P12" ] && P12_FILE="$DEFAULT_P12"
fi

# Note on the ${CURL_MTLS[@]+"${CURL_MTLS[@]}"} forms below: bash 3.2
# (the macOS system bash) treats expanding an empty array under set -u
# as "unbound variable", even when the array was explicitly initialised
# with `arr=()`. Bash 4.4+ fixed this. The +"..." parameter expansion
# only emits the inner expansion when the variable is set, sidestepping
# the issue.
CURL_MTLS=()
if [ -n "$P12_FILE" ]; then
    if [ ! -f "$P12_FILE" ]; then
        echo "deploy: p12 file not found: $P12_FILE" >&2
        exit 1
    fi
    [ -z "$P12_PASS" ] && P12_PASS="${SFCC_WEBDAV_P12_PASSWORD:-}"
    if [ -z "$P12_PASS" ]; then
        printf 'p12 passphrase for %s: ' "$P12_FILE" >&2
        IFS= read -rs P12_PASS
        printf '\n' >&2
    fi
    # -k disables curl's TLS CA check so a self-signed BM CA on the mTLS
    # layer is accepted; this does NOT disable TLS itself.
    CURL_MTLS=(-k --cert-type p12 --cert "$P12_FILE:$P12_PASS")
fi

# --- per-host-kind validation ---
case "$HOST_KIND" in
    stg)
        if [ -z "$P12_FILE" ]; then
            echo "deploy: $TARGET_HOST (staging) requires mTLS authentication" >&2
            echo "  Pass --p12 <path> or set SFCC_WEBDAV_P12 to engage mTLS." >&2
            echo "  Default p12 path is \$USER-\$HOSTNAME.p12 in the current directory." >&2
            echo "  See Business Manager > Global Preferences > Keys & Certificates >" >&2
            echo "  MFA Certificates for the CA bundle used to mint a client p12." >&2
            exit 1
        fi
        ;;
    dev)
        echo "WARN: uploading directly to a development instance ($TARGET_HOST)." >&2
        echo "      Some code caches are only refreshed by Code Replication from" >&2
        echo "      staging, so direct dev uploads can produce inconsistent runtime" >&2
        echo "      behavior. Prefer deploying to staging and replicating." >&2
        ;;
    sbx|unknown)
        : # no special handling
        ;;
esac

# --- build the zip ---
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CARTRIDGE_NAME='bm_keyvalidator'
ZIP_PATH="/tmp/${CARTRIDGE_NAME}-deploy-$$.zip"
STAGING="/tmp/${CARTRIDGE_NAME}-staging-$$"

cleanup() {
    rm -rf "$STAGING" "$ZIP_PATH"
}
trap cleanup EXIT

# Build the zip from a staging dir whose only top-level entry is the
# cartridge directory (named bm_keyvalidator/), so the zip's top-level
# entry matches what BM expects after UNZIP.
mkdir -p "$STAGING"

# Mirror via rsync into the staging dir. Exclusions:
#   - VCS / dev artifacts that have no place on the instance
#   - test/ and package.json -- only meaningful at dev time
#   - dev-sync.sh / scripts/ / tmp/ -- developer scaffolding
#   - docs/, README.md, DESIGN.md, LICENSE -- repo-level documentation
#     not surfaced anywhere in the BM UI; anyone deploying the cartridge
#     already has the repo in front of them, so shipping these inside
#     the zip just adds bytes to the BM static cache for no benefit
#   - cert and key material -- nothing in this cartridge needs to ship
#     with private key material, but a developer working locally might
#     have a *.p12 / *.key / *.pem next to the repo (or under tmp/), so
#     the exclusion is a belt-and-suspenders safety net.
#
# Patterns starting with '/' are anchored to the rsync source root --
# without the slash, '--exclude=scripts/' would also match the
# cartridge/scripts/ directory holding our runtime modules.
rsync --archive \
      --exclude='.git*' \
      --exclude='node_modules/' \
      --exclude='.DS_Store' \
      --exclude='/dev-sync.sh' \
      --exclude='/scripts/' \
      --exclude='/tmp/' \
      --exclude='/test/' \
      --exclude='/docs/' \
      --exclude='/package.json' \
      --exclude='/README.md' \
      --exclude='/DESIGN.md' \
      --exclude='/LICENSE' \
      --exclude='*.p12' \
      --exclude='*.pfx' \
      --exclude='*.key' \
      --exclude='*.pem' \
      --exclude='*.crt' \
      --exclude='*.cer' \
      --exclude='*.der' \
      --exclude='*.csr' \
      --exclude='*.req' \
      --exclude='*.srl' \
      "$REPO_ROOT/" "$STAGING/$CARTRIDGE_NAME/"

(cd "$STAGING" && zip -qr "$ZIP_PATH" "$CARTRIDGE_NAME")

ZIP_SIZE_KB=$(( $(wc -c < "$ZIP_PATH") / 1024 ))
echo "built $ZIP_PATH (${ZIP_SIZE_KB} KB)" >&2

# --- upload + unzip ---
BASE_URL="https://${TARGET_HOST}/on/demandware.servlet/webdav/Sites/Cartridges/${CODE_VERSION}"
ZIP_URL="${BASE_URL}/${CARTRIDGE_NAME}.zip"

echo "uploading to ${ZIP_URL}" >&2
curl --fail --silent --show-error \
     "${CURL_AUTH[@]}" ${CURL_MTLS[@]+"${CURL_MTLS[@]}"} \
     --upload-file "$ZIP_PATH" \
     "$ZIP_URL"

echo "unzipping server-side" >&2
curl --fail --silent --show-error \
     "${CURL_AUTH[@]}" ${CURL_MTLS[@]+"${CURL_MTLS[@]}"} \
     --request POST \
     --data 'method=UNZIP' \
     "$ZIP_URL"

echo "removing remote zip" >&2
curl --fail --silent --show-error \
     "${CURL_AUTH[@]}" ${CURL_MTLS[@]+"${CURL_MTLS[@]}"} \
     --request DELETE \
     "$ZIP_URL"

echo "deployed to ${BASE_URL}/${CARTRIDGE_NAME}/" >&2
echo "next: activate code version '${CODE_VERSION}' in Administration > Site Development > Code Deployment" >&2
