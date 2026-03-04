const crypto = require('crypto');

const DEFAULT_CAMPAIGN_ID = process.env.LOAD_TEST_CAMPAIGN_ID || '005EZsfHkpI';
const DEFAULT_REFERRER = process.env.LOAD_TEST_REFERRER || '';
const DEFAULT_PHONE_PREFIX = process.env.LOAD_TEST_PHONE_PREFIX || '+1555';
const CONFIGURED_AUTH_HEADER = process.env.LOAD_TEST_AUTH_HEADER || '';
const JWT_SECRET = (process.env.JWT_SECRET && process.env.JWT_SECRET.trim()) || 'dev-only-group-buying-secret';
const JWT_TTL_INPUT = parseInt(process.env.LOAD_TEST_JWT_TTL_MS, 10);
const JWT_TTL_MS = Number.isFinite(JWT_TTL_INPUT) && JWT_TTL_INPUT > 0 ? JWT_TTL_INPUT : 60 * 60 * 1000;
const JWT_USER_ID = process.env.LOAD_TEST_USER_ID || 'user_001';
const JWT_BRAND_ID = process.env.LOAD_TEST_BRAND_ID || 'brand_001';
const JWT_SUPER_ADMIN = parseBoolean(process.env.LOAD_TEST_SUPER_ADMIN, true);
const DEBUG_HEADERS = String(process.env.DEBUG_LOAD_TEST_HEADERS || '').trim().toLowerCase() === 'true';

let userCounter = 0;
let cachedAuthHeader = CONFIGURED_AUTH_HEADER ? CONFIGURED_AUTH_HEADER : null;
let headerLogged = false;

function parseBoolean(value, fallback = false) {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
    return fallback;
}

function base64UrlEncode(value) {
    return Buffer.from(value, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function base64UrlFromBuffer(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function signJwt(payload) {
    if (!payload || typeof payload !== 'object') {
        throw new Error('Cannot sign empty JWT payload');
    }
    const headerSegment = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payloadSegment = base64UrlEncode(JSON.stringify(payload));
    const signingInput = `${headerSegment}.${payloadSegment}`;
    const signature = crypto.createHmac('sha256', JWT_SECRET).update(signingInput).digest();
    const signatureSegment = base64UrlFromBuffer(signature);
    return `${signingInput}.${signatureSegment}`;
}

function buildJwtPayload({ userId = JWT_USER_ID, brandId = JWT_BRAND_ID, isSuperAdmin = JWT_SUPER_ADMIN } = {}) {
    const issuedAt = Date.now();
    return {
        user_id: userId,
        brand_id: brandId,
        is_super_admin: Boolean(isSuperAdmin),
        timestamp: issuedAt,
        iat: issuedAt,
        exp: issuedAt + JWT_TTL_MS
    };
}

function resolveAuthHeader() {
    if (cachedAuthHeader) {
        return cachedAuthHeader;
    }
    const token = signJwt(buildJwtPayload());
    cachedAuthHeader = `Bearer ${token}`;
    return cachedAuthHeader;
}

function setupScenario(context, events, done) {
    context.vars.campaignId = DEFAULT_CAMPAIGN_ID;
    context.vars.loadTestReferrer = DEFAULT_REFERRER;
    context.vars.authHeader = resolveAuthHeader();
    context.vars.phonePrefix = DEFAULT_PHONE_PREFIX;
    if (DEBUG_HEADERS && !context.vars.__setupLogged) {
        context.vars.__setupLogged = true;
        console.log('[load-tests] setupScenario invoked');
    }
    done();
}

function injectHeaders(req, context, ee, next) {
    req.headers = req.headers || {};
    const headerValue = context.vars.authHeader || resolveAuthHeader();
    req.headers['Authorization'] = headerValue;
    req.headers['authorization'] = headerValue;
    req.headers['Content-Type'] = req.headers['Content-Type'] || 'application/json';
    req.headers['content-type'] = req.headers['Content-Type'];
    req.headers['Accept'] = req.headers['Accept'] || 'application/json';
    req.headers['accept'] = req.headers['Accept'];
    if (DEBUG_HEADERS && !headerLogged) {
        headerLogged = true;
        console.log('[load-tests] Injected headers sample:', req.headers);
    }
    next();
}

function prepareAuth(context, events, done) {
    context.vars.campaignId = context.vars.campaignId || DEFAULT_CAMPAIGN_ID;
    context.vars.loadTestReferrer = typeof context.vars.loadTestReferrer === 'string' ? context.vars.loadTestReferrer : DEFAULT_REFERRER;
    context.vars.phonePrefix = context.vars.phonePrefix || DEFAULT_PHONE_PREFIX;
    context.vars.authHeader = context.vars.authHeader || resolveAuthHeader();
    if (DEBUG_HEADERS && !context.vars.__setupLogged) {
        context.vars.__setupLogged = true;
        console.log('[load-tests] setupScenario invoked (prepareAuth fallback)');
    }
    done();
}

function generateUser(context, events, done) {
    const unique = `${Date.now().toString(36)}${(userCounter++).toString(36)}`;
    const phoneSuffix = String(1000000 + (parseInt(unique, 36) % 9000000)).slice(-7);
    const prefix = context.vars.phonePrefix || DEFAULT_PHONE_PREFIX;
    context.vars.phone = `${prefix}${phoneSuffix}`;
    context.vars.email = `loadtest+${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}@example.com`;
    done();
}

module.exports = {
    setupScenario,
    injectHeaders,
    prepareAuth,
    generateUser
};
