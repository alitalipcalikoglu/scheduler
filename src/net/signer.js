import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 request signing. Header value is `t=<unix seconds>,v1=<hex>` where
 * `v1 = HMAC(secret, "<t>.<raw body>")`; the body is the empty string for requests without one.
 * Receivers use {@link verify} with the raw body bytes they received.
 */
export class Signer {
  static HEADER = 'x-scheduler-signature';

  /** @param {string} secret */
  constructor(secret) {
    this.#secret = secret;
  }

  /** @type {string} */
  #secret;

  /**
   * @param {string} body
   * @param {number} timestamp Unix seconds.
   */
  sign(body, timestamp) {
    return `t=${timestamp},v1=${this.#digest(body, timestamp).toString('hex')}`;
  }

  /**
   * @param {string} body
   * @param {string} header
   * @param {{ toleranceSec?: number, now?: number }} [opts]
   */
  verify(body, header, { toleranceSec = 300, now = Date.now() } = {}) {
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
    if (!m) return false;
    const t = Number(m[1]);
    if (Math.abs(now / 1000 - t) > toleranceSec) return false;
    const expected = this.#digest(body, t);
    const given = Buffer.from(m[2], 'hex');
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  /** @param {string} body @param {number} t */
  #digest(body, t) {
    return createHmac('sha256', this.#secret).update(`${t}.${body}`).digest();
  }
}
