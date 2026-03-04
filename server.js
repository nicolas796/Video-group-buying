const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');
const bcrypt = require('bcrypt');
const { loadUsers, loadBrands, saveBrands, loadCampaigns } = require('./data-store');
const { validateBrandRecord, validateUserRecord, validateCampaignRecord, DataValidationError, resolveCampaignName } = require('./schemas');
const { createBackupSync, listBackupsSync, resolveBackupPath } = require('./backup-manager');

const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';
const CSP_REPORT_ENDPOINT = process.env.CSP_REPORT_ENDPOINT || '/csp-report';
const CSP_REPORT_ONLY = (process.env.CSP_REPORT_ONLY || '').trim().toLowerCase() === 'true';
const CSP_INLINE_SCRIPT_HASHES = [
    "'sha256-2bGHMrl77eVSsuQU10LbbN1Qrqb73iE3YP1+L9igUJI='",
    "'sha256-rr65mWwZJnb5bUhQe/lNU42AdlfN1rEFOtlIf3NGatw='",
    "'sha256-KSRRsZ+kzH2uXHwYEr4gQoONH5uXlxvjQwjGtsu+ORA='"
];
const CSP_SCRIPT_SRC = [
    "'self'",
    'https://cdn.jsdelivr.net',
    ...CSP_INLINE_SCRIPT_HASHES
].join(' ');
const CSP_POLICY_DIRECTIVES = [
    "default-src 'self'",
    `script-src ${CSP_SCRIPT_SRC}`,
    "script-src-attr 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "img-src 'self' data: https:",
    "media-src 'self' https: blob:",
    "font-src 'self' data:",
    "connect-src 'self' https://api.twilio.com",
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    `report-uri ${CSP_REPORT_ENDPOINT}`
];
const CSP_POLICY = CSP_POLICY_DIRECTIVES.join('; ');
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_REFERRALS_NEEDED = 2;
const MAX_REFERRALS = 10;
const DEFAULT_CAMPAIGN_PAGE = 1;
const DEFAULT_CAMPAIGN_LIMIT = 50;
const MAX_CAMPAIGN_LIMIT = 100;
// Tiered rate limiting constants
const RATE_LIMIT_GET_MAX = 100;        // 100 GET requests per minute
const RATE_LIMIT_WRITE_MAX = 30;       // 30 POST/PUT/DELETE requests per minute
const RATE_LIMIT_WINDOW = 60000;       // 1 minute window

// Map to store tiered rate limits: { ip => { get: [...timestamps], write: [...timestamps], lastRequest: timestamp } }
const tieredRateLimitMap = new Map();

const ALLOWED_COUNTRY_CODES = (process.env.ALLOWED_COUNTRY_CODES || '1')
    .split(',')
    .map(code => code.trim())
    .filter(Boolean);
const SORTED_COUNTRY_CODES = [...ALLOWED_COUNTRY_CODES].sort((a, b) => b.length - a.length);
const PHONE_E164_REGEX = /^\+?[1-9]\d{9,14}$/;
const EMAIL_REGEX = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;
const CAMPAIGN_ID_REGEX = /^[A-Za-z0-9_-]{6,32}$/;
const REFERRAL_CODE_REGEX = /^[A-F0-9]{8}$/i;
const HSTS_HEADER_VALUE = 'max-age=31536000; includeSubDomains';
const FORCE_HTTPS = (() => {
    const flag = (process.env.FORCE_HTTPS || '').trim().toLowerCase();
    if (flag === 'true') return true;
    if (flag === 'false') return false;
    return NODE_ENV === 'production';
})();
const HTTPS_EXEMPT_HOSTS = (process.env.HTTPS_EXEMPT_HOSTS || 'localhost,127.0.0.1')
    .split(',')
    .map(host => host.trim().toLowerCase())
    .filter(Boolean);
const SESSION_COOKIE_NAME = 'gb_session';
const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const AUTH_TOKEN_COOKIE = 'gb_auth_token';
const AUTH_TOKEN_TTL_MS = SESSION_TTL_MS;
const CSRF_HEADER_NAME = 'x-csrf-token';
const DEFAULT_DEV_JWT_SECRET = 'dev-only-group-buying-secret';
const JWT_SECRET = (() => {
    const secret = (process.env.JWT_SECRET || '').trim();
    if (secret) {
        return secret;
    }
    if (NODE_ENV === 'production') {
        throw new Error('JWT_SECRET environment variable is required in production');
    }
    console.warn('[Auth] JWT_SECRET not set. Using development fallback secret.');
    return DEFAULT_DEV_JWT_SECRET;
})();
const sessionStore = new Map();
const INITIAL_ADMIN_EMAIL = (process.env.INITIAL_ADMIN_EMAIL || '').trim().toLowerCase();
const INITIAL_ADMIN_PASSWORD = process.env.INITIAL_ADMIN_PASSWORD || '';
const INITIAL_ADMIN_BRAND = (process.env.INITIAL_ADMIN_BRAND || '').trim();

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PATHS = {
    config: path.join(DATA_DIR, 'config.json'),
    participants: path.join(DATA_DIR, 'participants.json'),
    optouts: path.join(DATA_DIR, 'optouts.json'),
    campaigns: path.join(DATA_DIR, 'campaigns.json'),
    stats: path.join(DATA_DIR, 'stats.json'),
    notifySubscribers: path.join(DATA_DIR, 'notify-subscribers.json'),
    cspReportsLog: path.join(DATA_DIR, 'csp-reports.log'),
    brands: path.join(DATA_DIR, 'brands.json'),
    users: path.join(DATA_DIR, 'users.json')
};

const RESTORE_TARGETS = {
    brands: { path: PATHS.brands, invalidate: (reason) => invalidateBrandCache(reason) },
    users: { path: PATHS.users, invalidate: (reason) => invalidateUserCache(reason) },
    campaigns: { path: PATHS.campaigns },
    participants: { path: PATHS.participants },
    config: { path: PATHS.config }
};

const BRAND_CACHE_TTL_MS = 60 * 1000;
const USER_CACHE_TTL_MS = 30 * 1000;

const cacheState = {
    brands: { data: null, expiresAt: 0, hits: 0, misses: 0 },
    users: { data: null, expiresAt: 0, hits: 0, misses: 0 }
};


const DEFAULT_CONFIG = {
    initialBuyers: 500,
    initialPrice: 80,
    checkoutUrl: '',
    priceTiers: [{buyers: 100, price: 40, couponCode: ''}, {buyers: 500, price: 30, couponCode: ''}, {buyers: 1000, price: 20, couponCode: ''}],
    countdownEnd: '2026-02-20T14:00:00-05:00',
    videoSource: 'https://vod.estreamly.com/assets/994758e3-c35f-4e26-9512-1babf10b6207/HLS/jUVhs_DTuiA6FDuYM_720.m3u8',
    product: { image: '', name: '', description: '' },
    twilio: { accountSid: '', authToken: '', phoneNumber: '', enabled: false },
    referralsNeeded: DEFAULT_REFERRALS_NEEDED,
    domain: 'https://your-domain.com'
};

function logCacheEvent(name, event) {
    const stats = cacheState[name];
    if (!stats) return;
    const message = `[Cache] ${name} ${event} (hits=${stats.hits} misses=${stats.misses})`;
    if (typeof console.debug === 'function') {
        console.debug(message);
    } else {
        console.log(message);
    }
}

function invalidateBrandCache(reason = 'manual') {
    cacheState.brands.data = null;
    cacheState.brands.expiresAt = 0;
    if (reason) {
        logCacheEvent('brands', `invalidated:${reason}`);
    }
}

function invalidateUserCache(reason = 'manual') {
    cacheState.users.data = null;
    cacheState.users.expiresAt = 0;
    if (reason) {
        logCacheEvent('users', `invalidated:${reason}`);
    }
}

function getBrandsFromCache({ forceRefresh = false } = {}) {
    const now = Date.now();
    const cache = cacheState.brands;
    if (!forceRefresh && cache.data && now < cache.expiresAt) {
        cache.hits += 1;
        logCacheEvent('brands', 'hit');
        return cache.data;
    }
    cache.misses += 1;
    const records = readBrandStore().brands;
    cache.data = records;
    cache.expiresAt = now + BRAND_CACHE_TTL_MS;
    logCacheEvent('brands', 'miss');
    return records;
}

function getUsersFromCache({ forceRefresh = false } = {}) {
    const now = Date.now();
    const cache = cacheState.users;
    if (!forceRefresh && cache.data && now < cache.expiresAt) {
        cache.hits += 1;
        logCacheEvent('users', 'hit');
        return cache.data;
    }
    cache.misses += 1;
    const records = readUserStore({ strictBrandCheck: forceRefresh }).users;
    cache.data = records;
    cache.expiresAt = now + USER_CACHE_TTL_MS;
    logCacheEvent('users', 'miss');
    return records;
}

function logValidationIssues(entity, filePath, recordId, issues = [], level = 'warn') {
    if (!issues.length) return;
    const base = `[Data Validation] ${entity} (${path.basename(filePath)}${recordId ? `:${recordId}` : ''})`;
    issues.forEach(issue => {
        const message = `${base} ${issue}`;
        if (level === 'error') {
            console.error(message);
        } else {
            console.warn(message);
        }
    });
}

const ajv = new Ajv({ allErrors: true, strict: false, allowUnionTypes: true });
addFormats(ajv);

const priceTierSchema = {
    type: 'object',
    required: ['buyers', 'price'],
    properties: {
        buyers: { type: 'integer', minimum: 0 },
        price: { type: 'number', minimum: 0 },
        couponCode: { type: 'string', minLength: 0, maxLength: 64 }
    },
    additionalProperties: false
};

const twilioSchema = {
    type: 'object',
    required: ['enabled', 'accountSid', 'authToken', 'phoneNumber', 'domain'],
    properties: {
        enabled: { type: 'boolean' },
        accountSid: { type: 'string', minLength: 0 },
        authToken: { type: 'string', minLength: 0 },
        phoneNumber: { type: 'string', minLength: 0 },
        domain: { type: 'string', minLength: 0 }
    },
    additionalProperties: false
};

const pricingSchema = {
    type: 'object',
    required: ['initialPrice', 'initialBuyers', 'tiers'],
    properties: {
        initialPrice: { type: 'number', minimum: 0 },
        initialBuyers: { type: 'integer', minimum: 0 },
        checkoutUrl: { type: 'string', minLength: 0 },
        tiers: {
            type: 'array',
            minItems: 1,
            items: priceTierSchema
        }
    },
    additionalProperties: true
};

const campaignSchema = {
    type: 'object',
    required: ['id', 'productName', 'productImage', 'productDescription', 'videoUrl', 'twilio', 'pricing', 'referralsNeeded', 'countdownEnd', 'description', 'price', 'originalPrice', 'imageUrl', 'sharesRequired', 'discountPercentage', 'merchantName', 'merchantLogo', 'initialBuyers', 'priceTiers'],
    properties: {
        id: { type: 'string', pattern: CAMPAIGN_ID_REGEX.source },
        productName: { type: 'string', minLength: 1 },
        productImage: { type: 'string', minLength: 1 },
        productDescription: { type: 'string', minLength: 1 },
        videoUrl: { type: 'string', minLength: 1 },
        twilio: twilioSchema,
        pricing: pricingSchema,
        referralsNeeded: { type: 'integer', minimum: 1, maximum: MAX_REFERRALS },
        countdownEnd: { type: 'string', format: 'date-time' },
        description: { type: 'string', minLength: 1 },
        price: { type: 'number', minimum: 0 },
        originalPrice: { type: 'number', minimum: 0 },
        imageUrl: { type: 'string', minLength: 0 },
        sharesRequired: { type: 'integer', minimum: 1, maximum: MAX_REFERRALS },
        discountPercentage: { type: 'number', minimum: 0, maximum: 100 },
        merchantName: { type: 'string', minLength: 0 },
        merchantLogo: { type: 'string', minLength: 0 },
        initialBuyers: { type: 'integer', minimum: 0 },
        priceTiers: {
            type: 'array',
            minItems: 1,
            items: priceTierSchema
        },
        termsUrl: { type: 'string', minLength: 0 }
    },
    additionalProperties: true
};

const validateCampaignSchema = ajv.compile(campaignSchema);

class CampaignValidationError extends Error {
    constructor(message, details = [], statusCode = 400) {
        super(message);
        this.name = 'CampaignValidationError';
        this.statusCode = statusCode;
        this.details = details;
    }
}

function describePath(instancePath = '', campaignId = null) {
    if (!instancePath && !campaignId) return 'campaign';
    const normalizedPath = instancePath ? instancePath.replace(/\//g, '.').replace(/^\./, '') : '';
    if (campaignId) {
        return normalizedPath ? `${campaignId}.${normalizedPath}` : campaignId;
    }
    return normalizedPath || 'campaign';
}

function formatValidationErrors(errors = [], campaignId = null) {
    if (!errors.length) return [];
    return errors.map(error => {
        const location = describePath(error.instancePath || '', campaignId);
        if (error.keyword === 'required' && error.params?.missingProperty) {
            return `${location} is missing required property '${error.params.missingProperty}'`;
        }
        if (error.keyword === 'type' && error.params?.type) {
            return `${location} must be of type ${error.params.type}`;
        }
        if (error.keyword === 'pattern') {
            return `${location} ${error.message}`;
        }
        if ((error.keyword === 'minimum' || error.keyword === 'maximum') && typeof error.params?.limit !== 'undefined') {
            return `${location} ${error.message}`;
        }
        if (error.keyword === 'additionalProperties' && error.params?.additionalProperty) {
            return `${location} has unsupported property '${error.params.additionalProperty}'`;
        }
        return `${location} ${error.message}`;
    });
}

function ensureCampaignValid(campaign, { context = 'campaign', statusCode = 400 } = {}) {
    const candidate = { ...campaign };
    if (candidate.id === undefined || candidate.id === null) {
        throw new CampaignValidationError(`Invalid ${context} data`, ['campaign.id is required'], statusCode);
    }
    candidate.id = typeof candidate.id === 'string' ? candidate.id : String(candidate.id);
    const isValid = validateCampaignSchema(candidate);
    if (!isValid) {
        const details = formatValidationErrors(validateCampaignSchema.errors, candidate.id || null);
        throw new CampaignValidationError(`Invalid ${context} data`, details, statusCode);
    }
    return candidate;
}

function validateCampaignCollection(rawCampaigns = {}, { throwOnError = false } = {}) {
    const campaigns = {};
    const errors = [];

    for (const [campaignId, data] of Object.entries(rawCampaigns)) {
        if (!data || typeof data !== 'object') {
            errors.push({ campaignId, errors: [`${campaignId} is not a valid campaign object`] });
            continue;
        }
        const candidate = { ...data };
        if (candidate.id === undefined || candidate.id === null) {
            errors.push({ campaignId, errors: ['campaign.id is missing'] });
            continue;
        }
        candidate.id = typeof candidate.id === 'string' ? candidate.id : String(candidate.id);

        if (candidate.id !== campaignId) {
            errors.push({ campaignId, errors: [`campaign.id (${candidate.id}) must match key ${campaignId}`] });
            continue;
        }

        const isValid = validateCampaignSchema(candidate);
        if (!isValid) {
            errors.push({ campaignId, errors: formatValidationErrors(validateCampaignSchema.errors, campaignId) });
            continue;
        }

        campaigns[campaignId] = candidate;
    }

    if (errors.length) {
        const message = `Invalid campaign data found in ${PATHS.campaigns}`;
        if (throwOnError) {
            throw new CampaignValidationError(message, errors, 500);
        }
        console.error(`[Campaign Validation] ${message}`);
        errors.forEach(entry => {
            console.error(`  - ${entry.campaignId}: ${entry.errors.join('; ')}`);
        });
    }

    return { campaigns, errors };
}


function defaultDataForKey(key) {
    switch (key) {
        case 'config':
            return DEFAULT_CONFIG;
        case 'campaigns':
            return { campaigns: [] };
        case 'stats':
            return {};
        case 'brands':
            return { brands: [] };
        case 'users':
            return { users: [] };
        default:
            return [];
    }
}

function initializeFiles() {
    Object.entries(PATHS).forEach(([key, filePath]) => {
        if (fs.existsSync(filePath)) return;
        if (key === 'cspReportsLog') {
            fs.writeFileSync(filePath, '');
            return;
        }
        const defaultData = defaultDataForKey(key);
        writeJson(filePath, defaultData);
    });
}
initializeFiles();
const BCRYPT_ROUNDS = 12;

function generateBrandId() {
    return `brand_${crypto.randomBytes(6).toString('hex')}`;
}

function generateUserId() {
    return `user_${crypto.randomBytes(6).toString('hex')}`;
}

function hashPassword(password) {
    if (!password) return null;
    return bcrypt.hashSync(String(password), BCRYPT_ROUNDS);
}

function verifyPassword(password, stored) {
    if (!password || !stored) return false;
    try {
        return bcrypt.compareSync(String(password), stored);
    } catch (error) {
        return false;
    }
}

function normalizeBrandRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const now = new Date().toISOString();
    return {
        id: record.id || generateBrandId(),
        name: (record.name || 'Untitled Brand').trim(),
        created_at: record.created_at || now,
        updated_at: record.updated_at || record.created_at || now
    };
}

function readBrandStore() {
    const data = readJson(PATHS.brands) || { brands: [] };
    const source = Array.isArray(data)
        ? data
        : Array.isArray(data.brands)
            ? data.brands
            : [];
    const seenIds = new Set();
    const brands = [];

    source.forEach(entry => {
        const normalized = normalizeBrandRecord(entry);
        if (!normalized) return;
        const result = validateBrandRecord(normalized);
        const identifier = normalized.id || normalized.name || 'unknown';
        if (!result.valid) {
            logValidationIssues('brand', PATHS.brands, identifier, result.errors, 'error');
            return;
        }
        if (result.warnings.length) {
            logValidationIssues('brand', PATHS.brands, identifier, result.warnings, 'warn');
        }
        if (seenIds.has(normalized.id)) {
            logValidationIssues('brand', PATHS.brands, identifier, ['Duplicate brand id skipped'], 'warn');
            return;
        }
        seenIds.add(normalized.id);
        brands.push(normalized);
    });

    return { brands };
}

function writeBrandStore(brands) {
    const normalized = [];
    const errors = [];
    const warnings = [];
    const seenIds = new Set();

    (brands || []).forEach(entry => {
        const candidate = normalizeBrandRecord(entry);
        if (!candidate) return;
        const result = validateBrandRecord(candidate);
        const identifier = candidate.id || candidate.name || 'unknown';
        if (!result.valid) {
            result.errors.forEach(err => errors.push(`${identifier}: ${err}`));
            return;
        }
        if (seenIds.has(candidate.id)) {
            errors.push(`${identifier}: duplicate brand id`);
            return;
        }
        seenIds.add(candidate.id);
        if (result.warnings.length) {
            result.warnings.forEach(warn => warnings.push(`${identifier}: ${warn}`));
        }
        normalized.push(candidate);
    });

    if (errors.length) {
        throw new DataValidationError('Invalid brand data', errors);
    }
    if (warnings.length) {
        logValidationIssues('brand', PATHS.brands, null, warnings, 'warn');
    }

    writeJson(PATHS.brands, { brands: normalized });
    cacheState.brands.data = normalized;
    cacheState.brands.expiresAt = Date.now() + BRAND_CACHE_TTL_MS;
    logCacheEvent('brands', 'refresh');
    return normalized;
}

function toBrandList(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) {
        return payload.map(normalizeBrandRecord).filter(Boolean);
    }
    if (Array.isArray(payload.brands)) {
        return payload.brands.map(normalizeBrandRecord).filter(Boolean);
    }
    return [];
}

function buildBrandsPayload(source, brands) {
    if (Array.isArray(source)) {
        return { brands };
    }
    if (source && typeof source === 'object') {
        return { ...source, brands };
    }
    return { brands };
}

function toCampaignList(payload) {
    if (!payload) return [];
    if (Array.isArray(payload)) {
        return payload.map(normalizeCampaignRecord).filter(Boolean);
    }
    if (Array.isArray(payload.campaigns)) {
        return payload.campaigns.map(normalizeCampaignRecord).filter(Boolean);
    }
    if (typeof payload === 'object') {
        return Object.values(payload).map(normalizeCampaignRecord).filter(Boolean);
    }
    return [];
}

function countCampaignsByBrand(campaigns) {
    return campaigns.reduce((acc, campaign) => {
        const brandId = campaign?.brand_id || campaign?.brandId;
        if (!brandId) return acc;
        acc[brandId] = (acc[brandId] || 0) + 1;
        return acc;
    }, {});
}

function runIntegrityChecks({ log = false } = {}) {
    const brands = getBrands({ forceRefresh: true });
    const brandIds = new Set(brands.map(brand => brand.id).filter(Boolean));
    const campaigns = listCampaignRecords();
    const users = getUsers({ forceRefresh: true });
    const orphanedCampaigns = campaigns
        .filter(campaign => {
            const brandId = getCampaignBrandId(campaign);
            return Boolean(brandId) && !brandIds.has(brandId);
        })
        .map(campaign => ({
            id: campaign.id,
            brand_id: getCampaignBrandId(campaign),
            name: campaign.productName || resolveCampaignName(campaign) || null
        }));
    const invalidUserBrands = users
        .filter(user => user.brand_id && !brandIds.has(user.brand_id))
        .map(user => ({ id: user.id, email: user.email, brand_id: user.brand_id }));
    if (log) {
        if (orphanedCampaigns.length === 0 && invalidUserBrands.length === 0) {
            console.log('[Integrity] All brand references are valid');
        } else {
            orphanedCampaigns.forEach(issue => {
                console.warn(`[Integrity] Campaign ${issue.id} references missing brand ${issue.brand_id}`);
            });
            invalidUserBrands.forEach(issue => {
                console.warn(`[Integrity] User ${issue.email || issue.id} references missing brand ${issue.brand_id}`);
            });
        }
    }
    return {
        checkedAt: new Date().toISOString(),
        counts: {
            brands: brands.length,
            campaigns: campaigns.length,
            users: users.length
        },
        issues: {
            orphanedCampaigns,
            invalidUserBrands
        }
    };
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        let aborted = false;
        req.on('data', chunk => {
            if (aborted) {
                return;
            }
            body += chunk;
            if (body.length > 1e6) {
                aborted = true;
                reject(new Error('Payload too large'));
            }
        });
        req.on('end', () => {
            if (aborted) {
                return;
            }
            if (!body) {
                return resolve({});
            }
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function getBrands(options = {}) {
    return getBrandsFromCache(options);
}

function getBrandById(brandId) {
    if (!brandId) return null;
    return getBrands().find(brand => brand.id === brandId) || null;
}

function getBrandIdSet(options = {}) {
    return new Set(getBrands(options).map(brand => brand.id).filter(Boolean));
}

function normalizeUserRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const now = new Date().toISOString();
    const email = typeof record.email === 'string' ? record.email.trim().toLowerCase() : '';
    const username = typeof record.username === 'string' ? record.username.trim() : null;
    return {
        id: record.id || generateUserId(),
        email,
        username,
        name: record.name || null,
        password_hash: record.password_hash || record.passwordHash || null,
        brand_id: record.brand_id || record.brandId || null,
        is_super_admin: Boolean(record.is_super_admin || record.isSuperAdmin),
        created_at: record.created_at || now,
        updated_at: record.updated_at || record.created_at || now
    };
}

function readUserStore({ strictBrandCheck = false } = {}) {
    const data = readJson(PATHS.users) || { users: [] };
    const source = Array.isArray(data)
        ? data
        : Array.isArray(data.users)
            ? data.users
            : [];
    const brandIds = getBrandIdSet({ forceRefresh: strictBrandCheck });
    const users = [];

    source.forEach(entry => {
        const normalized = normalizeUserRecord(entry);
        if (!normalized) return;
        const result = validateUserRecord(normalized, { brandIds, strictBrandCheck });
        const identifier = normalized.id || normalized.email || 'unknown';
        if (!result.valid) {
            logValidationIssues('user', PATHS.users, identifier, result.errors, 'error');
            return;
        }
        if (result.warnings.length) {
            logValidationIssues('user', PATHS.users, identifier, result.warnings, 'warn');
        }
        users.push(result.value);
    });

    return { users };
}

function writeUserStore(users) {
    const brandIds = getBrandIdSet({ forceRefresh: true });
    const normalized = [];
    const errors = [];

    (users || []).forEach(entry => {
        const candidate = normalizeUserRecord(entry);
        if (!candidate) return;
        const result = validateUserRecord(candidate, { brandIds, strictBrandCheck: true });
        const identifier = candidate.id || candidate.email || 'unknown';
        if (!result.valid) {
            result.errors.forEach(err => errors.push(`${identifier}: ${err}`));
            return;
        }
        normalized.push(result.value);
    });

    if (errors.length) {
        throw new DataValidationError('Invalid user data', errors);
    }

    writeJson(PATHS.users, { users: normalized });
    cacheState.users.data = normalized;
    cacheState.users.expiresAt = Date.now() + USER_CACHE_TTL_MS;
    logCacheEvent('users', 'refresh');
    return normalized;
}

function getUsers(options = {}) {
    return getUsersFromCache(options);
}

function getUserById(userId) {
    if (!userId) return null;
    return getUsers().find(user => user.id === userId) || null;
}

function ensureTenantDefaults() {
    const brandStore = readBrandStore();
    let brands = brandStore.brands;
    if (!brands.length) {
        const now = new Date().toISOString();
        const defaultBrand = { id: generateBrandId(), name: 'Default Brand', created_at: now, updated_at: now };
        brands = [defaultBrand];
        writeBrandStore(brands);
    }
    const userStore = readUserStore();
    if (!userStore.users.length) {
        if (!INITIAL_ADMIN_EMAIL || !INITIAL_ADMIN_PASSWORD) {
            const message = 'No admin users found. Set INITIAL_ADMIN_EMAIL and INITIAL_ADMIN_PASSWORD to seed a super admin account.';
            console.error(`[Setup] ${message}`);
            throw new Error(message);
        }
        const preferredBrand = brands.find(brand => brand.id === INITIAL_ADMIN_BRAND);
        const brandId = preferredBrand ? preferredBrand.id : brands[0]?.id || null;
        const now = new Date().toISOString();
        const defaultUser = {
            id: generateUserId(),
            email: INITIAL_ADMIN_EMAIL,
            username: INITIAL_ADMIN_EMAIL,
            password_hash: hashPassword(INITIAL_ADMIN_PASSWORD),
            brand_id: brandId,
            is_super_admin: true,
            created_at: now,
            updated_at: now
        };
        writeUserStore([defaultUser]);
        const brandSuffix = brandId ? ` for brand ${brandId}` : '';
        console.log(`[Setup] Created initial super admin ${INITIAL_ADMIN_EMAIL}${brandSuffix}`);
    }
}

ensureTenantDefaults();

function createBrand(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) {
        const error = new Error('Brand name is required');
        error.statusCode = 400;
        throw error;
    }
    const store = readBrandStore();
    const exists = store.brands.find(brand => brand.name.toLowerCase() === trimmed.toLowerCase());
    if (exists) {
        const error = new Error('Brand name must be unique');
        error.statusCode = 409;
        throw error;
    }
    const now = new Date().toISOString();
    const brand = { id: generateBrandId(), name: trimmed, created_at: now, updated_at: now };
    store.brands.push(brand);
    writeBrandStore(store.brands);
    return brand;
}

function updateBrand(brandId, updates = {}) {
    const store = readBrandStore();
    const index = store.brands.findIndex(brand => brand.id === brandId);
    if (index === -1) return null;
    const next = { ...store.brands[index] };
    if (typeof updates.name === 'string') {
        const trimmed = updates.name.trim();
        if (!trimmed) {
            const error = new Error('Brand name is required');
            error.statusCode = 400;
            throw error;
        }
        const duplicate = store.brands.find(brand => brand.id !== brandId && brand.name.toLowerCase() === trimmed.toLowerCase());
        if (duplicate) {
            const error = new Error('Brand name must be unique');
            error.statusCode = 409;
            throw error;
        }
        next.name = trimmed;
    }
    next.updated_at = new Date().toISOString();
    store.brands[index] = next;
    writeBrandStore(store.brands);
    return next;
}

function createUserRecord({ email, username, password, brandId, isSuperAdmin = false, name = null }) {
    const normalizedEmail = (email || '').trim().toLowerCase();
    const normalizedUsername = username ? username.trim() : null;
    if (!normalizedEmail && !normalizedUsername) {
        const error = new Error('Email or username is required');
        error.statusCode = 400;
        throw error;
    }
    if (!password) {
        const error = new Error('Password is required');
        error.statusCode = 400;
        throw error;
    }
    const users = getUsers();
    if (normalizedEmail && users.some(user => user.email === normalizedEmail)) {
        const error = new Error('Email already in use');
        error.statusCode = 409;
        throw error;
    }
    if (normalizedUsername && users.some(user => user.username && user.username.toLowerCase() === normalizedUsername.toLowerCase())) {
        const error = new Error('Username already in use');
        error.statusCode = 409;
        throw error;
    }
    if (!isSuperAdmin && !brandId) {
        const error = new Error('brandId is required for non super admins');
        error.statusCode = 400;
        throw error;
    }
    if (brandId && !getBrandById(brandId)) {
        const error = new Error('Brand not found');
        error.statusCode = 404;
        throw error;
    }
    const now = new Date().toISOString();
    const record = {
        id: generateUserId(),
        email: normalizedEmail,
        username: normalizedUsername,
        name,
        password_hash: hashPassword(password),
        brand_id: brandId || null,
        is_super_admin: Boolean(isSuperAdmin),
        created_at: now,
        updated_at: now
    };
    const nextUsers = [...users, record];
    writeUserStore(nextUsers);
    return record;
}

function updateUserRecord(userId, updates = {}) {
    const store = readUserStore();
    const index = store.users.findIndex(user => user.id === userId);
    if (index === -1) return null;
    const next = { ...store.users[index] };
    if (typeof updates.email === 'string') {
        const normalizedEmail = updates.email.trim().toLowerCase();
        if (!normalizedEmail) {
            const error = new Error('Email cannot be empty');
            error.statusCode = 400;
            throw error;
        }
        if (store.users.some(user => user.id !== userId && user.email === normalizedEmail)) {
            const error = new Error('Email already in use');
            error.statusCode = 409;
            throw error;
        }
        next.email = normalizedEmail;
    }
    if (typeof updates.username === 'string') {
        const normalizedUsername = updates.username.trim();
        if (store.users.some(user => user.id !== userId && user.username && user.username.toLowerCase() === normalizedUsername.toLowerCase())) {
            const error = new Error('Username already in use');
            error.statusCode = 409;
            throw error;
        }
        next.username = normalizedUsername;
    }
    if (typeof updates.name === 'string') {
        next.name = updates.name.trim();
    }
    if (typeof updates.is_super_admin === 'boolean') {
        if (!updates.is_super_admin) {
            const otherSupers = store.users.filter(user => user.id !== userId && user.is_super_admin);
            if (otherSupers.length === 0) {
                const error = new Error('At least one super admin is required');
                error.statusCode = 400;
                throw error;
            }
        }
        next.is_super_admin = updates.is_super_admin;
    }
    if (Object.prototype.hasOwnProperty.call(updates, 'brand_id') || Object.prototype.hasOwnProperty.call(updates, 'brandId')) {
        const desiredBrand = updates.brand_id || updates.brandId || null;
        if (!next.is_super_admin && !desiredBrand) {
            const error = new Error('brandId is required for non super admins');
            error.statusCode = 400;
            throw error;
        }
        if (desiredBrand && !getBrandById(desiredBrand)) {
            const error = new Error('Brand not found');
            error.statusCode = 404;
            throw error;
        }
        next.brand_id = desiredBrand;
    }
    if (updates.password) {
        next.password_hash = hashPassword(updates.password);
    }
    next.updated_at = new Date().toISOString();
    store.users[index] = next;
    writeUserStore(store.users);
    return next;
}

function sanitizeUser(user) {
    if (!user) return null;
    const brand = user.brand_id ? getBrandById(user.brand_id) : null;
    return {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        brandId: user.brand_id || null,
        brand: brand ? { id: brand.id, name: brand.name } : null,
        isSuperAdmin: Boolean(user.is_super_admin),
        createdAt: user.created_at,
        updatedAt: user.updated_at
    };
}

function buildUserAdminResponse(user, brandMap = null) {
    if (!user) return null;
    const brandId = user.brand_id || null;
    let brandName = null;
    if (brandId) {
        if (brandMap && brandMap.has(brandId)) {
            brandName = brandMap.get(brandId);
        } else {
            const brand = getBrandById(brandId);
            brandName = brand ? brand.name : null;
        }
    }
    return {
        id: user.id,
        email: user.email,
        brand_id: brandId,
        brand_name: brandName,
        is_super_admin: Boolean(user.is_super_admin),
        created_at: user.created_at || null
    };
}

function base64UrlEncode(value) {
    return Buffer.from(value, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
    if (!value || typeof value !== 'string') return '';
    let normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    while (normalized.length % 4) {
        normalized += '=';
    }
    return Buffer.from(normalized, 'base64').toString('utf8');
}

function buildAuthPayload(user) {
    const issuedAt = Date.now();
    return {
        user_id: user.id,
        brand_id: user.brand_id || null,
        is_super_admin: Boolean(user.is_super_admin),
        timestamp: issuedAt,
        iat: issuedAt,
        exp: issuedAt + AUTH_TOKEN_TTL_MS
    };
}

function base64UrlFromBuffer(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function createTokenSignature(input) {
    return base64UrlFromBuffer(crypto.createHmac('sha256', JWT_SECRET).update(input).digest());
}

function timingSafeCompare(expected, actual) {
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const actualBuffer = Buffer.from(actual, 'utf8');
    if (expectedBuffer.length !== actualBuffer.length) {
        return false;
    }
    return crypto.timingSafeEqual(expectedBuffer, actualBuffer);
}

function signToken(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Cannot sign empty payload');
    }
    const headerSegment = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payloadSegment = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const signatureSegment = createTokenSignature(signingInput);
    return `${signingInput}.${signatureSegment}`;
}

function verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerSegment, payloadSegment, signatureSegment] = parts;
    try {
        const header = JSON.parse(base64UrlDecode(headerSegment));
        if ((header?.alg || '').toUpperCase() !== 'HS256') {
            return null;
        }
    } catch (error) {
        return null;
    }
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const expectedSignature = createTokenSignature(signingInput);
    if (!timingSafeCompare(expectedSignature, signatureSegment)) {
        return null;
    }
    try {
        return JSON.parse(base64UrlDecode(payloadSegment));
    } catch (error) {
        return null;
    }
}

function encodeAuthToken(user) {
    return signToken(buildAuthPayload(user));
}

function decodeAuthToken(token) {
    return verifyToken(token);
}

function setAuthTokenCookie(res, token, isSecure) {
    if (!token) return;
    const attributes = [
        `${AUTH_TOKEN_COOKIE}=${token}`,
        'HttpOnly',
        'Path=/',
        `Max-Age=${Math.floor(AUTH_TOKEN_TTL_MS / 1000)}`,
        'SameSite=Strict'
    ];
    if (isSecure) {
        attributes.push('Secure');
    }
    appendSetCookieHeader(res, attributes.join('; '));
}

function clearAuthTokenCookie(res, isSecure) {
    const attributes = [
        `${AUTH_TOKEN_COOKIE}=` ,
        'HttpOnly',
        'Path=/',
        'Max-Age=0',
        'SameSite=Strict'
    ];
    if (isSecure) {
        attributes.push('Secure');
    }
    appendSetCookieHeader(res, attributes.join('; '));
}

function getTokenFromHeader(req) {
    const header = req.headers?.authorization;
    if (!header || typeof header !== 'string') return null;
    const [scheme, value] = header.split(' ');
    if (!scheme || !value) return null;
    if (scheme.trim().toLowerCase() !== 'bearer') return null;
    return value.trim();
}

function getTokenFromCookies(req) {
    const cookies = parseCookies(req?.headers?.cookie || '');
    return cookies[AUTH_TOKEN_COOKIE] || null;
}

function extractAuthToken(req) {
    return getTokenFromHeader(req) || getTokenFromCookies(req) || null;
}

async function loadAllUsers({ forceRefresh = false } = {}) {
    if (forceRefresh) {
        invalidateUserCache('force-refresh');
    }
    return getUsers({ forceRefresh });
}

async function findUserByEmail(email) {
    const normalized = (email || '').trim().toLowerCase();
    if (!normalized) return null;
    const users = await loadAllUsers();
    return users.find(user => user.email === normalized) || null;
}

async function findUserById(userId) {
    if (!userId) return null;
    const users = await loadAllUsers();
    return users.find(user => user.id === userId) || null;
}

async function resolveRequestUser(req) {
    if (req.user) return req.user;
    const token = extractAuthToken(req);
    if (!token) return null;
    const payload = decodeAuthToken(token);
    if (!payload?.user_id) return null;
    const now = Date.now();
    if (payload.exp && now > payload.exp) {
        return null;
    }
    if (!payload.exp && payload.timestamp && (now - payload.timestamp) > AUTH_TOKEN_TTL_MS) {
        return null;
    }
    const user = await findUserById(payload.user_id);
    if (!user) return null;
    req.user = user;
    req.authToken = { raw: token, payload };
    if (req.session) {
        req.session.userId = user.id;
        req.session.brandId = user.brand_id || null;
        req.session.isSuperAdmin = Boolean(user.is_super_admin);
    }
    return user;
}

async function requireAuth(req, res, { superAdminOnly = false } = {}) {
    const user = await resolveRequestUser(req);
    if (!user) {
        setNoCacheHeaders(res);
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication required' }));
        return null;
    }
    if (superAdminOnly && !user.is_super_admin) {
        setNoCacheHeaders(res);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Super admin access required' }));
        return null;
    }
    return user;
}

async function requireSuperAdmin(req, res) {
    return requireAuth(req, res, { superAdminOnly: true });
}

async function requireBrandAccess(req, res, brandId) {
    const user = await requireAuth(req, res);
    if (!user) return null;
    if (user.is_super_admin) return user;
    const normalizedTarget = brandId || user.brand_id || null;
    if (!normalizedTarget || normalizedTarget === user.brand_id) {
        return user;
    }
    setNoCacheHeaders(res);
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Brand access denied' }));
    return null;
}

function getUserBrandId(user) {
    if (!user || typeof user !== 'object') return null;
    return user.brand_id || user.brandId || null;
}

function getCampaignBrandId(campaign) {
    if (!campaign || typeof campaign !== 'object') return null;
    return campaign.brand_id || campaign.brandId || null;
}

function canUserAccessCampaign(user, campaign) {
    if (!user || !campaign) return false;
    if (user.is_super_admin) return true;
    return getUserBrandId(user) === getCampaignBrandId(campaign);
}

async function requireCampaignAccess(req, res, campaignId, { denyAsNotFound = false } = {}) {
    const user = await requireAuth(req, res);
    if (!user) return null;
    let campaign;
    try {
        campaign = getCampaign(campaignId);
    } catch (error) {
        sendJsonError(res, error);
        return null;
    }
    if (!campaign) {
        setNoCacheHeaders(res);
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Campaign not found' }));
        return null;
    }
    if (!canUserAccessCampaign(user, campaign)) {
        const statusCode = denyAsNotFound ? 404 : 403;
        setNoCacheHeaders(res);
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: denyAsNotFound ? 'Campaign not found' : 'Brand access denied' }));
        return null;
    }
    return { user, campaign };
}

function parseCookies(header = '') {
    return (header || '')
        .split(';')
        .map(part => part.trim())
        .filter(Boolean)
        .reduce((acc, part) => {
            const [key, ...rest] = part.split('=');
            if (!key) return acc;
            acc[key.trim()] = decodeURIComponent((rest.join('=') || '').trim());
            return acc;
        }, {});
}

function appendSetCookieHeader(res, value) {
    const existing = res.getHeader('Set-Cookie');
    if (!existing) {
        res.setHeader('Set-Cookie', value);
    } else if (Array.isArray(existing)) {
        res.setHeader('Set-Cookie', [...existing, value]);
    } else {
        res.setHeader('Set-Cookie', [existing, value]);
    }
}

function setSessionCookie(res, sessionId, isSecure) {
    const attributes = [
        `${SESSION_COOKIE_NAME}=${sessionId}`,
        'HttpOnly',
        'Path=/',
        `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        'SameSite=Strict'
    ];
    if (isSecure) {
        attributes.push('Secure');
    }
    appendSetCookieHeader(res, attributes.join('; '));
}

function createSessionRecord() {
    return {
        id: crypto.randomBytes(18).toString('hex'),
        csrfToken: crypto.randomBytes(32).toString('hex'),
        createdAt: Date.now(),
        updatedAt: Date.now()
    };
}

function getOrCreateSession(req, res, isSecure) {
    const cookies = parseCookies(req.headers.cookie || '');
    const existingId = cookies[SESSION_COOKIE_NAME];
    if (existingId) {
        const existingSession = sessionStore.get(existingId);
        if (existingSession) {
            const expired = (Date.now() - existingSession.createdAt) > SESSION_TTL_MS;
            if (!expired) {
                existingSession.updatedAt = Date.now();
                return existingSession;
            }
            sessionStore.delete(existingId);
        }
    }

    const newSession = createSessionRecord();
    sessionStore.set(newSession.id, newSession);
    setSessionCookie(res, newSession.id, isSecure);
    return newSession;
}

function resolveCsrfTokenCandidate(req, bodyToken) {
    const headerToken = (req.headers[CSRF_HEADER_NAME] || '').trim();
    if (headerToken) return headerToken;
    if (typeof bodyToken === 'string' && bodyToken.trim()) return bodyToken.trim();
    return null;
}

function enforceCsrf(req, res, bodyToken = '') {
    if (getTokenFromHeader(req)) {
        return true;
    }
    const candidate = resolveCsrfTokenCandidate(req, bodyToken);
    if (!req.session || !candidate || candidate !== req.session.csrfToken) {
        setNoCacheHeaders(res);
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid or missing CSRF token' }));
        return false;
    }
    return true;
}

// Stats tracking functions
function getCampaignStats(campaignId) {
    const allStats = readJson(PATHS.stats) || {};
    return allStats[campaignId] || { smsSentCount: 0 };
}

function incrementSmsSentCount(campaignId) {
    const allStats = readJson(PATHS.stats) || {};
    if (!allStats[campaignId]) {
        allStats[campaignId] = { smsSentCount: 0 };
    }
    allStats[campaignId].smsSentCount = (allStats[campaignId].smsSentCount || 0) + 1;
    writeJson(PATHS.stats, allStats);
}

function readJson(filePath) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch (e) { return null; }
}

function atomicWriteJson(filePath, data) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    try {
        fs.writeFileSync(tempPath, payload, 'utf8');
        fs.renameSync(tempPath, filePath);
    } catch (error) {
        try {
            if (fs.existsSync(tempPath)) {
                fs.unlinkSync(tempPath);
            }
        } catch (cleanupError) {
            console.error(`[Data] Failed to clean up temp file ${tempPath}:`, cleanupError.message);
        }
        throw error;
    }
}

function writeJson(filePath, data) {
    try {
        createBackupSync(filePath);
        atomicWriteJson(filePath, data);
        return true;
    } catch (error) {
        console.error(`[Data] Failed to write ${filePath}:`, error.message);
        return false;
    }
}

function logCspReport(report, req) {
    if (!report) return;
    const entry = {
        timestamp: new Date().toISOString(),
        userAgent: req?.headers?.['user-agent'] || null,
        ip: req?.socket?.remoteAddress || null,
        report
    };
    fs.appendFile(PATHS.cspReportsLog, `${JSON.stringify(entry)}\n`, err => {
        if (err) {
            console.error('[CSP Report] Failed to write report', err.message);
        }
    });
}

function sanitizePhoneInput(phone) {
    if (phone === undefined || phone === null) return '';
    const value = String(phone).trim();
    if (!value) return '';
    const hasPlus = value.startsWith('+');
    const digits = value.replace(/\D/g, '');
    return hasPlus ? `+${digits}` : digits;
}
function extractCountryCode(digits) {
    for (const code of SORTED_COUNTRY_CODES) {
        if (digits.startsWith(code)) return code;
    }
    return null;
}
function formatPhoneE164(phone) {
    const sanitized = sanitizePhoneInput(phone);
    if (!sanitized) return '';
    return sanitized.startsWith('+') ? sanitized : `+${sanitized}`;
}
function normalizePhone(phone) {
    return sanitizePhoneInput(phone).replace(/^\+/, '');
}
function isValidPhone(phone) {
    if (!phone) return false;
    const sanitized = sanitizePhoneInput(phone);
    if (!PHONE_E164_REGEX.test(sanitized)) return false;
    const digits = sanitized.startsWith('+') ? sanitized.slice(1) : sanitized;
    const countryCode = extractCountryCode(digits);
    if (!countryCode) return false;
    const nationalNumber = digits.slice(countryCode.length);
    return nationalNumber.length >= 7 && nationalNumber.length <= 12;
}
function isValidEmail(email) {
    return typeof email === 'string' && EMAIL_REGEX.test(email.trim());
}
function isValidCampaignId(id) {
    return typeof id === 'string' && CAMPAIGN_ID_REGEX.test(id);
}
function isValidReferralCode(code) {
    return typeof code === 'string' && REFERRAL_CODE_REGEX.test(code.trim());
}
function normalizeReferralCode(code) {
    return typeof code === 'string' ? code.trim().toUpperCase() : null;
}
function generateReferralCode() {
    const participants = getParticipants();
    let code;
    let attempts = 0;
    const maxAttempts = 100;
    do {
        code = crypto.randomBytes(4).toString('hex').toUpperCase();
        attempts++;
    } while (attempts < maxAttempts && participants.some(p => p.referralCode === code));
    return code;
}

function generateCampaignId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const randomBytes = crypto.randomBytes(11);
    let result = '';
    for (let i = 0; i < 11; i++) result += chars[randomBytes[i] % chars.length];
    return result;
}

function normalizeCampaignRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const brandId = record.brandId || record.brand_id || null;
    return { ...record, brandId, brand_id: brandId };
}

function readCampaignStore({ strictBrandCheck = false } = {}) {
    const data = readJson(PATHS.campaigns) || { campaigns: [] };
    let source;
    if (Array.isArray(data)) {
        source = data;
    } else if (Array.isArray(data.campaigns)) {
        source = data.campaigns;
    } else if (typeof data === 'object') {
        source = Object.values(data);
    } else {
        source = [];
    }
    const brandIds = getBrandIdSet({ forceRefresh: strictBrandCheck });
    const campaigns = [];

    source.forEach(entry => {
        const normalized = normalizeCampaignRecord(entry);
        if (!normalized) return;
        const result = validateCampaignRecord(normalized, { brandIds, strictBrandCheck });
        const identifier = normalized.id || resolveCampaignName(normalized) || 'unknown';
        if (!result.valid) {
            logValidationIssues('campaign', PATHS.campaigns, identifier, result.errors, 'error');
            return;
        }
        if (result.warnings.length) {
            logValidationIssues('campaign', PATHS.campaigns, identifier, result.warnings, 'warn');
        }
        campaigns.push(result.value);
    });

    return { campaigns };
}

function writeCampaignStore(campaigns) {
    const brandIds = getBrandIdSet({ forceRefresh: true });
    const payload = [];
    const errors = [];

    (campaigns || []).forEach(entry => {
        const normalized = normalizeCampaignRecord(entry);
        if (!normalized) return;
        const result = validateCampaignRecord(normalized, { brandIds, strictBrandCheck: true });
        const identifier = normalized.id || resolveCampaignName(normalized) || 'unknown';
        if (!result.valid) {
            result.errors.forEach(err => errors.push(`${identifier}: ${err}`));
            return;
        }
        payload.push(result.value);
    });

    if (errors.length) {
        throw new DataValidationError('Invalid campaign data', errors);
    }

    writeJson(PATHS.campaigns, { campaigns: payload });
    return payload;
}

function listCampaignRecords() {
    return readCampaignStore().campaigns.map(normalizeCampaignRecord).filter(Boolean);
}

function getCampaigns(options = {}) {
    const { brandId = null, restrict = false } = options;
    let records = listCampaignRecords();
    const targetBrand = brandId || null;
    if (restrict && targetBrand) {
        records = records.filter(record => (record.brandId || record.brand_id || null) === targetBrand);
    }
    return records.reduce((acc, record) => {
        if (record?.id) {
            acc[record.id] = record;
        }
        return acc;
    }, {});
}

function getCampaign(campaignId) {
    const campaigns = getCampaigns();
    return campaigns[campaignId] || null;
}

function isCampaignActive(campaign) {
    if (!campaign) return false;
    if (campaign.isArchived || campaign.archived) return false;
    if (campaign.isDisabled || campaign.disabled) return false;
    const status = typeof campaign.status === 'string' ? campaign.status.trim().toLowerCase() : '';
    if (status && ['inactive', 'archived', 'disabled'].includes(status)) {
        return false;
    }
    if (campaign.countdownEnd) {
        const endTime = Date.parse(campaign.countdownEnd);
        if (!Number.isNaN(endTime) && endTime < Date.now()) {
            return false;
        }
    }
    return true;
}

function saveCampaign(campaignId, campaignData, { brandId = null } = {}) {
    const records = listCampaignRecords();
    const index = records.findIndex(record => record.id === campaignId);
    const nextCampaign = ensureCampaignValid({ ...campaignData, id: campaignId }, { context: `campaign ${campaignId}` });
    const normalizedBrandId = brandId || nextCampaign.brandId || nextCampaign.brand_id || null;
    nextCampaign.brandId = normalizedBrandId;
    nextCampaign.brand_id = normalizedBrandId;
    if (index > -1) {
        records[index] = nextCampaign;
    } else {
        records.push(nextCampaign);
    }
    writeCampaignStore(records);
    return nextCampaign;
}

function deleteCampaign(campaignId) {
    const records = listCampaignRecords();
    const nextRecords = records.filter(record => record.id !== campaignId);
    if (records.length === nextRecords.length) return false;
    writeCampaignStore(nextRecords);
    return true;
}

function getCampaignConfig(campaignId) {
    const campaign = getCampaign(campaignId);
    if (!campaign) return null;
    const participants = getParticipants(campaignId);
    const pricing = campaign.pricing || {};
    return {
        id: campaignId,
        initialBuyers: pricing.initialBuyers || campaign.initialBuyers || 500,
        initialPrice: pricing.initialPrice || campaign.originalPrice || 80,
        checkoutUrl: pricing.checkoutUrl || '',
        termsUrl: campaign.termsUrl || '',
        priceTiers: pricing.tiers || campaign.priceTiers || [],
        countdownEnd: campaign.countdownEnd || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        videoSource: campaign.videoUrl || '',
        referralsNeeded: campaign.referralsNeeded || campaign.sharesRequired || DEFAULT_REFERRALS_NEEDED,
        currentBuyers: (pricing.initialBuyers || campaign.initialBuyers || 0) + participants.length,
        product: {
            image: campaign.productImage || campaign.imageUrl || '',
            name: campaign.productName || '',
            description: campaign.productDescription || campaign.description || ''
        },
        twilio: campaign.twilio || { enabled: false, accountSid: '', authToken: '', phoneNumber: '', domain: '' }
    };
}

function getConfig() {
    const config = readJson(PATHS.config) || DEFAULT_CONFIG;
    config.currentBuyers = (config.initialBuyers || 0) + getParticipants().length;
    return config;
}

function getParticipants(campaignId = null) {
    const participants = readJson(PATHS.participants) || [];
    return campaignId ? participants.filter(p => p.campaignId === campaignId) : participants;
}

function getReferralCount(referralCode, campaignId = null) {
    const normalizedCode = normalizeReferralCode(referralCode);
    if (!normalizedCode) return 0;
    return getParticipants(campaignId).filter(p => p.referredBy === normalizedCode).length;
}

function hasUnlockedBestPrice(referralCode, campaignId = null) {
    const normalizedCode = normalizeReferralCode(referralCode);
    if (!normalizedCode) return false;
    const campaign = getCampaign(campaignId);
    const needed = Math.min(campaign?.referralsNeeded || campaign?.sharesRequired || DEFAULT_REFERRALS_NEEDED, MAX_REFERRALS);
    return getReferralCount(normalizedCode, campaignId) >= needed;
}

function getReferralStatus(referralCode, campaignId = null) {
    const normalizedCode = normalizeReferralCode(referralCode);
    const campaign = getCampaign(campaignId);
    const count = getReferralCount(normalizedCode, campaignId);
    const needed = Math.min(campaign?.referralsNeeded || campaign?.sharesRequired || DEFAULT_REFERRALS_NEEDED, MAX_REFERRALS);
    const tiers = campaign?.pricing?.tiers || campaign?.priceTiers || [];
    const bestPrice = tiers.length > 0 ? Math.min(...tiers.map(t => t.price)) : 20;
    return { referralCode: normalizedCode, referralCount: count, unlockedBestPrice: hasUnlockedBestPrice(normalizedCode, campaignId), bestPrice, referralsNeeded: needed, referralsRemaining: Math.max(0, needed - count) };
}

function isOptedOut(phone) { return (readJson(PATHS.optouts) || []).includes(normalizePhone(phone)); }

async function sendSMS(to, body, campaignId = null) {
    const campaign = campaignId ? getCampaign(campaignId) : null;
    const twilio = campaign?.twilio || getConfig().twilio || {};
    if (!twilio.enabled || !twilio.accountSid || !twilio.authToken || !twilio.phoneNumber) return { success: false, reason: 'not_configured' };
    if (isOptedOut(to)) return { success: false, reason: 'opted_out' };
    const postData = new URLSearchParams({ To: to, From: twilio.phoneNumber, Body: body }).toString();
    const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64');
    return new Promise((resolve, reject) => {
        const req = https.request({ hostname: 'api.twilio.com', port: 443, path: `/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${auth}`, 'Content-Length': Buffer.byteLength(postData) } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    // Track successful SMS send
                    if (campaignId) {
                        incrementSmsSentCount(campaignId);
                    }
                    resolve({ success: true, data: JSON.parse(data) });
                } else {
                    reject(new Error(`Twilio error: ${res.statusCode}`));
                }
            });
        });
        req.on('error', reject);
        req.write(postData);
        req.end();
    });
}

async function handleOptOut(phone) {
    const optouts = readJson(PATHS.optouts) || [];
    const normalized = normalizePhone(phone);
    if (!optouts.includes(normalized)) { optouts.push(normalized); writeJson(PATHS.optouts, optouts); }
    return sendSMS(phone, "You've been unsubscribed. Reply START to resubscribe.");
}

async function handleOptIn(phone) {
    const optouts = readJson(PATHS.optouts) || [];
    const normalized = normalizePhone(phone);
    const index = optouts.indexOf(normalized);
    if (index > -1) { optouts.splice(index, 1); writeJson(PATHS.optouts, optouts); }
    return sendSMS(phone, "You're subscribed! Welcome back.");
}

function findParticipantByPhone(phone, campaignId = null) {
    const normalizedPhone = normalizePhone(phone);
    return getParticipants().find(p => {
        const phoneMatch = normalizePhone(p.phone) === normalizedPhone;
        if (!campaignId) return phoneMatch; // Global check for legacy/no-campaign joins
        return phoneMatch && p.campaignId === campaignId; // Campaign-specific check
    });
}

function addParticipant(phone, email, referredBy, campaignId = null) {
    const participants = getParticipants();
    const newParticipant = {
        phone: formatPhoneE164(phone) || phone,
        email: typeof email === 'string' ? email.trim() : email,
        referralCode: generateReferralCode(),
        referredBy: normalizeReferralCode(referredBy),
        campaignId: isValidCampaignId(campaignId) ? campaignId : null,
        joinedAt: new Date().toISOString()
    };
    participants.push(newParticipant);
    return writeJson(PATHS.participants, participants) ? newParticipant : null;
}

// Notify me subscribers for future drops
function getNotifySubscribers() {
    return readJson(PATHS.notifySubscribers) || [];
}

function addNotifySubscriber(phone, email) {
    const subscribers = getNotifySubscribers();
    const normalizedPhone = formatPhoneE164(phone) || phone;
    const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : email;
    
    // Check if already subscribed
    const existing = subscribers.find(s => 
        s.phone === normalizedPhone || s.email === normalizedEmail
    );
    if (existing) return { success: false, error: 'Already subscribed' };
    
    const newSubscriber = {
        phone: normalizedPhone,
        email: normalizedEmail,
        subscribedAt: new Date().toISOString()
    };
    subscribers.push(newSubscriber);
    return writeJson(PATHS.notifySubscribers, subscribers) ? { success: true, subscriber: newSubscriber } : { success: false, error: 'Failed to save' };
}

async function sendWelcomeSMS(phone, referralCode, campaignId = null) {
    const campaign = getCampaign(campaignId);
    const pricing = campaign?.pricing || {};
    const tiers = pricing.tiers || campaign?.priceTiers || [];
    const bestPrice = tiers.length > 0 ? Math.min(...tiers.map(t => t.price)) : 20;
    const twilio = campaign?.twilio || getConfig().twilio || {};
    const domain = twilio.domain || getConfig().domain || 'https://your-domain.com';
    const referralsNeeded = campaign?.referralsNeeded || campaign?.sharesRequired || DEFAULT_REFERRALS_NEEDED;
    const smsBody = `You're in the drop! 🎉 Share your link to unlock $${bestPrice}: ${domain}/?v=${campaignId}&ref=${referralCode} - Get ${referralsNeeded} friends to join! Reply STOP to unsubscribe.`;
    try {
        const result = await sendSMS(phone, smsBody, campaignId);
        console.log(`[Twilio SMS] Success to ${phone}:`, JSON.stringify(result.data?.sid || result));
        return result;
    } catch (error) {
        console.error(`[Twilio SMS] Error to ${phone}:`, error.message);
        return { success: false, error: error.message };
    }
}

async function sendUnlockSMS(referrerPhone, referralCode, campaignId) {
    const campaign = getCampaign(campaignId);
    if (!campaign) return { success: false, reason: 'campaign_not_found' };

    const pricing = campaign.pricing || {};
    const tiers = pricing.tiers || campaign.priceTiers || [];

    // Get best price (minimum price from all tiers)
    const bestPrice = tiers.length > 0 ? Math.min(...tiers.map(t => t.price)) : 20;

    // Get coupon code from the tier with the best price
    const bestTier = tiers.find(t => t.price === bestPrice) || {};
    const couponCode = bestTier.couponCode || 'SAVE20';

    // Get checkout URL
    const checkoutUrl = pricing.checkoutUrl || campaign.checkoutUrl || 'https://shop.example.com/checkout';

    const smsBody = `Congrats! You've unlocked $${bestPrice}! Use code ${couponCode} at checkout: ${checkoutUrl}`;

    try {
        const result = await sendSMS(referrerPhone, smsBody, campaignId);
        console.log(`[Twilio SMS Unlock] Success to ${referrerPhone}:`, JSON.stringify(result.data?.sid || result));
        return result;
    } catch (error) {
        console.error(`[Twilio SMS Unlock] Error to ${referrerPhone}:`, error.message);
        return { success: false, error: error.message };
    }
}

const rateLimitMap = new Map();
const loginAttemptsMap = new Map();
const LOCALHOST_IPS = ['127.0.0.1', '::1', '::ffff:127.0.0.1', '::ffff:192.168.224.1'];

function normalizeHost(hostHeader = '') {
    if (!hostHeader) return '';
    return hostHeader.split(':')[0].trim().toLowerCase();
}

function isExemptHost(hostHeader) {
    const normalized = normalizeHost(hostHeader);
    return normalized && HTTPS_EXEMPT_HOSTS.includes(normalized);
}

function shouldSkipHttps(hostHeader, ipAddress) {
    return isLocalhost(ipAddress) || isExemptHost(hostHeader);
}

function getForwardedProto(req) {
    const proto = req.headers['x-forwarded-proto'];
    if (!proto) return null;
    return proto.split(',').map(value => value.trim().toLowerCase());
}

function isSecureRequest(req) {
    if (req.socket && req.socket.encrypted) return true;
    const forwardedProto = getForwardedProto(req);
    if (forwardedProto) {
        return forwardedProto.includes('https');
    }
    return false;
}

function getHostForRequest(req) {
    return req.headers['x-forwarded-host'] || req.headers.host || '';
}

function getClientIp(req) {
    const raw = (req?.headers?.['x-forwarded-for'] || req?.socket?.remoteAddress || '') || '';
    return raw.split(',')[0].trim();
}

function enforceHttpsMiddleware(req, res, clientIP = null) {
    const clientAddress = clientIP || getClientIp(req);
    const requestHost = getHostForRequest(req);
    const enforcingHttps = FORCE_HTTPS && !shouldSkipHttps(requestHost, clientAddress);
    const requestIsSecure = isSecureRequest(req);

    if (!enforcingHttps) {
        return { handled: false, isSecure: requestIsSecure, enforcing: false, host: requestHost };
    }

    if (!requestIsSecure) {
        const redirectHost = requestHost || req.headers.host;
        if (redirectHost) {
            const location = `https://${redirectHost}${req.url}`;
            res.writeHead(301, { Location: location, 'Content-Type': 'text/plain' });
            res.end('Redirecting to HTTPS');
        } else {
            res.writeHead(400, { 'Content-Type': 'text/plain' });
            res.end('HTTPS required');
        }
        return { handled: true, isSecure: false, enforcing: true, host: requestHost };
    }

    res.setHeader('Strict-Transport-Security', HSTS_HEADER_VALUE);
    return { handled: false, isSecure: true, enforcing: true, host: requestHost };
}

// Login rate limiting: 5 attempts per 15 minutes
const LOGIN_RATE_LIMIT_MAX = 5;
const LOGIN_RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes

// Track campaigns that have had reminder SMS sent (to avoid duplicates)
const reminderSentCampaigns = new Set();
const REMINDER_CHECK_INTERVAL = 15 * 60 * 1000; // 15 minutes
const REMINDER_WINDOW_START = 1 * 60 * 60 * 1000 + 45 * 60 * 1000; // 1h45m before end
const REMINDER_WINDOW_END = 2 * 60 * 60 * 1000 + 15 * 60 * 1000; // 2h15m before end

// Track campaigns that have had end-of-drop SMS sent (to avoid duplicates)
const endOfDropSentCampaigns = new Set();
const END_OF_DROP_WINDOW = 15 * 60 * 1000; // 15 minutes after campaign ends

/**
 * Get the next pricing tier for a campaign (lowest tier where buyers > currentBuyers)
 * @param {Object} campaign - Campaign object
 * @returns {Object|null} - Next tier object or null if no next tier
 */
function getNextTierForCampaign(campaign) {
    if (!campaign) return null;

    const pricing = campaign.pricing || {};
    const tiers = pricing.tiers || campaign.priceTiers || [];
    if (tiers.length === 0) return null;

    const participants = getParticipants(campaign.id);
    const currentBuyers = (pricing.initialBuyers || campaign.initialBuyers || 0) + participants.length;

    // Sort tiers by buyer count ascending
    const sortedTiers = [...tiers].sort((a, b) => a.buyers - b.buyers);

    // Find the first tier with more buyers than current
    for (const tier of sortedTiers) {
        if (tier.buyers > currentBuyers) {
            return tier;
        }
    }

    return null; // All tiers unlocked
}

/**
 * Get the price tier that matches the current buyer count
 * Returns the highest tier where tier.buyers <= buyerCount
 * If buyer count is below first tier, returns null (use initial price)
 * @param {Object} campaign - Campaign object
 * @param {number} buyerCount - Current number of buyers
 * @returns {Object|null} - Matching tier or null if below first tier
 */
function getPriceTierForBuyers(campaign, buyerCount) {
    if (!campaign) return null;

    const pricing = campaign.pricing || {};
    const tiers = pricing.tiers || campaign.priceTiers || [];
    if (tiers.length === 0) return null;

    // Sort tiers by buyer count ascending
    const sortedTiers = [...tiers].sort((a, b) => a.buyers - b.buyers);

    // Find the highest tier where buyers <= current buyer count
    let matchedTier = null;
    for (const tier of sortedTiers) {
        if (tier.buyers <= buyerCount) {
            matchedTier = tier;
        } else {
            break; // Tiers are sorted, so we can stop here
        }
    }

    return matchedTier; // null if below first tier
}

/**
 * Send reminder SMS to a participant about the campaign ending soon
 * @param {Object} participant - Participant object
 * @param {Object} campaign - Campaign object
 * @returns {Promise<Object>} - SMS send result
 */
async function sendReminderSMS(participant, campaign) {
    if (!participant || !campaign) return { success: false, reason: 'missing_data' };
    if (!participant.phone || !participant.referralCode) return { success: false, reason: 'missing_phone_or_code' };

    // Get current buyer count
    const pricing = campaign.pricing || {};
    const participants = getParticipants(campaign.id);
    const currentBuyers = (pricing.initialBuyers || campaign.initialBuyers || 0) + participants.length;

    // Get next tier
    const nextTier = getNextTierForCampaign(campaign);
    if (!nextTier) return { success: false, reason: 'no_next_tier' };

    // Calculate buyers needed
    const buyersNeeded = nextTier.buyers - currentBuyers;

    // Get Twilio config
    const twilio = campaign.twilio || getConfig().twilio || {};
    const domain = twilio.domain || getConfig().domain || 'https://your-domain.com';

    // Format SMS message (no URL - they already have it from welcome SMS)
    const smsBody = `🚨 ${currentBuyers} buyers joined - ${buyersNeeded} left to unlock $${nextTier.price}, share your link!`;

    try {
        const result = await sendSMS(participant.phone, smsBody, campaign.id);
        console.log(`[Reminder SMS] Success to ${participant.phone} for campaign ${campaign.id}:`, JSON.stringify(result.data?.sid || result));
        return { success: true, result };
    } catch (error) {
        console.error(`[Reminder SMS] Error to ${participant.phone} for campaign ${campaign.id}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Send end-of-drop SMS to a participant with their unlocked price and coupon code
 * @param {Object} participant - Participant object
 * @param {Object} campaign - Campaign object
 * @param {number} finalPrice - Final unlocked price
 * @param {string} couponCode - Coupon code for the unlocked price
 * @returns {Promise<Object>} - SMS send result
 */
async function sendEndOfDropSMS(participant, campaign, finalPrice, couponCode) {
    if (!participant || !campaign) return { success: false, reason: 'missing_data' };
    if (!participant.phone) return { success: false, reason: 'missing_phone' };

    // Get checkout URL
    const pricing = campaign.pricing || {};
    const checkoutUrl = pricing.checkoutUrl || campaign.checkoutUrl || 'https://shop.example.com/checkout';

    // Format SMS message with 4-hour urgency
    const smsBody = `End of the drop! You've unlocked $${finalPrice}. Use code ${couponCode} at checkout: ${checkoutUrl} - Coupon only valid for 4 hours`;

    try {
        const result = await sendSMS(participant.phone, smsBody, campaign.id);
        console.log(`[End-of-Drop SMS] Success to ${participant.phone} for campaign ${campaign.id}:`, JSON.stringify(result.data?.sid || result));
        return { success: true, result };
    } catch (error) {
        console.error(`[End-of-Drop SMS] Error to ${participant.phone} for campaign ${campaign.id}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Check campaigns and send reminder SMS to referrers who haven't unlocked best price
 * Also checks for ended campaigns and sends end-of-drop SMS to all participants
 * Runs every 15 minutes
 */
async function scheduleReminderSMS() {
    let campaigns;
    try {
        campaigns = getCampaigns();
    } catch (error) {
        logCampaignValidationError(error, 'Reminder SMS');
        return;
    }
    const now = Date.now();

    for (const [campaignId, campaign] of Object.entries(campaigns)) {
        const countdownEnd = new Date(campaign.countdownEnd).getTime();
        const timeUntilEnd = countdownEnd - now;
        const timeSinceEnd = now - countdownEnd;

        // --- END OF DROP SMS CHECK ---
        // Send end-of-drop SMS to all participants for campaigns that just ended (within last 15 min)
        if (timeSinceEnd >= 0 && timeSinceEnd < END_OF_DROP_WINDOW) {
            // Skip if end-of-drop SMS already sent for this campaign
            if (endOfDropSentCampaigns.has(campaignId)) continue;

            console.log(`[End-of-Drop SMS] Campaign ${campaignId} just ended (${Math.round(timeSinceEnd / 60000)}m ago), sending notifications...`);

            // Get current buyer count
            const pricing = campaign.pricing || {};
            const participants = getParticipants(campaignId);
            const currentBuyers = (pricing.initialBuyers || campaign.initialBuyers || 0) + participants.length;

            // Calculate final price based on buyer count
            const matchedTier = getPriceTierForBuyers(campaign, currentBuyers);

            // Determine final price and coupon code
            let finalPrice, couponCode;
            if (matchedTier) {
                finalPrice = matchedTier.price;
                couponCode = matchedTier.couponCode || 'SAVE' + finalPrice;
            } else {
                // Below first tier - use initial price
                finalPrice = pricing.initialPrice || campaign.initialPrice || campaign.originalPrice || 80;
                couponCode = 'SAVE' + finalPrice;
            }

            // Send end-of-drop SMS to ALL participants
            let sentCount = 0;
            for (const participant of participants) {
                // Skip if no phone number
                if (!participant.phone) continue;

                // Send end-of-drop SMS
                const result = await sendEndOfDropSMS(participant, campaign, finalPrice, couponCode);
                if (result.success) {
                    sentCount++;
                }

                // Small delay to avoid rate limiting
                await new Promise(resolve => setTimeout(resolve, 100));
            }

            console.log(`[End-of-Drop SMS] Sent ${sentCount} notifications for campaign ${campaignId} (final price: $${finalPrice})`);

            // Mark end-of-drop SMS as sent for this campaign
            endOfDropSentCampaigns.add(campaignId);
            continue; // Skip reminder check for this campaign
        }

        // --- REMINDER SMS CHECK ---
        // Skip if reminder already sent for this campaign
        if (reminderSentCampaigns.has(campaignId)) continue;

        // Check if campaign has ended
        if (now >= countdownEnd) continue; // Campaign already ended

        // Check if we're in the reminder window (between 1h45m and 2h15m before end)
        if (timeUntilEnd < REMINDER_WINDOW_START || timeUntilEnd > REMINDER_WINDOW_END) continue;

        console.log(`[Reminder SMS] Campaign ${campaignId} is in reminder window (${Math.round(timeUntilEnd / 60000)}m until end)`);

        // Get all participants for this campaign
        const participants = getParticipants(campaignId);

        // Find participants with referral codes who haven't unlocked best price
        let sentCount = 0;
        for (const participant of participants) {
            // Skip if no referral code
            if (!participant.referralCode) continue;

            // Skip if already unlocked best price
            if (hasUnlockedBestPrice(participant.referralCode, campaignId)) continue;

            // Send reminder SMS
            const result = await sendReminderSMS(participant, campaign);
            if (result.success) {
                sentCount++;
            }

            // Small delay to avoid rate limiting
            await new Promise(resolve => setTimeout(resolve, 100));
        }

        console.log(`[Reminder SMS] Sent ${sentCount} reminders for campaign ${campaignId}`);

        // Mark reminder as sent for this campaign
        reminderSentCampaigns.add(campaignId);
    }
}
function isLocalhost(ip) {
    return LOCALHOST_IPS.includes(ip) || ip?.startsWith('127.') || ip === 'localhost';
}

/**
 * Determine the rate limit bucket for a given request method and path.
 * @param {string} method - HTTP method (GET, POST, PUT, DELETE, etc.)
 * @param {string} path - Request path
 * @returns {string|null} - Bucket name ('get', 'write') or null if exempt
 */
function getRateLimitBucket(method, path) {
    // Login endpoint has its own separate rate limiter
    if (path === '/api/login') {
        return null; // Exempt from tiered limiting, handled by checkLoginRateLimit
    }

    const normalizedMethod = (method || '').toUpperCase();

    // GET requests go to the 'get' bucket
    if (normalizedMethod === 'GET') {
        return 'get';
    }

    // POST, PUT, DELETE go to the 'write' bucket
    if (['POST', 'PUT', 'DELETE'].includes(normalizedMethod)) {
        return 'write';
    }

    // Other methods (OPTIONS, HEAD, etc.) - no limiting
    return null;
}

/**
 * Clean up rate limit entries older than the window to prevent unbounded growth.
 * This should be called periodically (e.g., on a schedule or probabilistically).
 */
function cleanOldRateLimitEntries() {
    const now = Date.now();
    const cutoff = now - RATE_LIMIT_WINDOW;
    let cleanedCount = 0;

    for (const [ip, buckets] of tieredRateLimitMap.entries()) {
        // Clean up old timestamps in each bucket
        if (buckets.get) {
            buckets.get = buckets.get.filter(time => time > cutoff);
        }
        if (buckets.write) {
            buckets.write = buckets.write.filter(time => time > cutoff);
        }

        // Remove entry if all buckets are empty and last request was a while ago
        const getCount = buckets.get?.length || 0;
        const writeCount = buckets.write?.length || 0;
        const lastRequest = buckets.lastRequest || 0;

        if (getCount === 0 && writeCount === 0 && lastRequest < cutoff) {
            tieredRateLimitMap.delete(ip);
            cleanedCount++;
        }
    }

    if (cleanedCount > 0) {
        console.log(`[Rate Limit] Cleaned up ${cleanedCount} old entries. Current size: ${tieredRateLimitMap.size}`);
    }
}

/**
 * Check tiered rate limit for a given IP, method, and path.
 * @param {string} ip - Client IP address
 * @param {string} method - HTTP method
 * @param {string} path - Request path
 * @returns {Object} - { allowed: boolean, retryAfter?: number, bucket?: string }
 */
function checkRateLimit(ip, method, path) {
    // Bypass rate limiting for localhost
    if (isLocalhost(ip)) {
        return { allowed: true };
    }

    const bucket = getRateLimitBucket(method, path);

    // No rate limiting for this request type (e.g., OPTIONS, HEAD, or login endpoint)
    if (!bucket) {
        return { allowed: true };
    }

    const now = Date.now();

    // Get or initialize the IP's bucket data
    let ipData = tieredRateLimitMap.get(ip);
    if (!ipData) {
        ipData = { get: [], write: [], lastRequest: now };
        tieredRateLimitMap.set(ip, ipData);
    }
    ipData.lastRequest = now;

    // Filter out old timestamps outside the window
    const cutoff = now - RATE_LIMIT_WINDOW;
    ipData[bucket] = (ipData[bucket] || []).filter(time => time > cutoff);

    // Determine the limit based on bucket
    const limit = bucket === 'get' ? RATE_LIMIT_GET_MAX : RATE_LIMIT_WRITE_MAX;

    // Check if limit exceeded
    if (ipData[bucket].length >= limit) {
        const oldestRequest = ipData[bucket][0];
        const retryAfter = Math.ceil((oldestRequest + RATE_LIMIT_WINDOW - now) / 1000);
        return { allowed: false, retryAfter, bucket };
    }

    // Record this request
    ipData[bucket].push(now);
    return { allowed: true, bucket };
}

// Check login rate limit (5 attempts per 15 minutes)
function checkLoginRateLimit(ip) {
    // Bypass rate limiting for localhost during development
    if (isLocalhost(ip)) return { allowed: true };
    
    const now = Date.now();
    const attempts = (loginAttemptsMap.get(ip) || []).filter(time => time > now - LOGIN_RATE_LIMIT_WINDOW);
    
    if (attempts.length >= LOGIN_RATE_LIMIT_MAX) {
        const retryAfter = Math.ceil((attempts[0] + LOGIN_RATE_LIMIT_WINDOW - now) / 1000);
        return { allowed: false, retryAfter };
    }
    
    return { allowed: true, attempts };
}

// Record a login attempt
function recordLoginAttempt(ip) {
    if (isLocalhost(ip)) return;
    
    const now = Date.now();
    const attempts = (loginAttemptsMap.get(ip) || []).filter(time => time > now - LOGIN_RATE_LIMIT_WINDOW);
    attempts.push(now);
    loginAttemptsMap.set(ip, attempts);
}

// Generate a simple JWT-like token
const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif' };

function setNoCacheHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}

function setSecurityHeaders(res) {
    const headerName = CSP_REPORT_ONLY ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
    res.setHeader(headerName, CSP_POLICY);
}

function sendJsonError(res, error, fallbackStatus = 500) {
    const statusCode = Number(error?.statusCode) || fallbackStatus;
    const payload = { error: error?.message || 'Internal server error' };
    if (error?.details && error.details.length) payload.details = error.details;
    if (error?.code) payload.code = error.code;
    setNoCacheHeaders(res);
    res.writeHead(statusCode, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(payload));
}

function logCampaignValidationError(error, prefix = 'Campaign Validation') {
    if (!error) return;
    console.error(`[${prefix}] ${error.message}`);
    if (Array.isArray(error.details)) {
        error.details.forEach(detail => {
            if (typeof detail === 'string') {
                console.error(`  - ${detail}`);
                return;
            }
            if (detail?.campaignId) {
                const summary = Array.isArray(detail.errors) ? detail.errors.join('; ') : detail.errors;
                console.error(`  - ${detail.campaignId}: ${summary}`);
            }
        });
    }
}

const server = http.createServer((req, res) => {
    const clientIP = getClientIp(req);
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${clientIP}`);

    const httpsContext = enforceHttpsMiddleware(req, res, clientIP);
    if (httpsContext.handled) {
        return;
    }
    const requestIsSecure = httpsContext.isSecure;

    const session = getOrCreateSession(req, res, requestIsSecure);
    req.session = session;

    setSecurityHeaders(res);

    // Apply tiered rate limiting for /api/* endpoints (except /api/login which has its own limiter)
    if (req.url.startsWith('/api/')) {
        const rateLimit = checkRateLimit(clientIP, req.method, req.url);
        if (!rateLimit.allowed) {
            setNoCacheHeaders(res);
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': rateLimit.retryAfter });
            return res.end(JSON.stringify({
                error: 'Too many requests',
                retryAfter: rateLimit.retryAfter,
                bucket: rateLimit.bucket
            }));
        }
    }

    // Periodically clean old rate limit entries (1% chance per request)
    if (Math.random() < 0.01) {
        cleanOldRateLimitEntries();
    }
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }
    
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    
    if (pathname === CSP_REPORT_ENDPOINT && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk;
            if (body.length > 1e6) {
                body = '';
                req.socket.destroy();
            }
        });
        req.on('end', () => {
            const contentType = (req.headers['content-type'] || '').split(';')[0].trim();
            let payload = null;
            try {
                if (contentType === 'application/csp-report') {
                    const parsed = body ? JSON.parse(body) : {};
                    payload = parsed['csp-report'] || parsed;
                } else {
                    payload = body ? JSON.parse(body) : null;
                }
            } catch (error) {
                payload = body ? { raw: body } : null;
            }
            logCspReport(payload, req);
            res.writeHead(204, { 'Content-Type': 'text/plain' });
            res.end('');
        });
        return;
    }
    
    if (pathname === '/api/csrf-token' && req.method === 'GET') {
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ token: req.session?.csrfToken || null }));
    }
    
    // API Routes
    
    // Login endpoint
    if (pathname === '/api/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body || '{}');
                const { username, email, identifier, password, csrfToken } = data || {};
                if (!enforceCsrf(req, res, csrfToken)) return;

                const rateLimit = checkLoginRateLimit(clientIP);
                if (!rateLimit.allowed) {
                    setNoCacheHeaders(res);
                    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': rateLimit.retryAfter });
                    return res.end(JSON.stringify({
                        error: 'Too many login attempts. Please try again later.',
                        retryAfter: rateLimit.retryAfter
                    }));
                }

                const emailCandidate = (email || identifier || username || '').trim().toLowerCase();
                if (!emailCandidate || !password) {
                    setNoCacheHeaders(res);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Email and password are required' }));
                }

                const user = await findUserByEmail(emailCandidate);
                if (!user || !user.password_hash) {
                    recordLoginAttempt(clientIP);
                    setNoCacheHeaders(res);
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Invalid credentials' }));
                }

                const passwordMatches = await bcrypt.compare(password || '', user.password_hash);
                if (!passwordMatches) {
                    recordLoginAttempt(clientIP);
                    setNoCacheHeaders(res);
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Invalid credentials' }));
                }

                req.session.userId = user.id;
                req.session.brandId = user.brand_id || null;
                req.session.isSuperAdmin = Boolean(user.is_super_admin);
                req.user = user;

                loginAttemptsMap.delete(clientIP);

                const token = encodeAuthToken(user);
                setAuthTokenCookie(res, token, requestIsSecure);

                setNoCacheHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({
                    success: true,
                    token,
                    user: {
                        id: user.id,
                        email: user.email,
                        brand_id: user.brand_id || null,
                        is_super_admin: Boolean(user.is_super_admin)
                    }
                }));
            } catch (error) {
                console.error('[Auth] Login error:', error.message);
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid request data' }));
            }
        });
        return;
    }

    if (pathname === '/api/me' && req.method === 'GET') {
        (async () => {
            const user = await requireAuth(req, res);
            if (!user) return;
            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ user: sanitizeUser(user) }));
        })();
        return;
    }

    if (pathname === '/api/logout' && req.method === 'POST') {
        if (req.session) {
            delete req.session.userId;
            delete req.session.brandId;
            delete req.session.isSuperAdmin;
        }
        req.user = null;
        clearAuthTokenCookie(res, requestIsSecure);
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }

    if (pathname === '/api/brands' && req.method === 'GET') {
        (async () => {
            const user = await requireAuth(req, res);
            if (!user) return;
            if (!user.is_super_admin) {
                setNoCacheHeaders(res);
                res.writeHead(403, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Super admin access required' }));
            }
            try {
                const [brandsData, campaignsData] = await Promise.all([loadBrands(), loadCampaigns()]);
                const brands = toBrandList(brandsData);
                const campaigns = toCampaignList(campaignsData);
                const counts = countCampaignsByBrand(campaigns);
                const payload = brands.map(brand => ({
                    id: brand.id,
                    name: brand.name,
                    created_at: brand.created_at,
                    campaign_count: counts[brand.id] || 0
                }));
                setNoCacheHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ brands: payload }));
            } catch (error) {
                console.error('[Brands] Failed to load brands:', error.message);
                setNoCacheHeaders(res);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to load brands' }));
            }
        })();
        return;
    }

    if (pathname === '/api/brands' && req.method === 'POST') {
        (async () => {
            const user = await requireSuperAdmin(req, res);
            if (!user) return;
            let payload;
            try {
                payload = await readJsonBody(req);
            } catch (error) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
            }
            if (!enforceCsrf(req, res, payload?.csrfToken)) return;
            delete payload.csrfToken;
            const name = (payload?.name || '').trim();
            if (!name) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Brand name is required' }));
            }
            try {
                const brandsData = await loadBrands();
                const brands = toBrandList(brandsData);
                const normalized = name.toLowerCase();
                if (brands.some(brand => brand.name.toLowerCase() === normalized)) {
                    setNoCacheHeaders(res);
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Brand name must be unique' }));
                }
                const createdAt = new Date().toISOString();
                const brand = { id: generateBrandId(), name, created_at: createdAt };
                const nextBrands = [...brands, brand];
                await saveBrands(buildBrandsPayload(brandsData, nextBrands));
                invalidateBrandCache('async-save');
                setNoCacheHeaders(res);
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, brand }));
            } catch (error) {
                console.error('[Brands] Failed to create brand:', error.message);
                setNoCacheHeaders(res);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to create brand' }));
            }
        })();
        return;
    }

    if (pathname.startsWith('/api/brands/') && req.method === 'PUT') {
        (async () => {
            const user = await requireSuperAdmin(req, res);
            if (!user) return;
            if (!enforceCsrf(req, res)) return;
            const brandId = pathname.split('/')[3];
            let payload;
            try {
                payload = await readJsonBody(req);
            } catch (error) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
            }
            if (!enforceCsrf(req, res, payload?.csrfToken)) return;
            delete payload.csrfToken;
            const name = (payload?.name || '').trim();
            if (!name) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Brand name is required' }));
            }
            try {
                const brandsData = await loadBrands();
                const brands = toBrandList(brandsData);
                const index = brands.findIndex(brand => brand.id === brandId);
                if (index === -1) {
                    setNoCacheHeaders(res);
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Brand not found' }));
                }
                const normalized = name.toLowerCase();
                if (brands.some((brand, idx) => idx !== index && brand.name.toLowerCase() === normalized)) {
                    setNoCacheHeaders(res);
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Brand name must be unique' }));
                }
                const updatedBrand = {
                    ...brands[index],
                    name,
                    updated_at: new Date().toISOString()
                };
                brands[index] = updatedBrand;
                await saveBrands(buildBrandsPayload(brandsData, brands));
                invalidateBrandCache('async-save');
                setNoCacheHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ brand: updatedBrand }));
            } catch (error) {
                console.error(`[Brands] Failed to update brand ${brandId}:`, error.message);
                setNoCacheHeaders(res);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to update brand' }));
            }
        })();
        return;
    }

    if (pathname.startsWith('/api/brands/') && req.method === 'DELETE') {
        (async () => {
            const user = await requireSuperAdmin(req, res);
            if (!user) return;
            const brandId = pathname.split('/')[3];
            try {
                const [brandsData, campaignsData] = await Promise.all([loadBrands(), loadCampaigns()]);
                const brands = toBrandList(brandsData);
                const index = brands.findIndex(brand => brand.id === brandId);
                if (index === -1) {
                    setNoCacheHeaders(res);
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Brand not found' }));
                }
                const campaigns = toCampaignList(campaignsData);
                const hasCampaigns = campaigns.some(campaign => {
                    const campaignBrandId = campaign?.brand_id || campaign?.brandId || null;
                    return campaignBrandId === brandId;
                });
                if (hasCampaigns) {
                    setNoCacheHeaders(res);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Cannot delete brand with campaigns' }));
                }
                brands.splice(index, 1);
                await saveBrands(buildBrandsPayload(brandsData, brands));
                invalidateBrandCache('async-save');
                setNoCacheHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (error) {
                console.error(`[Brands] Failed to delete brand ${brandId}:`, error.message);
                setNoCacheHeaders(res);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to delete brand' }));
            }
        })();
        return;
    }

    if (pathname === '/api/admin/integrity' && req.method === 'GET') {
        (async () => {
            const user = await requireSuperAdmin(req, res);
            if (!user) return;
            try {
                const report = runIntegrityChecks();
                setNoCacheHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(report));
            } catch (error) {
                sendJsonError(res, error);
            }
        })();
        return;
    }

    if (pathname === '/api/users' && req.method === 'GET') {
        (async () => {
            const user = await requireSuperAdmin(req, res);
            if (!user) return;
            try {
                const users = getUsers();
                const brandMap = new Map(getBrands().map(brand => [brand.id, brand.name]));
                const payload = users.map(u => buildUserAdminResponse(u, brandMap));
                setNoCacheHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ users: payload }));
            } catch (error) {
                console.error('[Users] Failed to load users:', error.message);
                setNoCacheHeaders(res);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Failed to load users' }));
            }
        })();
        return;
    }

    if (pathname === '/api/users' && req.method === 'POST') {
        (async () => {
            const user = await requireSuperAdmin(req, res);
            if (!user) return;
            let payload;
            try {
                payload = await readJsonBody(req);
            } catch (error) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
            }
            if (!enforceCsrf(req, res, payload?.csrfToken)) return;
            delete payload.csrfToken;

            const email = typeof payload?.email === 'string' ? payload.email.trim().toLowerCase() : '';
            if (!email) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Email is required' }));
            }

            const password = typeof payload?.password === 'string' ? payload.password : '';
            if (password.length < 6) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Password must be at least 6 characters' }));
            }

            const rawBrandId = (payload?.brand_id ?? payload?.brandId);
            const brandId = typeof rawBrandId === 'string' ? rawBrandId.trim() : '';
            if (!brandId) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'brand_id is required' }));
            }

            const brand = getBrandById(brandId);
            if (!brand) {
                setNoCacheHeaders(res);
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Brand not found' }));
            }
            if (!enforceCsrf(req, res, payload?.csrfToken)) return;
            delete payload.csrfToken;

            const store = readUserStore();
            const users = store.users;
            if (users.some(existing => existing.email === email)) {
                setNoCacheHeaders(res);
                res.writeHead(409, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Email already in use' }));
            }

            const now = new Date().toISOString();
            const created = {
                id: `user_${Date.now()}`,
                email,
                password_hash: hashPassword(password),
                brand_id: brandId,
                is_super_admin: Boolean(payload?.is_super_admin ?? payload?.isSuperAdmin),
                created_at: now,
                updated_at: now
            };

            users.push(created);
            writeUserStore(users);

            setNoCacheHeaders(res);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                user: {
                    id: created.id,
                    email: created.email,
                    brand_id: created.brand_id,
                    is_super_admin: created.is_super_admin
                }
            }));
        })();
        return;
    }

    if (pathname.startsWith('/api/users/') && req.method === 'PUT') {
        (async () => {
            const user = await requireSuperAdmin(req, res);
            if (!user) return;
            if (!enforceCsrf(req, res)) return;
            const userId = pathname.split('/')[3];
            if (!userId) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'User ID is required' }));
            }

            let payload;
            try {
                payload = await readJsonBody(req);
            } catch (error) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Invalid JSON payload' }));
            }

            const store = readUserStore();
            const index = store.users.findIndex(u => u.id === userId);
            if (index === -1) {
                setNoCacheHeaders(res);
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'User not found' }));
            }

            const target = { ...store.users[index] };
            const brands = getBrands();
            const brandMap = new Map(brands.map(brand => [brand.id, brand.name]));

            if (Object.prototype.hasOwnProperty.call(payload || {}, 'email')) {
                if (typeof payload.email !== 'string') {
                    setNoCacheHeaders(res);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Email must be a string' }));
                }
                const normalizedEmail = payload.email.trim().toLowerCase();
                if (!normalizedEmail) {
                    setNoCacheHeaders(res);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Email cannot be empty' }));
                }
                const duplicate = store.users.some(u => u.id !== userId && u.email === normalizedEmail);
                if (duplicate) {
                    setNoCacheHeaders(res);
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Email already in use' }));
                }
                target.email = normalizedEmail;
            }

            const brandFieldProvided = Object.prototype.hasOwnProperty.call(payload || {}, 'brand_id') || Object.prototype.hasOwnProperty.call(payload || {}, 'brandId');
            if (brandFieldProvided) {
                const rawBrand = Object.prototype.hasOwnProperty.call(payload, 'brand_id') ? payload.brand_id : payload.brandId;
                const brandId = typeof rawBrand === 'string' ? rawBrand.trim() : '';
                if (!brandId) {
                    setNoCacheHeaders(res);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'brand_id is required' }));
                }
                if (!brandMap.has(brandId)) {
                    setNoCacheHeaders(res);
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Brand not found' }));
                }
                target.brand_id = brandId;
            }

            const superFlagProvided = Object.prototype.hasOwnProperty.call(payload || {}, 'is_super_admin') || Object.prototype.hasOwnProperty.call(payload || {}, 'isSuperAdmin');
            if (superFlagProvided) {
                const rawValue = Object.prototype.hasOwnProperty.call(payload, 'is_super_admin') ? payload.is_super_admin : payload.isSuperAdmin;
                if (typeof rawValue !== 'boolean') {
                    setNoCacheHeaders(res);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'is_super_admin must be a boolean' }));
                }
                if (user.id === userId && target.is_super_admin && rawValue === false) {
                    setNoCacheHeaders(res);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Cannot remove your own super admin status' }));
                }
                target.is_super_admin = rawValue;
            }

            if (Object.prototype.hasOwnProperty.call(payload || {}, 'password')) {
                if (typeof payload.password !== 'string' || payload.password.length < 6) {
                    setNoCacheHeaders(res);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Password must be at least 6 characters' }));
                }
                target.password_hash = hashPassword(payload.password);
            }

            target.updated_at = new Date().toISOString();
            store.users[index] = target;
            writeUserStore(store.users);

            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ user: buildUserAdminResponse(target, brandMap) }));
        })();
        return;
    }

    
    if (pathname.startsWith('/api/users/') && req.method === 'DELETE') {
        (async () => {
            const user = await requireSuperAdmin(req, res);
            if (!user) return;
            const userId = pathname.split('/')[3];
            if (!userId) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'User ID is required' }));
            }

            if (user.id === userId) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'You cannot delete your own account' }));
            }

            const store = readUserStore();
            const index = store.users.findIndex(u => u.id === userId);
            if (index === -1) {
                setNoCacheHeaders(res);
                res.writeHead(404, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'User not found' }));
            }

            store.users.splice(index, 1);
            writeUserStore(store.users);

            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        })();
        return;
    }

    if (pathname === '/api/campaigns' && req.method === 'GET') {
        (async () => {
            const user = await requireAuth(req, res);
            if (!user) return;
            const url = new URL(req.url, `http://${req.headers.host}`);
            const requestedPage = parseInt(url.searchParams.get('page'), 10);
            const requestedLimit = parseInt(url.searchParams.get('limit'), 10);
            const brandFilterParam = url.searchParams.get('brandId');
            const limit = Number.isFinite(requestedLimit) ? Math.min(MAX_CAMPAIGN_LIMIT, Math.max(1, requestedLimit)) : DEFAULT_CAMPAIGN_LIMIT;
            const page = Number.isFinite(requestedPage) ? Math.max(DEFAULT_CAMPAIGN_PAGE, requestedPage) : DEFAULT_CAMPAIGN_PAGE;
            try {
                const campaigns = getCampaigns();
                const userBrandId = getUserBrandId(user);
                let entries = Object.entries(campaigns);
                if (user.is_super_admin) {
                    const brandFilter = (brandFilterParam || '').trim();
                    if (brandFilter) {
                        entries = entries.filter(([, data]) => getCampaignBrandId(data) === brandFilter);
                    }
                } else {
                    entries = entries.filter(([, data]) => getCampaignBrandId(data) === userBrandId);
                }
                const total = entries.length;
                const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
                const currentPage = totalPages === 0 ? DEFAULT_CAMPAIGN_PAGE : Math.min(Math.max(page, DEFAULT_CAMPAIGN_PAGE), totalPages);
                const offset = (currentPage - 1) * limit;
                const slice = total === 0 ? [] : entries.slice(offset, offset + limit);
                const list = slice.map(([id, data]) => ({
                    id,
                    name: data.productName,
                    merchant: data.merchantName,
                    price: data.pricing?.initialPrice || data.originalPrice
                }));
                console.log(`User ${user.email || user.id || 'unknown'} (brand ${userBrandId || 'none'}) requested campaigns page ${currentPage}/${totalPages || 1} size ${limit}, returning ${list.length} records`);
                setNoCacheHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    campaigns: list,
                    pagination: {
                        page: currentPage,
                        limit,
                        total,
                        totalPages
                    }
                }));
            } catch (error) {
                sendJsonError(res, error);
            }
        })();
        return;
    }
    
    if (pathname.startsWith('/api/campaign/') && req.method === 'GET' && pathname.split('/').length === 4) {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        (async () => {
            const access = await requireCampaignAccess(req, res, campaignId, { denyAsNotFound: true });
            if (!access) return;
            const { campaign } = access;
            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(campaign));
        })();
        return;
    }
    
    if (pathname.startsWith('/api/campaign/') && req.method === 'PUT' && pathname.split('/').length === 4) {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let data;
            try {
                data = JSON.parse(body);
            } catch (parseError) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Invalid data' }));
            }

            if (!enforceCsrf(req, res, data?.csrfToken)) return;
            delete data.csrfToken;

            (async () => {
                const access = await requireCampaignAccess(req, res, campaignId);
                if (!access) return;
                const { user, campaign } = access;
                const currentBrandId = getCampaignBrandId(campaign);
                let targetBrandId = currentBrandId;
                if (user.is_super_admin) {
                    targetBrandId = data.brandId || data.brand_id || currentBrandId;
                } else {
                    delete data.brandId;
                    delete data.brand_id;
                }

                const updated = { ...campaign, ...data, id: campaignId };
                updated.brandId = targetBrandId;
                updated.brand_id = targetBrandId;

                let persistedCampaign;
                try {
                    persistedCampaign = saveCampaign(campaignId, updated, { brandId: targetBrandId });
                } catch (error) {
                    return sendJsonError(res, error);
                }
                if (!persistedCampaign) { setNoCacheHeaders(res); res.writeHead(500); return res.end(JSON.stringify({ error: 'Failed to save' })); }

                setNoCacheHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, campaignId, campaign: persistedCampaign }));
            })();
        });
        return;
    }
    
    if (pathname.startsWith('/api/campaign/') && req.method === 'DELETE' && pathname.split('/').length === 4) {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        if (!enforceCsrf(req, res)) return;
        (async () => {
            const access = await requireCampaignAccess(req, res, campaignId);
            if (!access) return;
            try {
                if (!deleteCampaign(campaignId)) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
            } catch (error) {
                return sendJsonError(res, error);
            }
            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        })();
        return;
    }
    
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/config') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        (async () => {
            const access = await requireCampaignAccess(req, res, campaignId, { denyAsNotFound: true });
            if (!access) return;
            let config;
            try {
                config = getCampaignConfig(campaignId);
            } catch (error) {
                return sendJsonError(res, error);
            }
            if (!config) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config));
        })();
        return;
    }


    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/buyers') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        (async () => {
            const access = await requireCampaignAccess(req, res, campaignId, { denyAsNotFound: true });
            if (!access) return;
            const { campaign } = access;
            const pricing = campaign.pricing || {};
            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ currentBuyers: (pricing.initialBuyers || campaign.initialBuyers || 0) + getParticipants(campaignId).length }));
        })();
        return;
    }


    // Campaign stats endpoint (SMS sent count, etc.)
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/stats') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        (async () => {
            const access = await requireCampaignAccess(req, res, campaignId, { denyAsNotFound: true });
            if (!access) return;
            const stats = getCampaignStats(campaignId);
            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(stats));
        })();
        return;
    }

    // Export campaign participants as CSV
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/export') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        (async () => {
            const access = await requireCampaignAccess(req, res, campaignId, { denyAsNotFound: true });
            if (!access) return;
            const { campaign } = access;

            const participants = getParticipants(campaignId);
            const headers = ['Phone', 'Email', 'Referral Code', 'Referred By', 'Joined Date'];
            const rows = participants.map(p => [
                p.phone || '',
                p.email || '',
                p.referralCode || '',
                p.referredBy || '',
                p.joinedAt ? new Date(p.joinedAt).toLocaleString() : ''
            ]);

            const escapeCsv = (value) => {
                const str = String(value);
                if (str.includes(',') || str.includes('\"') || str.includes('\n')) {
                    return '\"' + str.replace(/\"/g, '\"\"') + '\"';
                }
                return str;
            };

            const csvContent = [
                headers.join(','),
                ...rows.map(row => row.map(escapeCsv).join(','))
            ].join('\n');

            const safeCampaignName = (campaign.productName || 'campaign').replace(/[^a-zA-Z0-9_-]/g, '-');
            const filename = `${safeCampaignName}-${campaignId}-participants.csv`;

            setNoCacheHeaders(res);
            res.writeHead(200, {
                'Content-Type': 'text/csv; charset=utf-8',
                'Content-Disposition': `attachment; filename="${filename}"`
            });
            res.end(csvContent);
        })();
        return;
    }

    if (pathname === '/api/campaigns' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let data;
            try {
                data = JSON.parse(body);
            } catch (parseError) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Invalid data' }));
            }

            if (!enforceCsrf(req, res, data?.csrfToken)) return;
            delete data.csrfToken;

            (async () => {
                const user = await requireAuth(req, res);
                if (!user) return;

                let campaignId = data.id ? String(data.id) : generateCampaignId();
                if (data.id && !isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }

                let campaigns;
                try {
                    campaigns = getCampaigns();
                } catch (error) {
                    return sendJsonError(res, error);
                }

                if (campaigns[campaignId]) { setNoCacheHeaders(res); res.writeHead(409); return res.end(JSON.stringify({ error: 'Campaign ID already exists' })); }

                const userBrandId = getUserBrandId(user);
                let targetBrandId = user.is_super_admin ? (data.brandId || data.brand_id || userBrandId) : userBrandId;
                if (!user.is_super_admin) {
                    delete data.brandId;
                    delete data.brand_id;
                }
                if (!targetBrandId && !user.is_super_admin) {
                    setNoCacheHeaders(res);
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'Brand assignment required' }));
                }

                const newCampaign = {
                    id: campaignId,
                    productName: data.productName || 'New Product',
                    productImage: data.productImage || '',
                    productDescription: data.productDescription || '',
                    videoUrl: data.videoUrl || '',
                    twilio: data.twilio || { enabled: false, accountSid: '', authToken: '', phoneNumber: '', domain: '' },
                    pricing: data.pricing || { initialPrice: 80, initialBuyers: 100, checkoutUrl: '', tiers: [{buyers: 100, price: 40, couponCode: ''}, {buyers: 500, price: 30, couponCode: ''}, {buyers: 1000, price: 20, couponCode: ''}] },
                    referralsNeeded: data.referralsNeeded || 2,
                    countdownEnd: data.countdownEnd || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                    description: data.productDescription || '', price: 20, originalPrice: 80, imageUrl: '', sharesRequired: data.referralsNeeded || 2,
                    discountPercentage: 75, merchantName: '', merchantLogo: '', initialBuyers: 100,
                    priceTiers: data.pricing?.tiers || [{buyers: 100, price: 40, couponCode: ''}, {buyers: 500, price: 30, couponCode: ''}, {buyers: 1000, price: 20, couponCode: ''}],
                    brandId: targetBrandId,
                    brand_id: targetBrandId
                };

                let persistedCampaign;
                try {
                    persistedCampaign = saveCampaign(campaignId, newCampaign, { brandId: targetBrandId });
                } catch (error) {
                    return sendJsonError(res, error);
                }
                if (!persistedCampaign) { setNoCacheHeaders(res); res.writeHead(500); return res.end(JSON.stringify({ error: 'Failed to save' })); }

                console.log(`User ${user.email || user.id || 'unknown'} created campaign for brand ${targetBrandId || 'none'}`);
                setNoCacheHeaders(res);
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, campaignId, campaign: persistedCampaign }));
            })();
        });
        return;
    }
    
    if (pathname === '/api/config' && req.method === 'GET') {
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getConfig()));
    }
    
    if (pathname === '/api/join' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                if (!enforceCsrf(req, res, data?.csrfToken)) return;
                delete data.csrfToken;
                if (!data.phone || !isValidPhone(data.phone)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Valid phone required' })); }
                if (!data.email || !isValidEmail(data.email)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Valid email required' })); }

                const campaignIdRaw = data.campaignId ? String(data.campaignId).trim() : '';
                if (!campaignIdRaw) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'campaignId is required' })); }
                if (!isValidCampaignId(campaignIdRaw)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
                const campaignId = campaignIdRaw;
                let campaign;
                try {
                    campaign = getCampaign(campaignId);
                } catch (error) {
                    return sendJsonError(res, error);
                }
                if (!campaign) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
                if (!isCampaignActive(campaign)) { setNoCacheHeaders(res); res.writeHead(403); return res.end(JSON.stringify({ error: 'Campaign is not active' })); }

                const referralCode = data.referredBy ? data.referredBy.trim().toUpperCase() : null;
                if (referralCode && !isValidReferralCode(referralCode)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid referral code' })); }

                const existing = findParticipantByPhone(data.phone, campaignId);
                if (existing) { setNoCacheHeaders(res); res.writeHead(409); return res.end(JSON.stringify({ error: 'Already joined', alreadyJoined: true, referralCode: existing.referralCode })); }

                let wasUnlocked = false;
                if (referralCode) {
                    wasUnlocked = hasUnlockedBestPrice(referralCode, campaignId);
                }

                const participant = addParticipant(data.phone, data.email, referralCode, campaignId);
                if (!participant) { setNoCacheHeaders(res); res.writeHead(500); return res.end(JSON.stringify({ error: 'Failed to save' })); }
                sendWelcomeSMS(participant.phone || data.phone, participant.referralCode, campaignId);

                let referrerUnlocked = false;
                if (referralCode) {
                    const newCount = getReferralCount(referralCode, campaignId);
                    const needed = Math.min(campaign?.referralsNeeded || campaign?.sharesRequired || DEFAULT_REFERRALS_NEEDED, MAX_REFERRALS);
                    referrerUnlocked = newCount >= needed;

                    if (referrerUnlocked && !wasUnlocked) {
                        const referrer = getParticipants(campaignId).find(p => p.referralCode === referralCode);
                        if (referrer) {
                            sendUnlockSMS(referrer.phone, referralCode, campaignId);
                        }
                    }
                }

                setNoCacheHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, referralCode: participant.referralCode, referrerUnlocked }));
            } catch (e) { setNoCacheHeaders(res); res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid data' })); }
        });
        return;
    }


    if (pathname === '/api/notify-me' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!enforceCsrf(req, res, data?.csrfToken)) return;
                delete data.csrfToken;
                if (!data.phone || !isValidPhone(data.phone)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Valid phone required' })); }
                if (!data.email || !isValidEmail(data.email)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Valid email required' })); }
                const result = addNotifySubscriber(data.phone, data.email);
                setNoCacheHeaders(res);
                if (result.success) {
                    res.writeHead(201, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } else if (result.error === 'Already subscribed') {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Already subscribed' }));
                } else {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: result.error }));
                }
            } catch (e) { setNoCacheHeaders(res); res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid data' })); }
        });
        return;
    }
    
    if (pathname === '/api/participants' && req.method === 'GET') {
        (async () => {
            const user = await requireAuth(req, res);
            if (!user) return;
            const participants = getParticipants();
            let payload = participants;
            if (!user.is_super_admin) {
                const userBrandId = getUserBrandId(user);
                const campaigns = getCampaigns();
                payload = participants.filter(participant => {
                    const campaignId = participant.campaignId;
                    if (!campaignId) return false;
                    const campaign = campaigns[campaignId];
                    if (!campaign) return false;
                    return getCampaignBrandId(campaign) === userBrandId;
                });
            }
            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(payload));
        })();
        return;
    }


    if (pathname.startsWith('/api/referral/') && req.method === 'GET') {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const campaignId = url.searchParams.get('campaignId');
        const referralCode = pathname.split('/')[3];
        if (!referralCode || !isValidReferralCode(referralCode)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Valid referral code required' })); }
        if (!campaignId) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'campaignId query parameter is required' })); }
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        try {
            if (!getCampaign(campaignId)) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        } catch (error) {
            return sendJsonError(res, error);
        }
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getReferralStatus(referralCode, campaignId)));
    }

    if (pathname.startsWith('/api/referral/') && ['POST', 'PUT'].includes(req.method)) {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const campaignId = url.searchParams.get('campaignId');
        if (!campaignId || !isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Valid campaignId query parameter is required' })); }
        (async () => {
            const access = await requireCampaignAccess(req, res, campaignId, { denyAsNotFound: true });
            if (!access) return;
            setNoCacheHeaders(res);
            res.writeHead(405, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Method not implemented' }));
        })();
        return;
    }


    if (pathname === '/api/sms/webhook' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const params = new URLSearchParams(body);
                const from = params.get('From');
                const message = (params.get('Body') || '').trim().toUpperCase();
                if (['STOP', 'UNSUBSCRIBE', 'CANCEL'].includes(message)) await handleOptOut(from);
                else if (['START', 'YES', 'SUBSCRIBE'].includes(message)) await handleOptIn(from);
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
            } catch (e) { res.writeHead(200, { 'Content-Type': 'text/xml' }); res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>'); }
        });
        return;
    }
    
    // Static files - with path traversal protection
    let filePath = pathname === '/' ? '/index.html' : pathname;
    
    // Sanitize pathname: remove null bytes
    filePath = filePath.replace(/\0/g, '');
    
    // Block path traversal attempts: reject any path containing ..
    if (filePath.includes('..')) {
        res.writeHead(403); 
        return res.end('Forbidden');
    }
    
    // Allow specific data files needed by the frontend
    if (filePath === '/data/campaigns.json') {
        // Let it through to be handled by the static file server below
    }
    // Block absolute paths (Unix and Windows)
    else if (filePath.startsWith('/') && filePath.length > 1 && !filePath.startsWith('/index.html') && !filePath.startsWith('/app.js') && !filePath.startsWith('/styles.css') && !filePath.startsWith('/admin.html') && !filePath.startsWith('/login.html') && !filePath.startsWith('/terms.html') && !filePath.startsWith('/admin.css')) {
        // Allow only specific root-level files, block other absolute paths
        const allowedRootFiles = ['/index.html', '/app.js', '/styles.css', '/admin.html', '/login.html', '/terms.html', '/admin.js', '/admin.css', '/login.js', '/campaign-loader.js', '/csrf.js', '/favicon.ico'];
        const baseName = '/' + filePath.split('/').pop();
        if (!allowedRootFiles.includes(baseName)) {
            res.writeHead(403);
            return res.end('Forbidden');
        }
    }
    
    // Resolve the full path and ensure it's within the app directory
    const fullPath = path.resolve(__dirname, '.' + filePath);
    const rootPath = path.resolve(__dirname);
    
    // Ensure resolved path is within the app directory (with trailing separator check)
    const rootPathWithSep = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
    if (!fullPath.startsWith(rootPathWithSep) && fullPath !== rootPath) {
        res.writeHead(403); 
        return res.end('Forbidden');
    }
    
    filePath = fullPath;
    const ext = path.extname(filePath).toLowerCase();
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') { res.writeHead(404); res.end('Not Found'); }
            else { res.writeHead(500); res.end('Server Error'); }
        } else {
            const headers = { 'Content-Type': MIME_TYPES[ext] || 'application/octet-stream' };
            // Add no-cache headers for HTML files
            if (ext === '.html') {
                headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
                headers['Pragma'] = 'no-cache';
                headers['Expires'] = '0';
            }
            // Never cache campaigns.json - always serve fresh data
            if (pathname === '/data/campaigns.json') {
                headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, proxy-revalidate';
                headers['Pragma'] = 'no-cache';
                headers['Expires'] = '0';
            }
            res.writeHead(200, headers);
            res.end(content);
        }
    });
});

function startServer() {
    server.listen(PORT, () => {
        console.log(`🎯 Group Buying Server running at http://localhost:${PORT}`);
        let campaignsForLog;
        try {
            campaignsForLog = getCampaigns();
        } catch (error) {
            logCampaignValidationError(error, 'Startup Validation');
            console.error('[Startup Validation] Unable to continue until campaign data is fixed. Shutting down.');
            process.exit(1);
        }
        console.log(`Campaigns: ${Object.keys(campaignsForLog).join(', ') || 'none'}`);
        
        // Start the reminder SMS scheduler
        console.log(`[Reminder SMS] Starting scheduler (checking every ${REMINDER_CHECK_INTERVAL / 60000} minutes)`);
        scheduleReminderSMS().catch(error => logCampaignValidationError(error, 'Reminder SMS')); // Run immediately on startup
        setInterval(() => {
            scheduleReminderSMS().catch(error => logCampaignValidationError(error, 'Reminder SMS'));
        }, REMINDER_CHECK_INTERVAL);
    });
}

if (require.main === module) {
    startServer();
}

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

module.exports = {
    server,
    startServer,
    normalizePhone,
    isValidPhone,
    isValidEmail,
    isValidCampaignId,
    isValidReferralCode,
    sanitizePhoneInput,
    formatPhoneE164,
    CampaignValidationError,
    ensureCampaignValid,
    validateCampaignCollection,
    signToken,
    verifyToken,
    buildAuthPayload
};
