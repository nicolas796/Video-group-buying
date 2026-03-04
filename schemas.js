const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

const BRAND_NAME_MAX = 100;

const brandSchema = {
  type: 'object',
  required: ['id', 'name', 'created_at'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 120 },
    name: { type: 'string', minLength: 1, maxLength: BRAND_NAME_MAX },
    created_at: { type: 'string', format: 'date-time' },
    updated_at: { type: ['string', 'null'], format: 'date-time' }
  },
  additionalProperties: true
};

const userSchema = {
  type: 'object',
  required: ['id', 'email', 'password_hash', 'is_super_admin'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 160 },
    email: { type: 'string', format: 'email', maxLength: 320 },
    password_hash: { type: 'string', minLength: 1 },
    brand_id: { anyOf: [{ type: 'string', minLength: 1, maxLength: 160 }, { type: 'null' }] },
    brandId: { anyOf: [{ type: 'string', minLength: 1, maxLength: 160 }, { type: 'null' }] },
    is_super_admin: { type: 'boolean' },
    created_at: { type: ['string', 'null'], format: 'date-time' },
    updated_at: { type: ['string', 'null'], format: 'date-time' }
  },
  additionalProperties: true
};

const campaignSchema = {
  type: 'object',
  required: ['id'],
  properties: {
    id: { type: 'string', minLength: 1, maxLength: 200 },
    name: { type: 'string', minLength: 1 },
    productName: { type: 'string', minLength: 1 },
    brand_id: { type: ['string', 'null'], minLength: 1, maxLength: 160 },
    brandId: { type: ['string', 'null'], minLength: 1, maxLength: 160 },
    created_at: { type: ['string', 'null'], format: 'date-time' },
    updated_at: { type: ['string', 'null'], format: 'date-time' }
  },
  additionalProperties: true
};

const brandValidator = ajv.compile(brandSchema);
const userValidator = ajv.compile(userSchema);
const campaignValidator = ajv.compile(campaignSchema);

class DataValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'DataValidationError';
    this.details = details;
  }
}

function formatAjvErrors(errors = [], prefix = '') {
  return errors.map(err => {
    const path = err.instancePath ? err.instancePath.replace(/^\//, '').replace(/\//g, '.') : '';
    const location = path ? `${prefix}${path}` : prefix || 'record';
    if (err.keyword === 'required' && err.params?.missingProperty) {
      return `${location} is missing required property '${err.params.missingProperty}'`;
    }
    if (err.keyword === 'type' && err.params?.type) {
      return `${location} must be of type ${err.params.type}`;
    }
    if (err.keyword === 'format' && err.params?.format) {
      return `${location} must match format ${err.params.format}`;
    }
    if (err.keyword === 'minLength' && typeof err.params?.limit !== 'undefined') {
      return `${location} must be at least ${err.params.limit} characters`;
    }
    if (err.keyword === 'maxLength' && typeof err.params?.limit !== 'undefined') {
      return `${location} must be at most ${err.params.limit} characters`;
    }
    return `${location} ${err.message}`;
  });
}

function trimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function buildResult(record) {
  return {
    value: record,
    errors: [],
    warnings: [],
    valid: true
  };
}

function validateBrandRecord(record = {}) {
  const candidate = { ...record };
  const result = buildResult(candidate);
  const ok = brandValidator(candidate);
  if (!ok) {
    result.errors.push(...formatAjvErrors(brandValidator.errors, 'brand'));
  }

  candidate.id = trimmed(candidate.id) || candidate.id;
  candidate.name = trimmed(candidate.name || candidate.brandName || candidate.label);

  if (!candidate.name) {
    result.errors.push('brand.name is required');
  } else if (candidate.name.length > BRAND_NAME_MAX) {
    result.errors.push(`brand.name must be <= ${BRAND_NAME_MAX} characters`);
  }

  result.valid = result.errors.length === 0;
  return result;
}

function validateUserRecord(record = {}, options = {}) {
  const { brandIds = new Set(), strictBrandCheck = false } = options;
  const candidate = { ...record };
  const result = buildResult(candidate);

  const ok = userValidator(candidate);
  if (!ok) {
    result.errors.push(...formatAjvErrors(userValidator.errors, 'user'));
  }

  const normalizedBrandId = trimmed(candidate.brand_id || candidate.brandId || '');
  if (normalizedBrandId) {
    candidate.brand_id = normalizedBrandId;
    candidate.brandId = normalizedBrandId;
  } else {
    candidate.brand_id = candidate.brandId = null;
  }

  if (!candidate.is_super_admin && !candidate.brand_id) {
    result.errors.push('user.brand_id is required for non super admins');
  }

  if (candidate.brand_id && brandIds.size && !brandIds.has(candidate.brand_id)) {
    const message = `user.brand_id '${candidate.brand_id}' does not exist`;
    if (strictBrandCheck) {
      result.errors.push(message);
    } else {
      result.warnings.push(message);
    }
  }

  result.valid = result.errors.length === 0;
  return result;
}

function resolveCampaignName(record = {}) {
  return trimmed(record.name || record.productName || record.product_name || record.product_title || '');
}

function validateCampaignRecord(record = {}, options = {}) {
  const { brandIds = new Set(), strictBrandCheck = false } = options;
  const candidate = { ...record };
  const result = buildResult(candidate);

  const ok = campaignValidator(candidate);
  if (!ok) {
    result.errors.push(...formatAjvErrors(campaignValidator.errors, 'campaign'));
  }

  if (candidate.id) {
    candidate.id = trimmed(candidate.id) || candidate.id;
  }

  const name = resolveCampaignName(candidate);
  if (!name) {
    result.errors.push('campaign.name is required');
  }

  const rawBrandId = trimmed(candidate.brand_id || candidate.brandId || '');
  if (!rawBrandId) {
    result.errors.push('campaign.brand_id is required');
  } else {
    candidate.brand_id = rawBrandId;
    candidate.brandId = rawBrandId;
    if (brandIds.size && !brandIds.has(rawBrandId)) {
      const message = `campaign.brand_id '${rawBrandId}' does not exist`;
      if (strictBrandCheck) {
        result.errors.push(message);
      } else {
        result.warnings.push(message);
      }
    }
  }

  result.valid = result.errors.length === 0;
  return result;
}

module.exports = {
  validateBrandRecord,
  validateUserRecord,
  validateCampaignRecord,
  formatAjvErrors,
  DataValidationError,
  BRAND_NAME_MAX,
  resolveCampaignName
};
