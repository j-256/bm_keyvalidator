'use strict';

var test = require('node:test');
var assert = require('node:assert/strict');
var path = require('node:path');

var helpers = require(path.join(__dirname, '..', '..', 'cartridge', 'scripts', 'keyValidatorHelpers.js'));

test('buildAlgorithmOptions: maps each algorithm to {value, label, selected}', function () {
    var opts = helpers.buildAlgorithmOptions(['A', 'B', 'C'], 'B');
    assert.deepEqual(opts, [
        { value: 'A', label: 'A', selected: false },
        { value: 'B', label: 'B', selected: true },
        { value: 'C', label: 'C', selected: false }
    ]);
});

test('buildAlgorithmOptions: no match -> all selected:false', function () {
    var opts = helpers.buildAlgorithmOptions(['A', 'B'], 'NOPE');
    assert.equal(opts.filter(function (o) { return o.selected; }).length, 0);
});

test('buildAlgorithmOptions: empty algorithms list -> []', function () {
    assert.deepEqual(helpers.buildAlgorithmOptions([], 'A'), []);
});

test('buildAlgorithmOptions: only the first match is marked selected when duplicates exist', function () {
    // Defensive shape: SUPPORTED_ALGORITHMS shouldn't have duplicates,
    // but if it does, the simple === comparison would mark every match.
    // Pin current behavior so a future refactor doesn't accidentally
    // change it without thinking.
    var opts = helpers.buildAlgorithmOptions(['X', 'Y', 'X'], 'X');
    assert.deepEqual(opts.map(function (o) { return o.selected; }), [true, false, true]);
});

// ----- expectedPubKeyLengthChars / EXPECTED_PUBKEY_LENGTHS -----
//
// Pin the empirically-measured table values so a typo here gets caught
// at npm test time rather than via a silent UX regression where the
// fitness-check warn fires on a perfectly valid key (or, worse, doesn't
// fire when it should). See keyValidatorHelpers.js for measurement
// methodology -- these came from `openssl x509 -pubkey -noout` against
// freshly-generated keypairs at each (family, size).

test('EXPECTED_PUBKEY_LENGTHS exposes the measured RSA values', function () {
    assert.equal(helpers.EXPECTED_PUBKEY_LENGTHS.RSA[1024], 216);
    assert.equal(helpers.EXPECTED_PUBKEY_LENGTHS.RSA[2048], 392);
    assert.equal(helpers.EXPECTED_PUBKEY_LENGTHS.RSA[3072], 564);
    assert.equal(helpers.EXPECTED_PUBKEY_LENGTHS.RSA[4096], 736);
});

test('EXPECTED_PUBKEY_LENGTHS exposes the measured EC values', function () {
    assert.equal(helpers.EXPECTED_PUBKEY_LENGTHS.EC[256], 124);
    assert.equal(helpers.EXPECTED_PUBKEY_LENGTHS.EC[384], 160);
    assert.equal(helpers.EXPECTED_PUBKEY_LENGTHS.EC[521], 212);
});

test('expectedPubKeyLengthChars: RSA returns the table value', function () {
    assert.equal(helpers.expectedPubKeyLengthChars('RSA', 2048), 392);
    assert.equal(helpers.expectedPubKeyLengthChars('rsa', 4096), 736);
});

test('expectedPubKeyLengthChars: EC accepts both "EC" and "ECDSA" family strings', function () {
    // certificate_search emits "EC"; the cartridge accepts "ECDSA" defensively
    // for forward-compat with any future platform vocabulary change.
    assert.equal(helpers.expectedPubKeyLengthChars('EC', 256), 124);
    assert.equal(helpers.expectedPubKeyLengthChars('ECDSA', 256), 124);
});

test('expectedPubKeyLengthChars: keySize accepts string or number', function () {
    assert.equal(helpers.expectedPubKeyLengthChars('RSA', '2048'), 392);
    assert.equal(helpers.expectedPubKeyLengthChars('RSA', 2048), 392);
});

test('expectedPubKeyLengthChars: unknown family returns null', function () {
    assert.equal(helpers.expectedPubKeyLengthChars('DSA', 2048), null);
    assert.equal(helpers.expectedPubKeyLengthChars('Ed25519', 256), null);
});

test('expectedPubKeyLengthChars: unknown size for known family returns null', function () {
    assert.equal(helpers.expectedPubKeyLengthChars('RSA', 1536), null);
    assert.equal(helpers.expectedPubKeyLengthChars('EC', 192), null);
});

test('expectedPubKeyLengthChars: missing/empty inputs return null', function () {
    assert.equal(helpers.expectedPubKeyLengthChars(null, 2048), null);
    assert.equal(helpers.expectedPubKeyLengthChars('', 2048), null);
    assert.equal(helpers.expectedPubKeyLengthChars('RSA', null), null);
    assert.equal(helpers.expectedPubKeyLengthChars('RSA', 0), null);
    assert.equal(helpers.expectedPubKeyLengthChars('RSA', 'not-a-number'), null);
});
