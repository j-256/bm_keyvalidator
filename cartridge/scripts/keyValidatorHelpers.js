'use strict';

/**
 * Pure presentation helpers for the Key Validator controller. Kept free
 * of dw.* requires so they can be unit-tested under Node.
 */

/**
 * Build the algorithm <option> list for the form. Marks the matching
 * value as selected, defaulting to none-selected if no match.
 */
function buildAlgorithmOptions(algorithms, selected) {
    var options = [];
    for (var i = 0; i < algorithms.length; i++) {
        var alg = algorithms[i];
        options.push({ value: alg, label: alg, selected: alg === selected });
    }
    return options;
}

/**
 * Stripped Base64 length of a SubjectPublicKeyInfo for a given key
 * family + size. Empirically measured against `openssl x509 -pubkey`
 * output -- multiple samples per (family, size) all matched exactly,
 * so these are exact targets, not ranges. Used by the client-side
 * fitness check in show.isml to flag a public-key/alias mismatch
 * before the server round-trip.
 *
 * If a future BM version starts emitting SPKI from a non-canonical
 * encoder, the actual lengths could drift; the fitness check is
 * advisory (warn-level, never blocks submit), so a stale entry here
 * just produces a noisy warning until the table catches up.
 */
var EXPECTED_PUBKEY_LENGTHS = {
    RSA: { 1024: 216, 2048: 392, 3072: 564, 4096: 736 },
    EC:  { 256: 124, 384: 160, 521: 212 }
};

/**
 * Look up the expected stripped Base64 length for a key. Returns
 * null when the family/size combination isn't in the table -- callers
 * should treat null as "no fitness check possible" and stay quiet.
 */
function expectedPubKeyLengthChars(family, keySize) {
    if (!family) return null;
    var f = String(family).toUpperCase();
    var k = parseInt(keySize, 10);
    if (!k) return null;
    if (f === 'RSA') return EXPECTED_PUBKEY_LENGTHS.RSA[k] || null;
    if (f === 'EC' || f === 'ECDSA') return EXPECTED_PUBKEY_LENGTHS.EC[k] || null;
    return null;
}

module.exports = {
    buildAlgorithmOptions: buildAlgorithmOptions,
    EXPECTED_PUBKEY_LENGTHS: EXPECTED_PUBKEY_LENGTHS,
    expectedPubKeyLengthChars: expectedPubKeyLengthChars
};
