import { LitElement, html, css, nothing } from 'lit';
import { Task } from '@lit/task';
import { StandardEvents } from '@shopify/events';
import { DrawerOpenEvent } from '@theme/theme-drawer';
import { ThemeEvents } from '@theme/events';

export class ShippingBannerUpdateEvent extends Event {
  static eventName = 'cart-shipping-banner:update';

  constructor() {
    super(ShippingBannerUpdateEvent.eventName, { bubbles: true });
  }
}

class CartShippingBanner extends LitElement {
  static properties = {
    cartUrl: { attribute: 'data-cart-url' },
    _refreshVersion: { state: true },
    _pendingUpdates: { state: true },
  };

  static styles = css`
    :host, .status { display: contents; }
  `;

  constructor() {
    super();
    this.cartUrl = '';
    this._refreshVersion = 0;
    this._pendingUpdates = 0;
  }

  #cart = new Task(this, {
    args: () => /** @type {[string, number, number]} */ ([this.cartUrl, this._refreshVersion, this._pendingUpdates]),
    task: async ([url, , pendingUpdates], { signal }) => {
      if (!url || pendingUpdates > 0 || !this.isConnected) return false;
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error(`Cart request failed: ${response.status}`);
      const cart = await response.json();
      signal.throwIfAborted();

      // US$2,000 in cents, after discounts. Other presentment currencies are not USD.
      return cart.currency === 'USD' && Number.isFinite(cart.total_price) && cart.total_price >= 200000;
    },
  });

  #listeners = new AbortController();

  connectedCallback() {
    super.connectedCallback();
    this.#listeners.abort();
    this.#listeners = new AbortController();
    this._pendingUpdates = 0;
    const { signal } = this.#listeners;

    document.addEventListener(StandardEvents.cartLinesUpdate, this.#handleCartUpdate, { signal });
    document.addEventListener(StandardEvents.cartDiscountUpdate, this.#handleCartUpdate, { signal });
    const drawer = this.closest('theme-drawer');
    drawer?.addEventListener(DrawerOpenEvent.eventName, this.#refresh, { signal });
    drawer?.addEventListener(ThemeEvents.cartSectionRestored, this.#refresh, { signal });
    this.#refresh();
  }

  updated() {
    this.dispatchEvent(new ShippingBannerUpdateEvent());
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    this.#listeners.abort();
    this.#cart.abort();
  }

  /** @param {import('@shopify/events').CartLinesUpdateEvent | import('@shopify/events').CartDiscountUpdateEvent} event */
  #handleCartUpdate = async (event) => {
    const { signal } = this.#listeners;
    this._pendingUpdates++;

    try {
      // Cart events fire before the mutation finishes; GET must wait for settlement.
      await event.promise;
    } catch {
      // A fresh GET also recovers the actual total after a failed cart mutation.
    } finally {
      if (!signal.aborted) {
        this._pendingUpdates--;
        this.#refresh();
      }
    }
  };

  #refresh = () => {
    this._refreshVersion++;
  };

  render() {
    return html`
      <div class="status" role="status" aria-live="polite" aria-atomic="true">
        ${this.#cart.render({
          complete: (eligible) => eligible ? html`<slot></slot>` : nothing,
        })}
      </div>
    `;
  }
}

if (!customElements.get('cart-shipping-banner-component')) {
  customElements.define('cart-shipping-banner-component', CartShippingBanner);
}
