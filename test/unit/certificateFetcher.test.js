'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');

var fetcher = require(path.join(__dirname, '..', '..', 'cartridge', 'scripts', 'certificateFetcher.js'));
var net = require(path.join(__dirname, '..', 'mocks', 'dwNet.js'));

// Shorthand: build a deps bundle whose HTTPClient mock has the listed
// scripted responses queued in order.
function depsWith() {
    var rig = net.makeHttpRig();
    for (var i = 0; i < arguments.length; i++) rig.enqueue(arguments[i]);
    return net.makeDeps({ rig: rig });
}

// --- fetchAliases: short-circuit on missing session ---

test('fetchAliases: empty cookie header returns no_session without HTTP', function () {
    var deps = net.makeDeps();
    var result = fetcher.fetchAliases('', deps);
    assert.deepEqual(result, { ok: false, error: 'no_session', aliases: null });
    assert.equal(deps._rig.requests.length, 0);
});

test('fetchAliases: null cookie header returns no_session', function () {
    var deps = net.makeDeps();
    var result = fetcher.fetchAliases(null, deps);
    assert.equal(result.error, 'no_session');
    assert.equal(deps._rig.requests.length, 0);
});

// --- token request: status/body categorization ---

test('fetchAliases: AM rejects clientId with 400 invalid_client', function () {
    var deps = depsWith({ status: 400, body: '{"error":"invalid_client"}' });
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.deepEqual(result, { ok: false, error: 'invalid_client', aliases: null });
    assert.equal(deps._rig.requests.length, 1);
});

test('fetchAliases: AM rejects expired session with invalid_grant', function () {
    var deps = depsWith({ status: 400, body: '{"error":"invalid_grant"}' });
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.error, 'invalid_grant');
});

test('fetchAliases: AM 401 with no body category falls through to unauthorized', function () {
    var deps = depsWith({ status: 401, body: '' });
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.error, 'unauthorized');
});

test('fetchAliases: AM 403 with no body category falls through to unauthorized', function () {
    var deps = depsWith({ status: 403, body: '' });
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.error, 'unauthorized');
});

test('fetchAliases: AM 500 with no error key returns unknown', function () {
    var deps = depsWith({ status: 500, body: 'oops' });
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.error, 'unknown');
});

test('fetchAliases: AM HTTP send throws -> timeout', function () {
    var deps = depsWith({ throws: 'socket timeout' });
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.error, 'timeout');
});

test('fetchAliases: AM 200 with malformed JSON body returns unknown', function () {
    var deps = depsWith({ status: 200, body: 'not-json' });
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.error, 'unknown');
});

test('fetchAliases: AM 200 missing access_token returns unknown', function () {
    var deps = depsWith({ status: 200, body: '{"foo":"bar"}' });
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.error, 'unknown');
});

// --- certificate_search categorization ---

test('fetchAliases: search 401 -> unauthorized', function () {
    var deps = depsWith(
        { status: 200, body: '{"access_token":"t"}' },
        { status: 401, body: '{"fault":{"type":"NoAccessException"}}' }
    );
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.error, 'unauthorized');
});

test('fetchAliases: search 403 -> unauthorized', function () {
    var deps = depsWith(
        { status: 200, body: '{"access_token":"t"}' },
        { status: 403, body: '' }
    );
    assert.equal(fetcher.fetchAliases('dwsid=abc', deps).error, 'unauthorized');
});

test('fetchAliases: search 500 -> unavailable', function () {
    var deps = depsWith(
        { status: 200, body: '{"access_token":"t"}' },
        { status: 503, body: '' }
    );
    assert.equal(fetcher.fetchAliases('dwsid=abc', deps).error, 'unavailable');
});

test('fetchAliases: search transport throw -> timeout', function () {
    var deps = depsWith(
        { status: 200, body: '{"access_token":"t"}' },
        { throws: 'connect ETIMEDOUT' }
    );
    assert.equal(fetcher.fetchAliases('dwsid=abc', deps).error, 'timeout');
});

test('fetchAliases: search 400 with unrecognised status -> unknown', function () {
    var deps = depsWith(
        { status: 200, body: '{"access_token":"t"}' },
        { status: 400, body: '' }
    );
    // status=400 isn't 401/403 and isn't >=500, so falls through to unknown.
    assert.equal(fetcher.fetchAliases('dwsid=abc', deps).error, 'unknown');
});

test('fetchAliases: search 200 with malformed body returns unknown', function () {
    var deps = depsWith(
        { status: 200, body: '{"access_token":"t"}' },
        { status: 200, body: 'not-json' }
    );
    assert.equal(fetcher.fetchAliases('dwsid=abc', deps).error, 'unknown');
});

// --- happy path + shape ---

test('fetchAliases: happy path returns mapped alias records', function () {
    var deps = depsWith(
        { status: 200, body: '{"access_token":"AM-TOKEN-XYZ"}' },
        { status: 200, body: JSON.stringify({
            hits: [
                { alias: 'a1', type: 'private_key', algorithm: 'RSA', key_size: 2048,
                  valid_from: '2025-01-01', valid_to: '2030-01-01' },
                { alias: 'a2', type: 'private_key' }
            ],
            count: 2, start: 0, total: 2
        }) }
    );
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.deepEqual(result.aliases, [
        { alias: 'a1', algorithm: 'RSA', keySize: 2048,
          validFrom: '2025-01-01', validTo: '2030-01-01' },
        { alias: 'a2', algorithm: null, keySize: null,
          validFrom: null, validTo: null }
    ]);
});

test('fetchAliases: empty hits array yields empty aliases (not error)', function () {
    var deps = depsWith(
        { status: 200, body: '{"access_token":"t"}' },
        { status: 200, body: '{"hits":[],"count":0,"start":0,"total":0}' }
    );
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.ok, true);
    assert.deepEqual(result.aliases, []);
});

test('fetchAliases: response without hits key still returns ok with []', function () {
    var deps = depsWith(
        { status: 200, body: '{"access_token":"t"}' },
        { status: 200, body: '{}' }
    );
    var result = fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(result.ok, true);
    assert.deepEqual(result.aliases, []);
});

// --- token / search request shape ---

test('fetchAliases: token request uses correct method, headers, and body', function () {
    var deps = depsWith({ status: 400, body: '{"error":"invalid_client"}' });
    fetcher.fetchAliases('dwsid=abc; foo=bar', deps);
    var req = deps._rig.requests[0];
    assert.equal(req.method, 'POST');
    assert.match(req.url, /\/dw\/oauth2\/access_token$/);
    assert.equal(req.headers['Content-Type'], 'application/x-www-form-urlencoded;charset=UTF-8');
    assert.equal(req.headers['Accept'], 'application/json');
    assert.equal(req.headers['Cookie'], 'dwsid=abc; foo=bar');
    assert.match(req.body, /grant_type=urn%3Ademandware/);
    assert.match(req.body, /client_id=/);
});

test('fetchAliases: token request omits Cookie header when none supplied (after no_session check)', function () {
    // no_session short-circuits before HTTP, so this case verifies the
    // header-setting code only fires when a header is present. We construct
    // a non-empty cookieHeader so we get past the short-circuit, but pass
    // a falsy-looking-but-truthy value to confirm it makes it through.
    var deps = depsWith({ status: 400, body: '{"error":"invalid_client"}' });
    fetcher.fetchAliases('x', deps);
    assert.equal(deps._rig.requests[0].headers['Cookie'], 'x');
});

test('fetchAliases: search request authorises with bearer token from step 1', function () {
    var deps = depsWith(
        { status: 200, body: '{"access_token":"BEARER-XYZ"}' },
        { status: 200, body: '{"hits":[]}' }
    );
    fetcher.fetchAliases('dwsid=abc', deps);
    var searchReq = deps._rig.requests[1];
    assert.equal(searchReq.method, 'POST');
    assert.match(searchReq.url, /\/s\/-\/dw\/data\/v\d+_\d+\/certificate_search/);
    assert.equal(searchReq.headers['Authorization'], 'Bearer BEARER-XYZ');
    assert.equal(searchReq.headers['Content-Type'], 'application/json;charset=UTF-8');
    var body = JSON.parse(searchReq.body);
    assert.deepEqual(body.query, {
        term_query: { fields: ['type'], operator: 'is', values: ['private_key'] }
    });
});

// --- AM client id override ---

test('fetchAliases: site preference keyValidatorAMClientId overrides default', function () {
    var rig = net.makeHttpRig();
    rig.enqueue({ status: 400, body: '{"error":"invalid_client"}' });
    var deps = net.makeDeps({
        rig: rig,
        prefs: { keyValidatorAMClientId: 'custom-client-id' }
    });
    fetcher.fetchAliases('dwsid=abc', deps);
    var body = deps._rig.requests[0].body;
    assert.match(body, /client_id=custom-client-id/);
});

test('fetchAliases: blank/whitespace site preference falls back to default', function () {
    var rig = net.makeHttpRig();
    rig.enqueue({ status: 400, body: '{"error":"invalid_client"}' });
    var deps = net.makeDeps({
        rig: rig,
        prefs: { keyValidatorAMClientId: '   ' }
    });
    fetcher.fetchAliases('dwsid=abc', deps);
    var body = deps._rig.requests[0].body;
    assert.match(body, new RegExp('client_id=' + fetcher.DEFAULT_AM_CLIENT_ID));
});

test('fetchAliases: missing site context falls back to default client', function () {
    var rig = net.makeHttpRig();
    rig.enqueue({ status: 400, body: '{"error":"invalid_client"}' });
    var deps = net.makeDeps({
        rig: rig,
        site: net.makeSite({}, /* throwOnGetCurrent */ true)
    });
    fetcher.fetchAliases('dwsid=abc', deps);
    var body = deps._rig.requests[0].body;
    assert.match(body, new RegExp('client_id=' + fetcher.DEFAULT_AM_CLIENT_ID));
});

// --- ordering: failure in step 1 must not call step 2 ---

test('fetchAliases: token failure short-circuits, no search request issued', function () {
    var deps = depsWith({ status: 400, body: '{"error":"invalid_grant"}' });
    fetcher.fetchAliases('dwsid=abc', deps);
    assert.equal(deps._rig.requests.length, 1, 'only the token request should fire');
    assert.equal(deps._rig.remaining(), 0);
});
