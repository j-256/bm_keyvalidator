'use strict';

/**
 * Business Manager controller for the Key Validator extension.
 *
 * Pipeline-style (classic) controller. Marked .public for BM dispatcher.
 * Intentionally has no SFRA / app_storefront_base dependency so the
 * cartridge stands alone in a BM cartridge path.
 */

var CSRFProtection = require('dw/web/CSRFProtection');
var ISML = require('dw/template/ISML');
var Logger = require('dw/system/Logger');
var Resource = require('dw/web/Resource');
var URLUtils = require('dw/web/URLUtils');

var keyValidator = require('*/cartridge/scripts/keyValidator');
var certificateFetcher = require('*/cartridge/scripts/certificateFetcher');
var helpers = require('*/cartridge/scripts/keyValidatorHelpers');

var LOG = Logger.getLogger('keyvalidator', 'KeyValidator');
var TEMPLATE = 'keyvalidator/show';

function expose(handler) {
    var wrapped = function () {
        return handler.apply(this, arguments);
    };
    wrapped.public = true;
    return wrapped;
}

function readParam(name) {
    var map = request.httpParameterMap;
    if (!map) return '';
    var param = map.get(name);
    if (!param) return '';
    var val = param.stringValue;
    return val == null ? '' : String(val);
}

function render(model) {
    ISML.renderTemplate(TEMPLATE, model);
}

function bmContext() {
    return {
        mainmenuname: readParam('mainmenuname') || 'Operations',
        menuname: readParam('menuname') || Resource.msg('keyvalidator.page.title', 'keyvalidator', 'Key Validator'),
        CurrentMenuItemId: readParam('CurrentMenuItemId') || 'operations'
    };
}

// Server-rendered string bags handed to the template, embedded into
// the page as JSON literals for the inline JS to consume. Keeping
// these in the controller (rather than an <isscript> in the template)
// is just hygiene -- isscript is generally discouraged, and the
// keys-of-strings-to-Resource.msg shape has zero ISML-specific need.
function buildNoticeMessages() {
    function m(key) { return Resource.msg(key, 'keyvalidator', null); }
    return {
        // Empty-state copy (split into three keys so the client can render
        // an <a> between segments; see show.isml's form-help <p> for the
        // matching server-side composition).
        emptyBefore:        m('keyvalidator.aliases.empty.before'),
        emptyLinkText:      m('keyvalidator.aliases.empty.linkText'),
        emptyAfter:         m('keyvalidator.aliases.empty.after'),
        populatedSingular:  m('keyvalidator.aliases.populated.singular'),
        // Plural is a {0}-substitute template; the client does the substitution.
        populatedPlural:    m('keyvalidator.aliases.populated.plural'),
        no_session:         m('keyvalidator.aliases.error.no_session'),
        invalid_client:     m('keyvalidator.aliases.error.invalid_client'),
        invalid_grant:      m('keyvalidator.aliases.error.invalid_grant'),
        unauthorized:       m('keyvalidator.aliases.error.unauthorized'),
        unavailable:        m('keyvalidator.aliases.error.unavailable'),
        timeout:            m('keyvalidator.aliases.error.timeout'),
        unknown:            m('keyvalidator.aliases.error.unknown'),
        strippedClean:      m('keyvalidator.form.pubkey.stripped.clean'),
        strippedSpaces:     m('keyvalidator.form.pubkey.stripped.spaces'),
        // {0} = expected length, {1} = "<family> / <size>", {2} = actual stripped length
        fitnessLengthMismatch: m('keyvalidator.form.pubkey.fitness.lengthMismatch'),
        // {0} = "<family> / <size>"
        fitnessFamilyMismatch: m('keyvalidator.form.pubkey.fitness.familyMismatch')
    };
}

function buildResultMessages() {
    function m(key) { return Resource.msg(key, 'keyvalidator', null); }
    return {
        heading:            m('keyvalidator.result.heading'),
        matchTitle:         m('keyvalidator.result.match.title'),
        matchBody:          m('keyvalidator.result.match.body'),
        mismatchTitle:      m('keyvalidator.result.mismatch.title'),
        mismatchBody:       m('keyvalidator.result.mismatch.body'),
        errorTitle:         m('keyvalidator.result.error.title'),
        errorDetails:       m('keyvalidator.result.error.details'),
        metaAlgorithm:      m('keyvalidator.result.meta.algorithm'),
        networkError:       m('keyvalidator.result.error.network'),
        whitespaceAdvisory: m('keyvalidator.result.advisory.whitespace')
    };
}

function baseModel(form) {
    var algorithm = form && form.algorithm ? form.algorithm : keyValidator.DEFAULT_ALGORITHM;
    var bm = bmContext();
    var privateKeysUrl = URLUtils.url('ViewApplication-BM',
        'screen', 'PrivateKey',
        'SelectedMenuItem', 'operations_certificates',
        'CurrentMenuItemId', 'operations').toString();
    return {
        title: Resource.msg('keyvalidator.page.title', 'keyvalidator', 'Key Validator'),
        actionUrl: URLUtils.url('KeyValidator-Verify').toString(),
        aliasesUrl: URLUtils.url('KeyValidator-Aliases').toString(),
        // Deep-link target for the BM "Private Keys and Certificates"
        // page. Mirrors the URL the Operations menu uses, so this lands
        // wherever the operator's instance puts it without us having to
        // hardcode the host. Surfaced from the form help text (server-
        // rendered) and the alias-dropdown empty state (client-rendered
        // via the linksJson literal embedded into the page).
        privateKeysUrl: privateKeysUrl,
        // JSON literals embedded into the page for the inline JS to
        // consume. Built server-side so locale resolution and URL
        // construction stay on the controller side, and the template
        // gets a single <isprint encoding="off"> per bag.
        noticeMessagesJson: JSON.stringify(buildNoticeMessages()),
        resultMessagesJson: JSON.stringify(buildResultMessages()),
        linksJson: JSON.stringify({ privateKeys: privateKeysUrl }),
        // Lookup table the public-key fitness check uses to compare the
        // pasted key's stripped Base64 length against what's expected
        // for the picked alias's family + size. Owned by the helper
        // module so it's unit-testable.
        expectedPubKeyLengthsJson: JSON.stringify(helpers.EXPECTED_PUBKEY_LENGTHS),
        csrfTokenName: CSRFProtection.getTokenName(),
        csrfTokenValue: CSRFProtection.generateToken(),
        mainmenuname: bm.mainmenuname,
        menuname: bm.menuname,
        CurrentMenuItemId: bm.CurrentMenuItemId,
        SelectedMenuItem: bm.CurrentMenuItemId,
        CurrentPipelineName: 'KeyValidator',
        CurrentStartNodeName: 'Show',
        form: {
            privKeyID: form && form.privKeyID ? form.privKeyID : '',
            publicKey: form && form.publicKey ? form.publicKey : '',
            algorithm: algorithm
        },
        defaults: {
            algorithm: keyValidator.DEFAULT_ALGORITHM
        },
        algorithmOptions: helpers.buildAlgorithmOptions(keyValidator.SUPPORTED_ALGORITHMS, algorithm),
        result: null
    };
}

exports.Show = expose(function () {
    render(baseModel(null));
});

/**
 * Builds a full "Cookie" header from every cookie on the inbound request.
 * The dwsid:dwsecuretoken grant relies on more than just dwsid -- the
 * secure-token cookie is HttpOnly so it isn't visible to JS, but it IS
 * exposed on the server-side request. Forwarding the whole jar lets AM
 * verify whatever combination it currently requires.
 */
function buildForwardCookieHeader() {
    var cookies = request.getHttpCookies();
    if (!cookies) return '';
    var n = cookies.getCookieCount();
    var parts = [];
    for (var i = 0; i < n; i++) {
        var c = cookies[i];
        if (!c) continue;
        var name = c.getName();
        var value = c.getValue();
        if (!name) continue;
        parts.push(name + '=' + (value == null ? '' : value));
    }
    return parts.join('; ');
}

/**
 * Reads the inbound request's cookie jar, forwards it to AM in exchange
 * for an OCAPI bearer token, and returns the list of imported private-key
 * aliases as JSON. The browser fetches this on page load to populate the
 * autocomplete datalist next to the privKeyID input.
 *
 * Always responds 200 with a structured body (never throws) so the
 * client-side script can render a graceful warning instead of an error.
 */
exports.Aliases = expose(function () {
    response.setContentType('application/json;charset=UTF-8');
    // setExpires(0) is enough to disable caching on this response.
    // Cache-Control is reserved by the platform: setHttpHeader on it throws.
    response.setExpires(0);

    var cookieHeader = buildForwardCookieHeader();
    var result;
    try {
        result = certificateFetcher.fetchAliases(cookieHeader);
    } catch (e) {
        LOG.error('KeyValidator-Aliases unexpected failure: {0}', e && e.message ? e.message : e);
        result = { ok: false, error: 'unknown', aliases: null };
    }

    if (result.error === 'no_session' || result.error === 'invalid_grant' || result.error === 'unauthorized') {
        LOG.info('Aliases fetch refused by AM: {0}', result.error);
    } else if (!result.ok) {
        LOG.warn('Aliases fetch failed: {0}', result.error);
    }

    response.getWriter().print(JSON.stringify(result));
});

exports.Verify = expose(function () {
    var form = {
        privKeyID: readParam('privKeyID'),
        publicKey: readParam('publicKey'),
        algorithm: readParam('algorithm')
    };

    // Diagnostic: log every submission so an operator can audit which keys
    // were checked, see the public-key bytes for cross-referencing with
    // openssl, etc. None of these fields are secret -- alias is a public
    // identifier, public keys are public by definition, algorithm is
    // metadata. Lands in customlog "keyvalidator" / category "KeyValidator".
    LOG.info('Verify submission alias="{0}" algorithm="{1}" publicKey={2}',
        form.privKeyID, form.algorithm, form.publicKey);

    var validation;
    if (!CSRFProtection.validateRequest()) {
        LOG.warn('KeyValidator: CSRF token validation failed');
        validation = {
            ok: false,
            match: null,
            algorithm: form.algorithm || keyValidator.DEFAULT_ALGORITHM,
            signature: null,
            error: 'keyvalidator.error.csrf',
            errorCategory: 'input'
        };
    } else {
        try {
            validation = keyValidator.validate(form);
        } catch (e) {
            LOG.error('Unexpected failure in keyValidator.validate: {0}', e && e.message ? e.message : e);
            validation = {
                ok: false,
                match: null,
                algorithm: form.algorithm || keyValidator.DEFAULT_ALGORITHM,
                signature: null,
                error: e && e.message ? String(e.message) : String(e),
                errorCategory: 'crypto'
            };
        }
    }

    if (validation.errorCategory === 'crypto') {
        LOG.warn('KeyValidator crypto failure for keyId="{0}" alg="{1}": {2}',
            form.privKeyID, validation.algorithm, validation.error);
    } else if (validation.ok && validation.match === false) {
        LOG.info('KeyValidator: keys do not match for keyId="{0}" alg="{1}"',
            form.privKeyID, validation.algorithm);
    }

    // Split the error into a short, user-readable message and an
    // optional detail blob with the raw underlying message (typically a
    // Java exception chain). Translated user-error keys go straight to
    // errorMessage with no detail. Crypto exceptions get a generic short
    // message plus the raw exception in errorDetail (rendered collapsed
    // by the client) so a user isn't greeted with a stack trace by
    // default but can drill in if they want to.
    var errorMessage = null;
    var errorDetail = null;
    if (validation.error) {
        if (validation.errorCategory === 'input' || validation.errorCategory === 'algorithm') {
            errorMessage = Resource.msg(validation.error, 'keyvalidator', validation.error);
        } else {
            errorMessage = Resource.msg('keyvalidator.result.error.crypto.summary', 'keyvalidator',
                'The cryptographic operation failed. See details below.');
            errorDetail = validation.error;
        }
    }

    response.setContentType('application/json;charset=UTF-8');
    response.setExpires(0);
    response.getWriter().print(JSON.stringify({
        ok: validation.ok,
        match: validation.match,
        algorithm: validation.algorithm,
        errorCategory: validation.errorCategory,
        errorMessage: errorMessage,
        errorDetail: errorDetail,
        whitespaceNormalized: !!validation.whitespaceNormalized
    }));
});
