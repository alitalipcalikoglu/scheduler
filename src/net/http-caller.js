import { CallError, HttpCaller as CoreHttpCaller } from '@atc-web/service-core/http';
import { Signer } from './signer.js';

/** @typedef {import('@atc-web/service-core/http').NetGuard} NetGuard */
/** @typedef {import('../types.js').Target} Target */
/** @typedef {import('../types.js').CallResult} CallResult */

export { CallError };

/**
 * Performs one job call: SSRF guard, bearer token from the named target key, HMAC signature and
 * run headers, pinned address, timeout, bounded response capture. Redirects are not followed.
 * The actual socket work (pinned-address connect, timeout, bounded response read) is
 * service-core's `HttpCaller.send()`; everything above — arbitrary method, bearer-token lookup,
 * scheduler's own signature/headers — is this service's own delivery policy, not generic infra.
 */
export class HttpCaller {
  static USER_AGENT = 'atc-scheduler/1.0';

  /**
   * @param {object} opts
   * @param {Signer} opts.signer
   * @param {NetGuard} opts.guard
   * @param {Map<string, string>} opts.targetKeys
   * @param {() => number} [opts.now]
   */
  constructor({ signer, guard, targetKeys, now = Date.now }) {
    this.signer = signer;
    this.guard = guard;
    this.targetKeys = targetKeys;
    this.now = now;
  }

  /**
   * @param {{ job: string, run: number, attempt: number, target: Target, targetKey: string|null, timeoutMs: number }} call
   * @returns {Promise<CallResult>} 2xx outcome; rejects with {@link CallError} otherwise.
   */
  async call({ job, run, attempt, target, targetKey, timeoutMs }) {
    /** @type {import('@atc-web/service-core/http').VettedTarget} */
    let vetted;
    try {
      vetted = await this.guard.resolve(target.url);
    } catch (err) {
      const e = /** @type {{ code?: string, message: string, retryable?: boolean }} */ (err);
      throw new CallError(e.message, { retryable: e.retryable === true, code: e.code });
    }
    const token = targetKey === null ? undefined : this.targetKeys.get(targetKey);
    if (targetKey !== null && token === undefined) throw new CallError(`target key "${targetKey}" is not configured`, { retryable: false, code: 'UNKNOWN_TARGET_KEY' });
    const hasBody = target.body !== undefined && target.method !== 'GET' && target.method !== 'DELETE';
    const body = hasBody ? JSON.stringify(target.body) : '';
    const now = this.now();
    /** @type {Record<string, string>} */
    const headers = {
      ...target.headers,
      accept: 'application/json, */*;q=0.5',
      'user-agent': HttpCaller.USER_AGENT,
      'x-scheduler-job': job,
      'x-scheduler-run': String(run),
      'x-scheduler-attempt': String(attempt),
      'x-scheduler-timestamp': new Date(now).toISOString(),
      [Signer.HEADER]: this.signer.sign(body, Math.floor(now / 1000)),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...(hasBody ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) } : { 'content-length': '0' }),
    };
    return CoreHttpCaller.send(vetted, target.method, headers, body, timeoutMs);
  }

  /** Whether a failed call with this status may succeed later. @param {number} status */
  static isRetryableStatus(status) {
    return CoreHttpCaller.isRetryableStatus(status);
  }
}
