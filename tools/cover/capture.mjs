import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { capture, outputPath, escapeHtml } from './browser.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const output = outputPath(root, 'Render the actual cartridge templates with synthetic Business Manager bindings.');
const require = createRequire(import.meta.url);
const properties = Object.fromEntries((await readFile(new URL('../../cartridge/templates/resources/keyvalidator.properties', import.meta.url), 'utf8'))
  .split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const split = line.indexOf('='); assert.ok(split > 0); return [line.slice(0, split), line.slice(split + 1).replace(/\\u([0-9a-f]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))];
  }));
const Resource = {
  msg(key) { assert.ok(key in properties, `Unknown resource ${key}`); return properties[key]; },
  msgf(key, bundle, fallback, ...args) { return this.msg(key).replace(/''/g, "'").replace(/\{(\d+)\}/g, (_, index) => args[Number(index)]); },
};
const URLUtils = { url: name => `https://cover.invalid/${name}`, staticURL: path => `https://cover.invalid/static${path}` };
let model;
const bindings = {
  'dw/web/CSRFProtection': { getTokenName: () => 'csrf_token', generateToken: () => 'synthetic-capture-token' },
  'dw/template/ISML': { renderTemplate(name, data) { assert.equal(name, 'keyvalidator/show'); model = data; } },
  'dw/system/Logger': { getLogger: () => ({}) }, 'dw/web/Resource': Resource, 'dw/web/URLUtils': URLUtils,
  '*/cartridge/scripts/keyValidator': require('../../cartridge/scripts/keyValidator.js'),
  '*/cartridge/scripts/keyValidatorHelpers': require('../../cartridge/scripts/keyValidatorHelpers.js'),
  '*/cartridge/scripts/certificateFetcher': {},
};
const controller = { exports: {}, request: { httpParameterMap: { get: () => null } },
  require(name) { assert.ok(name in bindings, `Unexpected platform binding ${name}`); return bindings[name]; },
};
vm.runInNewContext(await readFile(new URL('../../cartridge/controllers/KeyValidator.js', import.meta.url), 'utf8'), controller, { timeout: 1000 });
controller.exports.Show();
assert.ok(model);
function render(source, scope = {}) {
  const context = { Resource, URLUtils, pdict: model, ...scope };
  const evaluate = expression => vm.runInNewContext(expression, context, { timeout: 1000 });
  return source
    .replace(/<isloop items="\$\{([^}]+)\}" var="(\w+)">([\s\S]*?)<\/isloop>/g, (_, expression, variable, body) => Array.from(evaluate(expression), item => render(body, { ...scope, [variable]: item })).join(''))
    .replace(/<isif condition="\$\{([^}]+)\}">([\s\S]*?)<iselse\/>\s*([\s\S]*?)<\/isif>/g, (_, expression, yes, no) => evaluate(expression) ? yes : no)
    .replace(/<isprint value="\$\{([^}]+)\}" encoding="off"\/>/g, (_, expression) => String(evaluate(expression)))
    .replace(/\$\{([^}]+)\}/g, (_, expression) => escapeHtml(evaluate(expression)))
    .replace(/<isdecorate[^>]*>|<\/isdecorate>|<iscontent[^>]*>/g, '');
}
const show = await readFile(new URL('../../cartridge/templates/default/keyvalidator/show.isml', import.meta.url), 'utf8');
const layout = await readFile(new URL('../../cartridge/templates/default/keyvalidator/layout.isml', import.meta.url), 'utf8');
const html = `<!doctype html><meta charset="utf-8"><style>body { margin: 0; background: #fff }</style>${render(layout.replace('<isreplace/>', show))}`;
assert.doesNotMatch(html, /<\/?is(?:print|loop|if|replace|decorate|content)\b|\$\{/);
const aliases = ['order-signing', 'inventory-sync', 'site-search', 'customer-export', 'webhook-signing'].map(alias => ({ alias, algorithm: 'RSA', keySize: 2048 }));
await capture({ output, html, colorScheme: 'light', viewport: { width: 1440, height: 1050 },
  async setup(page) {
    await page.route('https://cover.invalid/static/**', async route => {
      const path = new URL(route.request().url()).pathname.slice('/static/'.length);
      assert.ok(!path.includes('..'));
      await route.fulfill({ body: await readFile(new URL(`../../cartridge/static/default/${path}`, import.meta.url)), contentType: path.endsWith('.css') ? 'text/css' : 'font/woff2' });
    });
    await page.route('https://cover.invalid/KeyValidator-Aliases', route => route.fulfill({ json: { ok: true, aliases } }));
  },
  async ready(page) {
    await page.getByRole('heading', { name: 'Keypair Inputs', exact: true }).waitFor();
    await page.waitForFunction(count => document.querySelectorAll('#kv-aliases option').length === count, aliases.length);
    assert.equal(await page.locator('#kv-algorithm option').count(), model.algorithmOptions.length);
  },
});
