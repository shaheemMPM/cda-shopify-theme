import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';
import { Window } from 'happy-dom';

const window = new Window({ url: 'https://workroom.example/' });
for (const key of Object.getOwnPropertyNames(window)) {
  if (/^(HTML|SVG)/.test(key) || ['window', 'document', 'customElements', 'HTMLElement', 'Element', 'Node', 'Document', 'DocumentFragment', 'ShadowRoot', 'CSSStyleSheet', 'DOMParser', 'Event', 'CustomEvent'].includes(key)) {
    Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
  }
}

// Use the shipped Lit bundle and real Horizon morph algorithm. Only unrelated
// drawer behaviour and Shopify's externally hosted event names are stand-ins.
const fixtures = {
  '@shopify/events': `export const StandardEvents = {cartLinesUpdate: 'shopify:cart:lines-update', cartDiscountUpdate: 'shopify:cart:discount-update'};`,
  '@theme/theme-drawer': `export class DrawerOpenEvent {static eventName = 'theme-drawer:open';}`,
  '@theme/component': `export class Component extends HTMLElement {updatedCallback() {}}`,
};
const { outputFiles } = await build({
  stdin: {
    contents: `import './assets/cart-shipping-banner.js'; export {morph} from './assets/morph.js'; export {LitElement} from './assets/lit-runtime.js';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  format: 'esm',
  platform: 'browser',
  write: false,
  plugins: [{
    name: 'theme-importmap',
    setup(build) {
      build.onResolve({ filter: /^(lit$|@lit\/task$|@theme\/|@shopify\/events$)/ }, ({ path }) => {
        if (path in fixtures) return { path, namespace: 'fixture' };
        const asset = path.startsWith('@theme/') ? path.slice(7) : 'lit-runtime';
        return { path: `${process.cwd()}/assets/${asset}.js` };
      });
      build.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: fixtures[path] }));
    },
  }],
});
const { morph, LitElement } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);

let requests = [];
globalThis.fetch = (url, options) => new Promise((resolve, reject) => {
  requests.push({ url, options, resolve, reject });
});

const markup = (url = '/fr/cart.js', text = 'Eligible for free shipping') =>
  `<cart-shipping-banner-component data-cart-url="${url}"><div class="cart-shipping-banner">${text}</div></cart-shipping-banner-component>`;

async function flush() {
  await setImmediate();
}

async function mount() {
  const drawer = document.createElement('theme-drawer');
  drawer.innerHTML = markup();
  document.body.append(drawer);
  const banner = drawer.firstElementChild;
  await flush();
  assert.ok(banner instanceof LitElement);
  return { drawer, banner };
}

const visible = (banner) => Boolean(banner.shadowRoot.querySelector('slot'));
async function answer(request, total_price, currency = 'USD') {
  request.resolve({ ok: true, json: async () => ({ total_price, currency }) });
  await flush();
}
async function reopen(drawer) {
  drawer.dispatchEvent(new Event('theme-drawer:open'));
  await flush();
}
function mutation(type = 'shopify:cart:lines-update') {
  const event = new Event(type);
  const deferred = Promise.withResolvers();
  event.promise = deferred.promise;
  document.dispatchEvent(event);
  return deferred;
}

afterEach(async () => {
  document.body.replaceChildren();
  await flush();
  requests = [];
});

test('locale-aware GET, USD threshold boundaries, invalid totals and empty cart', async () => {
  const { drawer, banner } = await mount();
  assert.equal(requests[0].url, '/fr/cart.js');
  assert.equal(requests[0].options.method, 'GET');
  assert.equal(requests[0].options.cache, 'no-store');
  assert.equal(visible(banner), false);
  for (const [total, currency, expected] of [
    [199999, 'USD', false], [200000, 'USD', true], [200001, 'USD', true],
    [999999, 'EUR', false], ['200000', 'USD', false], [0, 'USD', false],
  ]) {
    await reopen(drawer);
    await answer(requests.at(-1), total, currency);
    assert.equal(visible(banner), expected, `${total} ${currency}`);
  }
  assert.equal(banner.shadowRoot.querySelectorAll('[role="status"]').length, 1);
});

test('waits for overlapping cart and discount mutations, including rejected mutations', async () => {
  const { banner } = await mount();
  await answer(requests.at(-1), 219000);
  const lines = mutation();
  const discount = mutation('shopify:cart:discount-update');
  await flush();
  assert.equal(visible(banner), false);
  const count = requests.length;
  lines.resolve({});
  await flush();
  assert.equal(requests.length, count);
  discount.resolve({});
  await flush();
  assert.equal(requests.length, count + 1);
  await answer(requests.at(-1), 190000);
  assert.equal(visible(banner), false);
  const failed = mutation();
  failed.reject(new Error('Mutation failed'));
  await flush();
  await answer(requests.at(-1), 219000);
  assert.equal(visible(banner), true);
});

test('ignores late responses, hides on network/HTTP failure, and recovers on reopen', async () => {
  const { drawer, banner } = await mount();
  const old = requests.at(-1);
  await reopen(drawer);
  assert.equal(old.options.signal.aborted, true);
  await answer(requests.at(-1), 190000);
  await answer(old, 250000);
  assert.equal(visible(banner), false);
  await reopen(drawer);
  requests.at(-1).reject(new Error('Offline'));
  await flush();
  assert.equal(visible(banner), false);
  await reopen(drawer);
  requests.at(-1).resolve({ ok: false, status: 500 });
  await flush();
  assert.equal(visible(banner), false);
  await reopen(drawer);
  await answer(requests.at(-1), 200000);
  assert.equal(visible(banner), true);
});

test('keeps Lit rendering alive through Horizon morphs and updates Liquid copy and URL', async () => {
  const { drawer, banner } = await mount();
  await answer(requests.at(-1), 219000);
  const shadow = banner.shadowRoot;
  for (let index = 0; index < 3; index++) {
    morph(drawer, `<theme-drawer>${markup('/fr/cart.js', `Translated heading ${index}`)}</theme-drawer>`);
    await flush();
    assert.equal(drawer.firstElementChild, banner);
    assert.equal(banner.shadowRoot, shadow);
    assert.equal(visible(banner), true);
    assert.match(banner.shadowRoot.querySelector('slot').assignedElements()[0].textContent, /Translated heading/);
  }
  morph(drawer, `<theme-drawer>${markup('/de/cart.js')}</theme-drawer>`);
  await flush();
  assert.equal(requests.at(-1).url, '/de/cart.js');
  await answer(requests.at(-1), 0);
  assert.equal(visible(banner), false);
});

test('cleans up requests/listeners and refreshes after reconnect and cart section restoration', async () => {
  const { drawer, banner } = await mount();
  const pending = requests.at(-1);
  banner.remove();
  assert.equal(pending.options.signal.aborted, true);
  const count = requests.length;
  await reopen(drawer);
  assert.equal(requests.length, count);
  drawer.append(banner);
  await flush();
  assert.equal(requests.length, count + 1);
  await answer(requests.at(-1), 219000);
  drawer.dispatchEvent(new Event('cart-section:restored'));
  await flush();
  await answer(requests.at(-1), 0);
  assert.equal(visible(banner), false);
  const change = mutation();
  await flush();
  banner.remove();
  drawer.append(banner);
  await flush();
  const afterReconnect = requests.length;
  change.resolve({});
  await flush();
  assert.equal(requests.length, afterReconnect, 'Old listeners cannot refresh the reconnected component');
  await answer(requests.at(-1), 200000);
  assert.equal(visible(banner), true);
});
