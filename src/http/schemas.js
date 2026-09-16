/** JSON Schemas for the HTTP surface. Semantic checks (cron, URL, headers) happen in the domain layer. */
export class Schemas {
  static name = { type: 'string', pattern: '^[a-z0-9]+([.\\-_][a-z0-9]+)*$', maxLength: 80 };
  static tags = { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40 } };
  static description = { type: 'string', maxLength: 500 };
  static schedule = {
    type: 'object', additionalProperties: false,
    properties: { cron: { type: 'string', minLength: 1, maxLength: 100 }, timezone: { type: 'string', minLength: 1, maxLength: 64 }, at: { type: 'string', minLength: 20, maxLength: 40 } },
  };
  static target = {
    type: 'object', additionalProperties: false, required: ['url'],
    properties: {
      url: { type: 'string', minLength: 8, maxLength: 2048 },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'get', 'post', 'put', 'patch', 'delete'] },
      headers: { type: 'object', maxProperties: 10, additionalProperties: { type: 'string', maxLength: 1024 }, propertyNames: { maxLength: 64 } },
      body: {},
    },
  };
  static targetKey = { type: ['string', 'null'], maxLength: 64 };
  static timeoutMs = { type: 'integer', minimum: 1, maximum: 3_600_000 };
  static retry = { type: 'object', additionalProperties: false, properties: { max: { type: 'integer', minimum: 0, maximum: 1000 }, backoffSec: { type: 'integer', minimum: 1, maximum: 86_400 } } };

  /**
   * @param {string[]} required
   * @param {Record<string, object>} properties
   */
  static body(required, properties) {
    return { type: 'object', additionalProperties: false, required, properties };
  }

  static create = Schemas.body(['name', 'schedule', 'target'], {
    name: Schemas.name, description: Schemas.description, tags: Schemas.tags, enabled: { type: 'boolean' },
    schedule: Schemas.schedule, target: Schemas.target, targetKey: Schemas.targetKey, timeoutMs: Schemas.timeoutMs, retry: Schemas.retry,
  });
  static patch = {
    type: 'object', additionalProperties: false, minProperties: 1,
    properties: { description: Schemas.description, tags: Schemas.tags, enabled: { type: 'boolean' }, schedule: Schemas.schedule, target: Schemas.target, targetKey: Schemas.targetKey, timeoutMs: Schemas.timeoutMs, retry: Schemas.retry },
  };

  static nameParams = { type: 'object', properties: { name: Schemas.name }, required: ['name'] };
  static idParams = { type: 'object', properties: { id: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } }, required: ['id'] };

  static limit = { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' };
  static listQuery = {
    type: 'object', additionalProperties: false,
    properties: { q: { type: 'string', minLength: 1, maxLength: 120 }, tag: { type: 'string', minLength: 1, maxLength: 40 }, enabled: { type: 'string', enum: ['true', 'false'] }, limit: Schemas.limit, cursor: Schemas.name },
  };
  static runsQuery = {
    type: 'object', additionalProperties: false,
    properties: { status: { type: 'string', enum: ['pending', 'running', 'retrying', 'succeeded', 'failed', 'skipped', 'cancelled'] }, job: Schemas.name, limit: Schemas.limit, before: { type: 'string', pattern: '^[1-9][0-9]{0,15}$' } },
  };
  static previewQuery = {
    type: 'object', additionalProperties: false, required: ['cron'],
    properties: { cron: { type: 'string', minLength: 1, maxLength: 100 }, timezone: { type: 'string', minLength: 1, maxLength: 64 }, count: { type: 'string', pattern: '^([1-9]|[1-4][0-9]|50)$' } },
  };
}
