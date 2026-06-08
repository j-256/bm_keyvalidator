'use strict';

/**
 * Pure validation logic for the Key Validator BM extension.
 * Kept free of dw.* requires at module scope so it can be unit-tested
 * with Node's built-in test runner.
 */

// The plaintext is an internal implementation detail: any non-empty string
// round-trips through sign+verify the same way, so there is no value in
// letting the user supply it. We hardcode a fixed sample.
var SAMPLE_TEXT = 'bm_keyvalidator sample plaintext';

// Algorithms accepted by dw.crypto.Signature. Display labels are looked up
// via Resource.msg in the controller; keeping them out of this module keeps
// the logic dw-free.
var SUPPORTED_ALGORITHMS = Object.freeze([
    'SHA256withRSA',
    'SHA384withRSA',
    'SHA512withRSA',
    'SHA1withRSA',
    'SHA256withECDSA',
    'SHA384withECDSA',
    'SHA512withECDSA'
]);

var DEFAULT_ALGORITHM = 'SHA256withRSA';

/**
 * Build a fresh deps bundle backed by the real dw.* modules.
 * Called lazily so this file can be required outside the SFCC runtime.
 */
function defaultDeps() {
    return {
        Signature: require('dw/crypto/Signature'),
        KeyRef: require('dw/crypto/KeyRef')
    };
}

function trim(value) {
    if (value == null) return '';
    return String(value).replace(/^\s+|\s+$/g, '');
}

/**
 * Quick syntactic check for "this looks like a base64 SubjectPublicKeyInfo".
 *
 * The SFCC Signature.verifySignature() call throws an InvalidKeyException
 * (with a Java stack trace) when handed garbage like "jk", which is poor
 * UX -- a user mis-typing into the field shouldn't be greeted with a
 * platform error. Rejecting obvious non-base64 input up-front lets us
 * surface a friendly "this isn't a valid public key" instead.
 *
 * Strips PEM armor and whitespace, then checks the leftover is valid
 * base64 of plausible length (a 2048-bit RSA SubjectPublicKeyInfo is
 * around 270 base64 chars; 1024 RSA is ~166; ECDSA is shorter). We
 * use 64 as a generous lower bound to filter out gibberish without
 * being prescriptive about the algorithm.
 */
/**
 * Strip PEM armor and *only* line breaks from a public key string.
 * Newlines are essentially always present (textareas, openssl output,
 * CRLF on the wire) and are never part of the key bytes, so removing
 * them is safe and unconditional.
 *
 * Any other whitespace -- spaces, tabs -- is preserved so we can detect
 * them as user-error and offer a recovery (see stripPemArmorAndAllWhitespace
 * and the retry path in validate()).
 */
function stripPemArmorAndNewlines(value) {
    return String(value)
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/[\r\n]+/g, '');
}

/**
 * Strip PEM armor and ALL whitespace -- including spaces and tabs.
 * Used by:
 *   - looksLikeEncodedPublicKey, which only cares about the canonical
 *     base64 alphabet,
 *   - the retry path in validate() when the first verifySignature attempt
 *     throws, so we can recover from "user pasted a key with an errant
 *     space" without silently accepting it.
 */
function stripPemArmorAndAllWhitespace(value) {
    return String(value)
        .replace(/-----BEGIN [^-]+-----/g, '')
        .replace(/-----END [^-]+-----/g, '')
        .replace(/\s+/g, '');
}

function looksLikeEncodedPublicKey(value) {
    var stripped = stripPemArmorAndAllWhitespace(value);
    if (stripped.length < 64) return false;
    return /^[A-Za-z0-9+/]+=*$/.test(stripped);
}

/**
 * Verify that a private key (referenced by Business Manager key alias) and
 * an encoded public key form a matching pair, by signing a fixed sample
 * plaintext with the private key and verifying the signature against the
 * public key.
 *
 * @param {Object} input
 * @param {string} input.privKeyID    BM private key alias
 * @param {string} input.publicKey    Encoded public key (typically Base64-DER, may include PEM armor)
 * @param {string} [input.algorithm]  One of SUPPORTED_ALGORITHMS (defaults to SHA256withRSA)
 * @param {Object} [deps]             Injected { Signature, KeyRef } -- defaults to dw.crypto.*
 * @returns {{
 *   ok: boolean,
 *   match: (boolean|null),
 *   algorithm: string,
 *   signature: (string|null),
 *   error: (string|null),
 *   errorCategory: ('input'|'algorithm'|'crypto'|null),
 *   whitespaceNormalized: boolean
 * }}
 */
function validate(input, deps) {
    var params = input || {};
    var privKeyID = trim(params.privKeyID);
    var publicKey = trim(params.publicKey);
    var algorithm = trim(params.algorithm) || DEFAULT_ALGORITHM;

    var result = {
        ok: false,
        match: null,
        algorithm: algorithm,
        signature: null,
        error: null,
        errorCategory: null,
        whitespaceNormalized: false
    };

    if (!privKeyID) {
        result.error = 'keyvalidator.error.missing.privkeyid';
        result.errorCategory = 'input';
        return result;
    }
    if (!publicKey) {
        result.error = 'keyvalidator.error.missing.pubkey';
        result.errorCategory = 'input';
        return result;
    }
    if (!looksLikeEncodedPublicKey(publicKey)) {
        result.error = 'keyvalidator.error.malformed.pubkey';
        result.errorCategory = 'input';
        return result;
    }
    if (SUPPORTED_ALGORITHMS.indexOf(algorithm) === -1) {
        result.error = 'keyvalidator.error.unsupported.algorithm';
        result.errorCategory = 'algorithm';
        return result;
    }

    var resolved = deps || defaultDeps();
    var Signature = resolved.Signature;
    var KeyRef = resolved.KeyRef;

    // Detect spaces/tabs inside the key body. Common DKIM operator
    // failure mode: an invisible space pasted in from a source that
    // word-wrapped or tab-padded the key. The platform's base64 decoder
    // tolerates them on this version of SFCC -- verify still succeeds --
    // but the user almost certainly needs to fix their canonical copy
    // of the key (DKIM TXT record, deploy config, etc.) before
    // publishing it anywhere stricter (DKIM verifiers in the wild are
    // not lenient). Surfacing the flag whenever we observe non-newline
    // whitespace gives the user that signal regardless of whether
    // SFCC's own decoder happened to tolerate it.
    var firstPassKey = stripPemArmorAndNewlines(publicKey);
    if (firstPassKey !== stripPemArmorAndAllWhitespace(publicKey)) {
        result.whitespaceNormalized = true;
    }

    try {
        var signer = new Signature();
        var keyRef = new KeyRef(privKeyID);
        var signature = signer.sign(SAMPLE_TEXT, keyRef, algorithm);
        // dw.crypto.Signature.verifySignature can't decode PEM-armored
        // input ("Unable to decode key" InvalidKeyException). Strip
        // armor + newlines first; the platform handles other whitespace
        // (spaces, tabs) fine on this version, and we surface its
        // presence via the whitespaceNormalized flag above so the user
        // can fix their upstream copy.
        var match = signer.verifySignature(signature, SAMPLE_TEXT, firstPassKey, algorithm);

        result.ok = true;
        result.match = !!match;
        result.signature = signature;
        return result;
    } catch (e) {
        result.error = e && e.message ? String(e.message) : String(e);
        result.errorCategory = 'crypto';
        return result;
    }
}

module.exports = {
    validate: validate,
    SUPPORTED_ALGORITHMS: SUPPORTED_ALGORITHMS,
    DEFAULT_ALGORITHM: DEFAULT_ALGORITHM
};
