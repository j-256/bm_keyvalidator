'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');

var keyValidator = require(path.join(__dirname, '..', '..', 'cartridge', 'scripts', 'keyValidator.js'));
var mocks = require(path.join(__dirname, '..', 'mocks', 'dwCrypto.js'));

function freshDeps() {
    return { Signature: mocks.Signature, KeyRef: mocks.KeyRef };
}

test('SUPPORTED_ALGORITHMS is a frozen, non-empty list', function () {
    assert.ok(Array.isArray(keyValidator.SUPPORTED_ALGORITHMS));
    assert.ok(keyValidator.SUPPORTED_ALGORITHMS.length >= 4);
    assert.ok(Object.isFrozen(keyValidator.SUPPORTED_ALGORITHMS));
    assert.ok(keyValidator.SUPPORTED_ALGORITHMS.indexOf(keyValidator.DEFAULT_ALGORITHM) !== -1);
});

test('validate: matching keypair returns ok=true, match=true', function () {
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: 'demoaliasPUBLICKEYMATERIALxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    }, freshDeps());

    assert.equal(result.ok, true);
    assert.equal(result.match, true);
    assert.equal(result.error, null);
    assert.equal(result.errorCategory, null);
    assert.equal(result.algorithm, keyValidator.DEFAULT_ALGORITHM);
    assert.match(result.signature, /^SIG\[demoalias\|/);
});

test('validate: non-matching public key returns ok=true, match=false', function () {
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: 'otheraliasPUBLICKEYMATERIALxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    }, freshDeps());

    assert.equal(result.ok, true);
    assert.equal(result.match, false);
    assert.equal(result.error, null);
});

test('validate: chosen algorithm flows through', function () {
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: 'demoaliasPUBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        algorithm: 'SHA512withRSA'
    }, freshDeps());

    assert.equal(result.ok, true);
    assert.equal(result.algorithm, 'SHA512withRSA');
    assert.match(result.signature, /\|SHA512withRSA\|/);
});

test('validate: missing privKeyID returns input error', function () {
    var result = keyValidator.validate({
        privKeyID: '',
        publicKey: 'somethingxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    }, freshDeps());

    assert.equal(result.ok, false);
    assert.equal(result.match, null);
    assert.equal(result.errorCategory, 'input');
    assert.equal(result.error, 'keyvalidator.error.missing.privkeyid');
    assert.equal(result.signature, null);
});

test('validate: whitespace-only privKeyID is treated as missing', function () {
    var result = keyValidator.validate({
        privKeyID: '   \t\n  ',
        publicKey: 'somethingxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    }, freshDeps());

    assert.equal(result.errorCategory, 'input');
    assert.equal(result.error, 'keyvalidator.error.missing.privkeyid');
});

test('validate: missing publicKey returns input error', function () {
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: ''
    }, freshDeps());

    assert.equal(result.errorCategory, 'input');
    assert.equal(result.error, 'keyvalidator.error.missing.pubkey');
});

test('validate: unsupported algorithm returns algorithm error', function () {
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: 'demoaliasPUBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        algorithm: 'MD5withRSA'
    }, freshDeps());

    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'algorithm');
    assert.equal(result.error, 'keyvalidator.error.unsupported.algorithm');
});

test('validate: short non-base64 publicKey returns malformed input error', function () {
    // The pre-flight syntactic check rejects gibberish like "jk" before
    // calling Signature.verifySignature, which would otherwise throw a
    // platform InvalidKeyException with a Java stack trace.
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: 'jk'
    }, freshDeps());
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'input');
    assert.equal(result.error, 'keyvalidator.error.malformed.pubkey');
});

test('validate: publicKey with non-base64 chars returns malformed input error', function () {
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        // length is fine, but contains "!" which isn't base64
        publicKey: '!'.repeat(80)
    }, freshDeps());
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'input');
    assert.equal(result.error, 'keyvalidator.error.malformed.pubkey');
});

test('validate: PEM-armored publicKey passes the syntactic check', function () {
    // PEM headers and whitespace are stripped before the base64 check;
    // the trimmed body still has to be valid base64 of plausible length.
    // We only assert that this input clears the pre-flight check (i.e.,
    // doesn't produce a malformed-input error) -- whether the mock then
    // reports a match depends on the mock's own PEM-naive logic.
    var pem = '-----BEGIN PUBLIC KEY-----\n'
        + 'demoalias' + 'A'.repeat(64) + '=\n'
        + '-----END PUBLIC KEY-----';
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: pem
    }, freshDeps());
    assert.notEqual(result.errorCategory, 'input');
    assert.notEqual(result.error, 'keyvalidator.error.malformed.pubkey');
});

test('validate: PEM armor + newlines are stripped before reaching dw.crypto.verifySignature', function () {
    // Regression: dw.crypto.Signature.verifySignature throws an
    // InvalidKeyException ("Unable to decode key") on PEM-armored input
    // despite the README accepting it. The validator strips armor +
    // newlines before crossing the boundary on the first attempt --
    // spaces and tabs are preserved so we can detect them as user-error
    // and recover (see "errant whitespace" tests below).
    mocks.resetCalls();
    var pemBody = 'demoalias' + 'A'.repeat(64) + '=';
    var pem = '-----BEGIN PUBLIC KEY-----\n' + pemBody + '\n-----END PUBLIC KEY-----';
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: pem
    }, freshDeps());
    var args = mocks.getLastVerifyArgs();
    assert.ok(args, 'verifySignature should have been called');
    assert.equal(args.publicKey, pemBody,
        'verifySignature must receive the stripped Base64 body, not the armored PEM');
    assert.equal(result.whitespaceNormalized, false,
        'a clean PEM (no spaces/tabs) should not trip the whitespace recovery flag');
});

test('validate: input with embedded space sets whitespaceNormalized=true', function () {
    // Common DKIM operator failure mode: an invisible space inside the
    // pasted public key, often from a source that word-wrapped or
    // tab-padded the key. The platform's base64 decoder tolerates
    // spaces in the body, but a published-elsewhere copy of the key
    // (DKIM TXT record, deploy config) likely won't. The flag surfaces
    // the issue regardless of whether verification itself succeeded.
    var pemBody = 'demoalias' + 'A'.repeat(64) + '=';
    var withSpace = pemBody.slice(0, 30) + ' ' + pemBody.slice(30);
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: withSpace
    }, freshDeps());
    assert.equal(result.ok, true);
    assert.equal(result.match, true);
    assert.equal(result.whitespaceNormalized, true);
});

test('validate: input with embedded tab sets whitespaceNormalized=true', function () {
    var pemBody = 'demoalias' + 'A'.repeat(64) + '=';
    var withTab = pemBody.slice(0, 20) + '\t' + pemBody.slice(20);
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: withTab
    }, freshDeps());
    assert.equal(result.ok, true);
    assert.equal(result.whitespaceNormalized, true);
});

test('validate: whitespaceNormalized stays true even when verification fails', function () {
    // The pre-flight detection runs before any verify call, so a key
    // with embedded whitespace that *also* happens to fail verification
    // (e.g. it's just plain wrong) still surfaces the advisory.
    var FailingSig = function () {};
    FailingSig.prototype.sign = mocks.Signature.prototype.sign;
    FailingSig.prototype.verifySignature = function () {
        throw new Error('platform-rejected');
    };
    var pemBody = 'demoalias' + 'A'.repeat(64) + '=';
    var withSpace = pemBody.slice(0, 30) + ' ' + pemBody.slice(30);
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: withSpace
    }, { Signature: FailingSig, KeyRef: mocks.KeyRef });
    assert.equal(result.ok, false);
    assert.equal(result.errorCategory, 'crypto');
    assert.equal(result.whitespaceNormalized, true);
});

test('validate: newlines alone do not trip whitespaceNormalized', function () {
    // Newlines are unconditionally stripped before verify; they're
    // expected (PEM, textarea, CRLF on the wire) and never user-error.
    // The flag is reserved for spaces/tabs.
    var pemBody = 'demoalias' + 'A'.repeat(64) + '=';
    var withNewlines = pemBody.slice(0, 32) + '\n' + pemBody.slice(32, 64) + '\r\n' + pemBody.slice(64);
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: withNewlines
    }, freshDeps());
    assert.equal(result.ok, true);
    assert.equal(result.whitespaceNormalized, false);
});

test('validate: returned object always includes whitespaceNormalized', function () {
    // Pin the result-shape contract so the controller / client can rely
    // on the field always being present (vs. undefined leaking through).
    var success = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: 'demoaliasPUBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    }, freshDeps());
    var inputErr = keyValidator.validate({}, freshDeps());
    var algErr = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: 'demoaliasPUBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        algorithm: 'BOGUS'
    }, freshDeps());
    assert.equal(success.whitespaceNormalized, false);
    assert.equal(inputErr.whitespaceNormalized, false);
    assert.equal(algErr.whitespaceNormalized, false);
});

test('validate: blank algorithm falls back to default', function () {
    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: 'demoaliasPUBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        algorithm: '   '
    }, freshDeps());

    assert.equal(result.ok, true);
    assert.equal(result.algorithm, keyValidator.DEFAULT_ALGORITHM);
});

test('validate: crypto exception is captured as crypto error', function () {
    var ThrowingSig = function () {};
    ThrowingSig.prototype.sign = function () { throw new Error('boom: invalid keyref'); };
    ThrowingSig.prototype.verifySignature = function () { throw new Error('unused'); };

    var result = keyValidator.validate({
        privKeyID: 'demoalias',
        publicKey: 'demoaliasPUBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    }, { Signature: ThrowingSig, KeyRef: mocks.KeyRef });

    assert.equal(result.ok, false);
    assert.equal(result.match, null);
    assert.equal(result.errorCategory, 'crypto');
    assert.match(result.error, /boom: invalid keyref/);
    assert.equal(result.signature, null);
});

test('validate: input is null/undefined safe', function () {
    var r1 = keyValidator.validate(null, freshDeps());
    assert.equal(r1.ok, false);
    assert.equal(r1.errorCategory, 'input');

    var r2 = keyValidator.validate(undefined, freshDeps());
    assert.equal(r2.ok, false);
    assert.equal(r2.errorCategory, 'input');
});

test('validate: returned object always has the documented shape', function () {
    var keys = ['ok', 'match', 'algorithm', 'signature', 'error', 'errorCategory'];

    var success = keyValidator.validate({
        privKeyID: 'demoalias', publicKey: 'demoaliasPUBxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'
    }, freshDeps());
    var failure = keyValidator.validate({}, freshDeps());

    keys.forEach(function (k) {
        assert.ok(Object.prototype.hasOwnProperty.call(success, k), 'success missing key: ' + k);
        assert.ok(Object.prototype.hasOwnProperty.call(failure, k), 'failure missing key: ' + k);
    });
});
