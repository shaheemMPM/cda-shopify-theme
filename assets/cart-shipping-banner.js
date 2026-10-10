import { Component } from '@theme/component';
import { StandardEvents } from '@shopify/events';
import { DrawerOpenEvent } from '@theme/theme-drawer';
import { ThemeEvents } from '@theme/events';

export class ShippingBannerUpdateEvent extends Event {
  static eventName = 'cart-shipping-banner:update';

  constructor() {
    super(ShippingBannerUpdateEvent.eventName, { bubbles: true });
  }
}

class CartShippingBanner extends Component {
  #listeners = new AbortController();
  /** @type {AbortController | undefined} */
  #request;
  #pendingUpdates = 0;
  #eligible = false;

  connectedCallback() {
    super.connectedCallback();
    this.#listeners.abort();
    this.#listeners = new AbortController();
    this.#pendingUpdates = 0;
    const { signal } = this.#listeners;

    document.addEventListener(StandardEvents.cartLinesUpdate, this.#handleCartUpdate, { signal });
    document.addEventListener(StandardEvents.cartDiscountUpdate, this.#handleCartUpdate, { signal });
    const drawer = this.closest('theme-drawer');
    drawer?.addEventListener(DrawerOpenEvent.eventName, this.#refresh, { signal });
    drawer?.addEventListener(ThemeEvents.cartSectionRestored, this.#refresh, { signal });
    this.#refresh();
  }

  updatedCallback() {
    super.updatedCallback();
    this.#render();
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#listeners.abort();
    this.#request?.abort();
  }

  /** @param {import('@shopify/events').CartLinesUpdateEvent | import('@shopify/events').CartDiscountUpdateEvent} event */
  #handleCartUpdate = async (event) => {
    const { signal } = this.#listeners;
    this.#pendingUpdates++;
    this.#request?.abort();
    this.#eligible = false;
    this.#render();

    try {
      // Cart events fire before the mutation finishes; GET must wait for settlement.
      await event.promise;
    } catch {
      // A fresh GET also recovers the actual total after a failed cart mutation.
    } finally {
      if (!signal.aborted) {
        this.#pendingUpdates--;
        if (this.#pendingUpdates === 0) this.#refresh();
      }
    }
  };

  #refresh = async () => {
    if (!this.isConnected || this.#pendingUpdates > 0) return;
    const cartUrl = this.dataset.cartUrl;
    if (!cartUrl) return;
    this.#request?.abort();
    const request = new AbortController();
    this.#request = request;

    try {
      const response = await fetch(cartUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal: request.signal,
      });
      if (!response.ok) throw new Error(`Cart request failed: ${response.status}`);
      const cart = await response.json();
      if (request.signal.aborted || !this.isConnected) return;

      // Ajax money values are in subunits: US$2,000 = 200,000 cents, after discounts.
      // Keep this USD demo from treating another presentment currency as US dollars.
      this.#eligible = cart.currency === 'USD' && Number.isFinite(cart.total_price) && cart.total_price >= 200000;
      this.#render();
    } catch (error) {
      if (request.signal.aborted || !this.isConnected) return;
      this.#eligible = false;
      this.#render();
      console.warn('[cart-shipping-banner] Unable to check eligibility:', error);
    }
  };

  #render() {
    this.hidden = !this.#eligible;
    this.dispatchEvent(new ShippingBannerUpdateEvent());
  }
}

if (!customElements.get('cart-shipping-banner-component')) {
  customElements.define('cart-shipping-banner-component', CartShippingBanner);
}
