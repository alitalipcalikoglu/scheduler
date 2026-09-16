import http from 'node:http';
import https from 'node:https';
import { Signer } from './signer.js';

/** @typedef {import('./net-guard.js').NetGuard} NetGuard */
/** @typedef {import('../types.js').Target} Target */
/** @typedef {import('../types.js').CallResult} CallResult */

export class CallError extends Error {
  /**
   * @param {string} message
   * @param {{ httpStatus?: number|null, response?: string, retryable: boolean, code?: string }} info
   */
  constructor(message, info) {
    super(message);
    this.name = 'CallError';
    this.httpStatus = info.httpStatus ?? null;
    this.response = info.response ?? '';
    this.retryable = info.retryable;
    this.code = info.code;
  }
}

/**
 * Performs one job call: SSRF guard, bearer token from the named target key, HMAC signature and
 * run headers, pinned address, timeout, bounded response capture. Redirects are not followed.
 */
export class HttpCaller {
  static USER_AGENT = 'atc-scheduler/1.0';
  static MAX_RESPONSE = 1024;

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
    /** @type {import('./net-guard.js').VettedTarget} */
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
    return this.#send(vetted, target.method, headers, body, timeoutMs);
  }

  /**
   * @param {import('./net-guard.js').VettedTarget} target
   * @param {string} method
   * @param {Record<string, string>} headers
   * @param {string} body
   * @param {number} timeoutMs
   * @returns {Promise<CallResult>}
   */
  #send(target, method, headers, body, timeoutMs) {
    const client = target.url.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const req = client.request(target.url, {
        method,
        headers,
        timeout: timeoutMs,
        // Pin the vetted address; TLS SNI and the Host header still use the hostname.
        lookup: (_host, opts, cb) => (opts.all
          ? cb(null, [{ address: target.address, family: target.family }])
          : cb(null, target.address, target.family)),
      }, (res) => {
        const status = res.statusCode ?? 0;
        /** @type {Buffer[]} */
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          if (size < HttpCaller.MAX_RESPONSE) { chunks.push(c); size += c.length; }
        });
        res.on('end', () => {
          const snippet = Buffer.concat(chunks).toString('utf8', 0, HttpCaller.MAX_RESPONSE).replace(/\s+/g, ' ').trim();
          if (status >= 200 && status < 300) return resolve({ httpStatus: status, response: snippet });
          reject(new CallError(`target responded ${status}${snippet ? `: ${snippet.slice(0, 200)}` : ''}`, { httpStatus: status, response: snippet, retryable: HttpCaller.isRetryableStatus(status) }));
        });
        res.on('error', (err) => reject(new CallError(`response error: ${err.message}`, { retryable: true })));
      });
      req.on('timeout', () => req.destroy(new CallError(`target timed out after ${timeoutMs}ms`, { retryable: true, code: 'TIMEOUT' })));
      req.on('error', (err) => reject(err instanceof CallError ? err : new CallError(`request error: ${err.message}`, { retryable: true, code: /** @type {{ code?: string }} */ (err).code })));
      req.end(body);
    });
  }

  /** Whether a failed call with this status may succeed later. @param {number} status */
  static isRetryableStatus(status) {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
}
