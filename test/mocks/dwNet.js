'use strict';

/**
 * In-process fakes for the dw.* surface that certificateFetcher.js
 * touches: HTTPClient, Site, System, plus a no-op Logger.
 *
 * The HTTPClient mock is queue-driven: the test arms a sequence of
 * scripted responses (or throws), and each `new HTTPClient()` consumes
 * the next one. This matches certificateFetcher's call pattern of
 * "two distinct HTTP calls, each with its own status/body".
 */

function makeLog() {
    var calls = [];
    var noop = function () {
        var args = Array.prototype.slice.call(arguments);
        calls.push(args);
    };
    return {
        warn: noop,
        info: noop,
        error: noop,
        debug: noop,
        calls: calls
    };
}

/**
 * Build an HTTPClient stand-in plus a controller object the test uses
 * to script responses.
 *
 * Usage:
 *     var rig = makeHttpRig();
 *     rig.enqueue({ status: 200, body: '{"access_token":"t"}' });
 *     rig.enqueue({ throws: 'socket timeout' });
 *     var deps = { ..., HTTPClient: rig.HTTPClient };
 *     ...
 *     rig.requests   // array of { method, url, headers, body }
 */
function makeHttpRig() {
    var queue = [];
    var requests = [];

    function HTTPClient() {
        this._method = null;
        this._url = null;
        this._headers = {};
        this._timeout = null;
        this._body = null;
        this._status = null;
        this._responseBody = null;
        this._sent = false;
    }
    HTTPClient.prototype.setTimeout = function (ms) { this._timeout = ms; };
    HTTPClient.prototype.open = function (method, url) {
        this._method = method;
        this._url = url;
    };
    HTTPClient.prototype.setRequestHeader = function (name, value) {
        this._headers[name] = value;
    };
    HTTPClient.prototype.send = function (body) {
        this._body = body == null ? null : String(body);
        this._sent = true;
        var scripted = queue.shift();
        if (!scripted) {
            throw new Error('HTTPClient mock: no scripted response in queue');
        }
        requests.push({
            method: this._method,
            url: this._url,
            headers: Object.assign({}, this._headers),
            body: this._body,
            timeout: this._timeout
        });
        if (scripted.throws) {
            // Mimic dw.net.HTTPClient throwing on transport-level failure.
            throw new Error(scripted.throws);
        }
        this._status = scripted.status;
        this._responseBody = scripted.body == null ? '' : String(scripted.body);
    };
    HTTPClient.prototype.getStatusCode = function () { return this._status; };
    HTTPClient.prototype.getText = function () { return this._responseBody; };

    return {
        HTTPClient: HTTPClient,
        enqueue: function (response) { queue.push(response); },
        requests: requests,
        remaining: function () { return queue.length; }
    };
}

/**
 * Site mock with optional custom preference values.
 * @param {object} prefs  map of pref-name -> value (or null/undefined to clear)
 * @param {boolean} [throwOnGetCurrent]  if true, getCurrent() throws (simulates running outside a site context)
 */
function makeSite(prefs, throwOnGetCurrent) {
    return {
        getCurrent: function () {
            if (throwOnGetCurrent) throw new Error('mock: no site context');
            return {
                getCustomPreferenceValue: function (name) {
                    return prefs && Object.prototype.hasOwnProperty.call(prefs, name)
                        ? prefs[name]
                        : null;
                }
            };
        }
    };
}

function makeSystem(hostname) {
    return {
        getInstanceHostname: function () {
            return hostname || 'mock-instance.dx.commercecloud.salesforce.com';
        }
    };
}

/**
 * Convenience: build a complete `deps` bundle for certificateFetcher.
 */
function makeDeps(options) {
    var opts = options || {};
    var rig = opts.rig || makeHttpRig();
    var log = opts.log || makeLog();
    return {
        HTTPClient: rig.HTTPClient,
        Site: opts.site || makeSite(opts.prefs || {}),
        System: opts.system || makeSystem(opts.hostname),
        log: log,
        _rig: rig,
        _log: log
    };
}

module.exports = {
    makeLog: makeLog,
    makeHttpRig: makeHttpRig,
    makeSite: makeSite,
    makeSystem: makeSystem,
    makeDeps: makeDeps
};
