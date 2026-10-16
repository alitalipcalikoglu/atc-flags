import { Ids } from '@atc-web/atc-service-core/ids';
/** JSON Schemas for the HTTP surface. */
export class Schemas {
  static key = { type: 'string', pattern: '^[a-z0-9]+([.\\-_][a-z0-9]+)*$', maxLength: 80 };
  static env = { type: 'string', pattern: '^[a-z][a-z0-9-]{0,31}$' };
  static kind = { type: 'string', enum: ['boolean', 'string', 'number', 'json'] };
  static tags = { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 40 } };
  static description = { type: 'string', maxLength: 500 };
  /** Values are checked against the flag's kind in the domain layer; here anything JSON is accepted. */
  static any = {};

  /**
   * @param {string[]} required
   * @param {Record<string, object>} properties
   */
  static body(required, properties) {
    return { type: 'object', additionalProperties: false, required, properties };
  }

  static create = Schemas.body(['key', 'kind'], { key: Schemas.key, kind: Schemas.kind, description: Schemas.description, tags: Schemas.tags, value: Schemas.any, offValue: Schemas.any, enabled: { type: 'boolean' } });
  static patchFlag = { type: 'object', additionalProperties: false, minProperties: 1, properties: { description: Schemas.description, tags: Schemas.tags, archived: { type: 'boolean' }, reshuffle: { type: 'boolean' } } };
  static patchEnv = {
    type: 'object', additionalProperties: false, minProperties: 1,
    properties: { enabled: { type: 'boolean' }, value: Schemas.any, offValue: Schemas.any, percentage: { type: 'integer', minimum: 0, maximum: 100 }, rules: { type: 'array', maxItems: 100 } },
  };
  static copyEnv = Schemas.body(['to'], { to: Schemas.env });

  static keyParams = { type: 'object', properties: { key: Schemas.key }, required: ['key'] };
  static keyEnvParams = { type: 'object', properties: { key: Schemas.key, env: Schemas.env }, required: ['key', 'env'] };
  static envParams = { type: 'object', properties: { env: Schemas.env }, required: ['env'] };

  static listQuery = {
    type: 'object', additionalProperties: false,
    properties: {
      q: { type: 'string', minLength: 1, maxLength: 120 }, tag: { type: 'string', minLength: 1, maxLength: 40 }, kind: Schemas.kind,
      archived: { type: 'string', enum: ['true', 'false'] },
      limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$' }, cursor: Schemas.key,
    },
  };

  static changeParams = { type: 'object', properties: { id: { type: 'string', pattern: Ids.pattern('chg') } }, required: ['id'] };
  static changesQuery = { type: 'object', additionalProperties: false, properties: { status: { type: 'string', enum: ['pending', 'approved', 'rejected'] }, key: Schemas.key, limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' }, cursor: { type: 'string', pattern: Ids.pattern('chg') } } };
  static rejectChange = { type: ['object', 'null'], additionalProperties: false, properties: { note: { type: 'string', maxLength: 500 } } };
  static historyQuery = { type: 'object', additionalProperties: false, properties: { limit: { type: 'string', pattern: '^([1-9]|[1-9][0-9]|100)$' }, cursor: { type: 'string', pattern: '^[0-9]{1,15}$' } } };

  static context = {
    type: 'object', additionalProperties: false,
    properties: {
      userId: { type: 'string', minLength: 1, maxLength: 128 }, email: { type: 'string', minLength: 3, maxLength: 254 },
      attrs: { type: 'object', maxProperties: 32, additionalProperties: { type: 'string', maxLength: 128 }, propertyNames: { pattern: '^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$' } },
    },
  };
  static evaluateBody = Schemas.body(['env'], { env: Schemas.env, context: Schemas.context, keys: { type: 'array', maxItems: 200, items: Schemas.key }, details: { type: 'boolean' } });
  /** GET form: `?env=prod&userId=u1&email=&attrs.plan=pro&keys=a,b&details=true` (attrs.* accepted via additionalProperties). */
  static evaluateQuery = {
    type: 'object', additionalProperties: { type: 'string', maxLength: 128 }, required: ['env'],
    properties: { env: Schemas.env, userId: { type: 'string', minLength: 1, maxLength: 128 }, email: { type: 'string', maxLength: 254 }, keys: { type: 'string', maxLength: 4_000 }, details: { type: 'string', enum: ['true', 'false'] } },
  };
}
