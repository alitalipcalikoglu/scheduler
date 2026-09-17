import { Signer as CoreSigner } from '@atc-web/service-core/http';

/**
 * HMAC-SHA256 request signing. Header value is `t=<unix seconds>,v1=<hex>` where
 * `v1 = HMAC(secret, "<t>.<raw body>")`; the body is the empty string for requests without one.
 * Receivers use {@link verify} with the raw body bytes they received. Thin, single-secret wrapper
 * over service-core's `Signer` (which generalizes to secret rotation); this service has never
 * needed rotation, so the instance API here still takes exactly one secret.
 */
export class Signer {
  static HEADER = 'x-scheduler-signature';

  /** @param {string} secret */
  constructor(secret) {
    this.secrets = [secret];
  }

  /**
   * @param {string} body
   * @param {number} timestamp Unix seconds.
   */
  sign(body, timestamp) {
    return CoreSigner.sign(body, timestamp, this.secrets);
  }

  /**
   * @param {string} body
   * @param {string} header
   * @param {{ toleranceSec?: number, now?: number }} [opts]
   */
  verify(body, header, opts) {
    return CoreSigner.verify(this.secrets, body, header, opts);
  }
}
