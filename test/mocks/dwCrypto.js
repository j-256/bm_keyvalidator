'use strict';

/**
 * In-process fakes for dw.crypto.Signature and dw.crypto.KeyRef so the
 * keyValidator module can be exercised under Node.
 *
 * Behavior:
 *   sign(text, keyRef, alg)   -> deterministic "signature" string built
 *                                from the keyRef alias + text + alg
 *   verifySignature(sig, text, pubKey, alg)
 *                              -> true iff the public key starts with the
 *                                 same alias the signature was produced with
 *
 * That gives us a pure function we can drive any way the tests want.
 */

function MockKeyRef(alias) {
    if (!(this instanceof MockKeyRef)) return new MockKeyRef(alias);
    this.alias = alias;
}
MockKeyRef.prototype.getAlias = function () { return this.alias; };

// Tests can read these to assert what was passed across the dw.crypto
// boundary on the most recent call. Cleared at module scope so a fresh
// `require` (or a manual reset) starts clean -- the keyValidator suite
// uses freshDeps() per test, so reading these immediately after a single
// validate() call is safe.
var lastVerifyArgs = null;
function getLastVerifyArgs() { return lastVerifyArgs; }
function resetCalls() { lastVerifyArgs = null; }

function MockSignature() {
    if (!(this instanceof MockSignature)) return new MockSignature();
}

MockSignature.prototype.sign = function (text, keyRef, algorithm) {
    if (!keyRef || keyRef.alias == null) {
        throw new Error('mock: missing keyRef');
    }
    if (typeof text !== 'string') {
        throw new Error('mock: text must be a string');
    }
    if (!algorithm) {
        throw new Error('mock: missing algorithm');
    }
    return 'SIG[' + keyRef.alias + '|' + algorithm + '|' + text + ']';
};

MockSignature.prototype.verifySignature = function (signature, text, publicKey, algorithm) {
    lastVerifyArgs = {
        signature: signature, text: text, publicKey: publicKey, algorithm: algorithm
    };
    if (typeof signature !== 'string' || typeof publicKey !== 'string') return false;
    var match = signature.match(/^SIG\[([^|]+)\|([^|]+)\|([\s\S]+)\]$/);
    if (!match) return false;
    var sigAlias = match[1];
    var sigAlg = match[2];
    var sigText = match[3];
    return sigAlg === algorithm
        && sigText === text
        && publicKey.indexOf(sigAlias) === 0;
};

function ThrowingSignature(message) {
    return function () {
        var fn = function () {};
        fn.prototype.sign = function () { throw new Error(message); };
        fn.prototype.verifySignature = function () { throw new Error(message); };
        return new fn();
    };
}

module.exports = {
    Signature: MockSignature,
    KeyRef: MockKeyRef,
    ThrowingSignature: ThrowingSignature,
    getLastVerifyArgs: getLastVerifyArgs,
    resetCalls: resetCalls
};
