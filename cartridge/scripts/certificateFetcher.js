'use strict';

/**
 * Fetches the list of imported certificate aliases from BM via the
 * Data API certificate_search endpoint.
 *
 * Two-step OAuth flow, executed against the same instance the cartridge
 * runs in:
 *
 *   1. POST /dw/oauth2/access_token
 *      grant_type = urn:demandware:params:oauth:grant-type:client-id:dwsid:dwsecuretoken
 *      Forwards the calling BM user's dwsid cookie. The instance's BM
 *      Account Manager mints a short-lived bearer token tied to that user.
 *
 *   2. POST /s/-/dw/data/v99_9/certificate_search
 *      With Authorization: Bearer <token from step 1>. Returns hits[] of
 *      certificate records with alias, type, valid_from, valid_to,
 *      algorithm, key_size.
 *
 * Designed to fail soft: every error path returns a structured
 * { error: '<reason>' } so the controller can surface a warning
 * without breaking the page.
 *
 * The default OAuth client id is BM's internal AM client (the same one
 * BM's own Private Keys page uses). If a sandbox has that disabled or
 * the user wants a custom client, they can override via Site Pref
 * `keyValidatorAMClientId`.
 */

// Same client BM uses internally on the Private Keys and Certificates page.
var DEFAULT_AM_CLIENT_ID = '6c957560-464f-4a98-ad0f-5e9662527e27';

var GRANT_TYPE = 'urn:demandware:params:oauth:grant-type:client-id:dwsid:dwsecuretoken';
var TOKEN_PATH = '/dw/oauth2/access_token';
var SEARCH_PATH = '/s/-/dw/data/v99_9/certificate_search';
// Per-call timeout. Two calls happen in sequence (token exchange, then
// certificate_search); the browser-side fetch in show.isml has a longer
// abort budget than 2 * TIMEOUT_MS so a slow individual call doesn't get
// pre-empted by the client.
var TIMEOUT_MS = 8000;
var MAX_RESULTS = 200;

/**
 * Build a fresh deps bundle backed by the real dw.* modules. Called
 * lazily so this file can be required outside the SFCC runtime.
 */
function defaultDeps() {
    var Logger = require('dw/system/Logger');
    return {
        HTTPClient: require('dw/net/HTTPClient'),
        Site: require('dw/system/Site'),
        System: require('dw/system/System'),
        log: Logger.getLogger('keyvalidator', 'CertificateFetcher')
    };
}

function getAMClientId(deps) {
    try {
        var pref = deps.Site.getCurrent().getCustomPreferenceValue('keyValidatorAMClientId');
        if (pref && String(pref).trim()) return String(pref).trim();
    } catch (e) {
        // Site preference not defined -- fall through to default.
    }
    return DEFAULT_AM_CLIENT_ID;
}

function getInstanceBaseUrl(deps) {
    return 'https://' + deps.System.getInstanceHostname();
}

function parseJson(body) {
    try { return JSON.parse(body); } catch (e) { return null; }
}

/**
 * Step 1: exchange the BM session jar for a bearer token.
 *
 * The grant type "client-id:dwsid:dwsecuretoken" depends on at least one
 * server-side cookie (dwsid; the secure-token component lives in another
 * HttpOnly cookie on the same response from BM). Rather than enumerate
 * which exact cookies AM needs (the set has changed across BM versions),
 * the caller forwards the full inbound Cookie header verbatim.
 *
 * @param {string} cookieHeader -- full Cookie header value from the user's request
 * @returns {{ ok: boolean, token: string|null, error: string|null, status: number }}
 */
function fetchAccessToken(cookieHeader, deps) {
    var clientId = getAMClientId(deps);
    var url = getInstanceBaseUrl(deps) + TOKEN_PATH;
    var http = new deps.HTTPClient();
    http.setTimeout(TIMEOUT_MS);
    http.open('POST', url);
    http.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded;charset=UTF-8');
    http.setRequestHeader('Accept', 'application/json');
    if (cookieHeader) http.setRequestHeader('Cookie', cookieHeader);

    var body = 'client_id=' + encodeURIComponent(clientId)
        + '&grant_type=' + encodeURIComponent(GRANT_TYPE);

    try {
        http.send(body);
    } catch (e) {
        deps.log.warn('Token request threw: {0}', e && e.message ? e.message : e);
        return { ok: false, token: null, error: 'timeout', status: 0 };
    }

    var status = http.getStatusCode();
    var responseBody = http.getText() || '';

    if (status !== 200) {
        var parsed = parseJson(responseBody) || {};
        var ocapiError = parsed.error || '';
        // Common AM responses: invalid_client (clientId rejected),
        // invalid_grant (dwsid expired or invalid), unauthorized_client.
        var category = 'unknown';
        if (ocapiError === 'invalid_client') category = 'invalid_client';
        else if (ocapiError === 'invalid_grant') category = 'invalid_grant';
        else if (status === 401 || status === 403) category = 'unauthorized';
        // Log enough of the response body to diagnose unexpected AM errors
        // without spamming logs for the common known categories.
        deps.log.warn('Token request failed status={0} category={1} body={2}',
            status, category, responseBody.slice(0, 300));
        return { ok: false, token: null, error: category, status: status };
    }

    var json = parseJson(responseBody);
    if (!json || !json.access_token) {
        deps.log.warn('Token response missing access_token: {0}', responseBody.slice(0, 200));
        return { ok: false, token: null, error: 'unknown', status: status };
    }

    return { ok: true, token: String(json.access_token), error: null, status: status };
}

/**
 * Step 2: certificate_search filtered to private keys.
 * @param {string} token -- bearer access token
 * @returns {{ ok: boolean, aliases: Array<{alias:string,...}>|null, error: string|null, status: number }}
 */
function fetchPrivateKeyAliases(token, deps) {
    var url = getInstanceBaseUrl(deps) + SEARCH_PATH + '?display_locale=default';
    var http = new deps.HTTPClient();
    http.setTimeout(TIMEOUT_MS);
    http.open('POST', url);
    http.setRequestHeader('Content-Type', 'application/json;charset=UTF-8');
    http.setRequestHeader('Accept', 'application/json');
    http.setRequestHeader('Authorization', 'Bearer ' + token);

    var body = JSON.stringify({
        start: 0,
        count: MAX_RESULTS,
        sorts: [{ field: 'alias', sort_order: 'asc' }],
        // Filter at the API: type must be private_key. Trusted certs and
        // public-key-only entries are excluded server-side.
        query: {
            term_query: {
                fields: ['type'],
                operator: 'is',
                values: ['private_key']
            }
        },
        select: '(hits.(alias,type,valid_from,valid_to,algorithm,key_size),count,start,total)'
    });

    try {
        http.send(body);
    } catch (e) {
        deps.log.warn('certificate_search threw: {0}', e && e.message ? e.message : e);
        return { ok: false, aliases: null, error: 'timeout', status: 0 };
    }

    var status = http.getStatusCode();
    var responseBody = http.getText() || '';

    if (status !== 200) {
        var parsed = parseJson(responseBody) || {};
        var ocapiError = (parsed.fault && parsed.fault.type) || parsed.error || '';
        var category = 'unknown';
        if (status === 401 || status === 403) category = 'unauthorized';
        else if (status === 0 || status >= 500) category = 'unavailable';
        deps.log.warn('certificate_search failed status={0} fault="{1}"', status, ocapiError);
        return { ok: false, aliases: null, error: category, status: status };
    }

    var json = parseJson(responseBody);
    if (!json) {
        return { ok: false, aliases: null, error: 'unknown', status: status };
    }

    var hits = Array.isArray(json.hits) ? json.hits : [];
    var aliases = hits.map(function (hit) {
        return {
            alias: hit.alias,
            algorithm: hit.algorithm || null,
            keySize: hit.key_size || null,
            validFrom: hit.valid_from || null,
            validTo: hit.valid_to || null
        };
    });

    return { ok: true, aliases: aliases, error: null, status: status };
}

/**
 * Extract the PEM-encoded public key for a private-key alias.
 *
 * SFCC stores the private key and its matching certificate under the
 * same keystore alias when a .p12 is imported. The cartridge API gives
 * us no way to read public-key bytes off a KeyRef directly (the class
 * is intentionally opaque), but it does let us look up the matching
 * certificate via dw.crypto.CertificateRef under the same alias and
 * then ask CertificateUtils for its base64-DER public key. We wrap
 * that in a PEM "PUBLIC KEY" block so the value can be pasted into
 * the cartridge's form (or into openssl).
 *
 * Returns null on any failure -- a single bad cert mustn't break the
 * whole alias list.
 */
/**
 * Public entrypoint. Returns one of:
 *   { ok: true, aliases: [...] }   -- success (list may be empty)
 *   { ok: false, error: '<cat>' }  -- failure; caller surfaces a warning
 *
 * Failure categories (machine-readable):
 *   'no_session'        no cookies on the request
 *   'invalid_client'    AM rejected the client id (override via Site Pref)
 *   'invalid_grant'     session expired or rejected
 *   'unauthorized'      OCAPI rejected the bearer token
 *   'unavailable'       network/5xx during either call
 *   'timeout'           request exceeded TIMEOUT_MS
 *   'unknown'           anything else
 *
 * @param {string} cookieHeader -- full Cookie header from the user's request
 */
function fetchAliases(cookieHeader, deps) {
    var resolved = deps || defaultDeps();

    if (!cookieHeader) {
        return { ok: false, error: 'no_session', aliases: null };
    }

    var token = fetchAccessToken(cookieHeader, resolved);
    if (!token.ok) {
        return { ok: false, error: token.error, aliases: null };
    }

    var keys = fetchPrivateKeyAliases(token.token, resolved);
    if (!keys.ok) {
        return { ok: false, error: keys.error, aliases: null };
    }

    return { ok: true, aliases: keys.aliases, error: null };
}

module.exports = {
    fetchAliases: fetchAliases,
    DEFAULT_AM_CLIENT_ID: DEFAULT_AM_CLIENT_ID
};
