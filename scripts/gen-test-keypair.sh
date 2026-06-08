#!/bin/bash
# Generate a self-signed RSA keypair and a PKCS#12 bundle suitable for
# importing into Business Manager > Operations > Private Keys and
# Certificates, plus print the matching PEM public key for pasting into
# the Key Validator form.
#
# This is the openssl recipe from README.md "Sanity check", scripted
# end-to-end so a future operator can produce a known-good keypair in
# one command.
#
# Usage:
#     scripts/gen-test-keypair.sh                       # alias=keyvalidator-test
#     scripts/gen-test-keypair.sh my-alias              # custom alias
#     scripts/gen-test-keypair.sh my-alias 2048         # custom bits
#
# Output files land in ./tmp/<alias>/:
#     <alias>.key  -- private key (PEM)
#     <alias>.crt  -- self-signed cert (PEM)
#     <alias>.p12  -- PKCS#12 bundle for BM import (passphrase: test)
#     <alias>.pub  -- public key (PEM) -- also printed to stdout

set -euo pipefail

case "${1:-}" in
    -h|--help)
        cat <<'EOF'
Usage: scripts/gen-test-keypair.sh [ALIAS [BITS]]

Generate a self-signed RSA keypair and a PKCS#12 bundle suitable for
importing into Business Manager > Operations > Private Keys and
Certificates, plus print the matching PEM public key for pasting into
the Key Validator form.

Arguments:
    ALIAS    Alias to use (default: keyvalidator-test). Becomes the
             output filename stem and the suggested BM import alias.
    BITS     RSA key size in bits (default: 2048).

Output files land in <repo-root>/tmp/<alias>/:
    <alias>.key  -- private key (PEM)
    <alias>.crt  -- self-signed cert (PEM, 10-year validity)
    <alias>.p12  -- PKCS#12 bundle for BM import (passphrase: test)
    <alias>.pub  -- public key (PEM) -- also printed to stdout

Examples:
    scripts/gen-test-keypair.sh
    scripts/gen-test-keypair.sh my-alias
    scripts/gen-test-keypair.sh my-alias 4096
EOF
        exit 0
        ;;
    -*)
        echo "gen-test-keypair.sh: unknown flag: $1" >&2
        echo "Run with -h for usage." >&2
        exit 2
        ;;
esac

ALIAS="${1:-keyvalidator-test}"
BITS="${2:-2048}"
PASSPHRASE='test'

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT_DIR="$REPO_ROOT/tmp/$ALIAS"
mkdir -p "$OUT_DIR"

KEY="$OUT_DIR/$ALIAS.key"
CRT="$OUT_DIR/$ALIAS.crt"
P12="$OUT_DIR/$ALIAS.p12"
PUB="$OUT_DIR/$ALIAS.pub"

openssl genrsa -out "$KEY" "$BITS" 2>/dev/null

openssl req -new -x509 -key "$KEY" \
    -out "$CRT" \
    -days 3650 \
    -subj "/CN=$ALIAS" 2>/dev/null

openssl pkcs12 -export \
    -inkey "$KEY" \
    -in    "$CRT" \
    -name  "$ALIAS" \
    -out   "$P12" \
    -passout "pass:$PASSPHRASE" 2>/dev/null

openssl x509 -in "$CRT" -pubkey -noout > "$PUB"

cat <<EOF >&2
generated keypair: alias=$ALIAS bits=$BITS
  private key: $KEY
  certificate: $CRT
  pkcs12:      $P12 (passphrase: $PASSPHRASE)
  public key:  $PUB

import into BM:
  1. Administration > Operations > Private Keys and Certificates
  2. Click Import, upload $P12, passphrase: $PASSPHRASE
  3. Use alias: $ALIAS

paste this PEM block into Key Validator's "Encoded Public Key" field:
EOF

cat "$PUB"
