# Design notes

Background on how the cartridge actually works under the covers, for anyone hacking on it. The README covers user-facing features; this file covers the implementation choices that aren't self-evident from the code.

## Dynamic alias dropdown

On page load the browser fetches `KeyValidator-Aliases`, a JSON endpoint that returns the imported private keys for the instance via a two-step OAuth flow against the calling instance:

1. **Token exchange** – POST to `/dw/oauth2/access_token` with the `urn:demandware:params:oauth:grant-type:client-id:dwsid:dwsecuretoken` grant, forwarding the user's BM session cookies. Account Manager mints a bearer token tied to the BM user; the token is short-lived (~5 minutes) but each page load triggers a fresh exchange so the lifetime never matters in practice.
2. **Search** – POST to `/s/-/dw/data/v99_9/certificate_search` with the bearer token, filtered to `type=private_key`.

The default OAuth client ID is BM's internal AM client (the same one BM's own *Private Keys and Certificates* page uses). It's been stable for 10+ years and isn't expected to change, but if a future BM version ever rotates it, the `keyValidatorAMClientId` site preference is an emergency escape hatch.

### Failure handling

The endpoint always returns 200 with a structured body so the client-side script can render a graceful, non-blocking notice rather than break the page on failure. Failure categories:

| Category         | Meaning                                                            |
|------------------|--------------------------------------------------------------------|
| `no_session`     | No cookies on the request                                          |
| `invalid_client` | AM rejected the client ID – override via the site pref             |
| `invalid_grant`  | BM session expired or was rejected                                 |
| `unauthorized`   | OCAPI rejected the bearer token (role permission?)                 |
| `unavailable`    | Network or 5xx error during either OAuth step                      |
| `timeout`        | Either step exceeded the 8-second per-call budget                  |
| `unknown`        | Anything else – check `customwarn-keyvalidator.log`                |

If the API succeeds but returns zero private keys, the user sees a blue *info* notice clarifying that the instance simply has no private keys imported yet (distinguished from a fetch failure, which renders in *warn* style).

The categorization itself is exercised by 26 unit tests in `test/unit/certificateFetcher.test.js` against an in-process `dw.net.HTTPClient` fake.
