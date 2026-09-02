# Repository instructions

## Read first

Read `README.md` and `DESIGN.md` before changing behavior. This repository is a standalone Business Manager extension that proves an imported private key matches a supplied public key by signing a fixed internal sample. It is intentionally not storefront functionality.

Keep operator-facing behavior, setup, security claims, and release instructions in the README accurate when a change affects them. Keep the OAuth alias-discovery design and failure model in `DESIGN.md` aligned with the implementation.

## Security and trust boundaries

- Keep every operation that invokes `dw.crypto.Signature.sign()` behind Business Manager authentication, role permissions, and audit logging. The classic controller's `.public` marker is a Business Manager dispatcher convention, not permission to expose the endpoints through a storefront or other public route.
- Preserve the fixed internal sample text. Do not accept arbitrary payloads to sign, and do not return generated signatures from controller responses or render them in the browser.
- Keep the accepted signature algorithms constrained by `SUPPORTED_ALGORITHMS`; use that list as the source for both server validation and UI options.
- Keep `KeyValidator-Verify` CSRF-protected. Preserve the same-origin request and credential behavior in the browser client.
- Alias discovery may forward the complete inbound Business Manager cookie jar only to the same instance's `/dw/oauth2/access_token`, with the target host derived from `System.getInstanceHostname()`. Use the resulting bearer token only for the private-key certificate search. Never return or log cookies, bearer tokens, credentials, passphrases, private-key material, or generated signatures.
- The documented audit trail may contain the alias, selected algorithm, and supplied public key because those fields are non-secret. Do not broaden diagnostic output to secret material.
- Render dynamic response and alias values through `textContent`, `createTextNode`, or equivalent escaping. Do not put them into `innerHTML`. The `encoding="off"` template insertions are reserved for server-built JSON literal bags; review any new fields for safe script-literal serialization.

## Validation and alias-discovery contracts

- Preserve the distinct match, mismatch, input error, unsupported-algorithm error, and cryptographic error outcomes. Keep the controller's JSON response shape stable, and keep the generated signature inside the validation layer.
- PEM armor and line breaks are normalized before verification. Spaces and tabs remain observable through `whitespaceNormalized`; that warning is advisory and must not become a submit block or silently change the reported match result.
- Public-key length and algorithm-family fitness checks are also advisory. Unknown families, unknown sizes, and incomplete alias metadata must not prevent verification.
- Keep alias discovery fail-soft for the operator: `KeyValidator-Aliases` returns a structured JSON body, lookup failures leave manual alias entry usable, and a successful empty result remains distinguishable from a failed lookup.
- Keep the certificate search filtered server-side to private keys and limited to the metadata needed by the UI. Fetch every reported page. If a later page fails or pagination becomes inconsistent, discard the partial list rather than present incomplete results as success.
- Preserve the documented failure categories and timeout behavior across the token exchange and certificate search. Add focused fake-HTTP tests whenever request construction, pagination, response parsing, or error mapping changes.

## SFCC runtime and browser compatibility

- Preserve the standalone cartridge boundary: no SFRA, `app_storefront_base`, or npm runtime dependency.
- Keep cartridge JavaScript compatible with the SFCC compatibility modes documented in the README. Use the existing CommonJS and conservative JavaScript style, and load `dw.*` dependencies lazily where the module is designed for Node testing.
- Keep user-visible copy in the `keyvalidator` resource bundle. When adding a server-built message or link bag, update the controller, template, and localization resources together.
- Preserve graceful browser fallbacks and the free-text alias path. Alias autocomplete, clipboard support, abort handling, and advisory checks must enhance the form without making verification depend on those browser features.

## Key material, packaging, and deployment

- Treat files created by `scripts/gen-test-keypair.sh` as local test material. Keep private keys, certificates, PKCS#12 bundles, passphrases, and generated `tmp/` content ignored, out of archives, and out of commits.
- Deployment archives must contain exactly one top-level `bm_keyvalidator/` directory. Preserve the anchored exclusions that omit repository scaffolding while retaining runtime `cartridge/scripts/`, and preserve the broad key-material exclusions.
- `scripts/deploy.sh` uploads, unzips, and deletes a remote archive in an existing code version. Run it only when deployment is explicitly requested and the target host and code version have been confirmed. Preserve the direct-production refusal and staging mTLS requirements.
- Test packaging changes locally without contacting WebDAV. Inspect the resulting archive contents when changing rsync exclusions, staging layout, or cartridge paths.

## Verification and releases

- Run `npm test` for repository changes. It validates the documentation cover, Node unit suites, and the non-network deployment-script harness.
- Add focused regression coverage for the contract being changed. Keep `dw.*` collaborators injectable so routine tests do not require an SFCC instance.
- Do not use a live sandbox, WebDAV upload, code-version activation, or replication as a routine test unless the user explicitly requests external verification.
- Use `npm version` only for an explicitly requested release. It requires a clean synchronized `main`, runs the release checks, creates the version commit and tag, and pushes both refs; it is not a harmless version-edit or verification command.
