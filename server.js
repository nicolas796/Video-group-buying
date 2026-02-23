const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const PORT = process.env.PORT || 8080;
const NODE_ENV = process.env.NODE_ENV || 'development';
const CSP_POLICY = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net",
    "img-src 'self' data: https:",
    "media-src 'self' https: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "form-action 'self'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "object-src 'none'",
    "worker-src 'self' blob:"
].join('; ');
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_REFERRALS_NEEDED = 2;
const MAX_REFERRALS = 10;
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 10;
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
const CSRF_HEADER_NAME = 'x-csrf-token';
const sessionStore = new Map();

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PATHS = {
    config: path.join(DATA_DIR, 'config.json'),
    participants: path.join(DATA_DIR, 'participants.json'),
    optouts: path.join(DATA_DIR, 'optouts.json'),
    campaigns: path.join(DATA_DIR, 'campaigns.json'),
    stats: path.join(DATA_DIR, 'stats.json'),
    notifySubscribers: path.join(DATA_DIR, 'notify-subscribers.json')
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


function initializeFiles() {
    Object.entries(PATHS).forEach(([key, filePath]) => {
        if (!fs.existsSync(filePath)) {
            const defaultData = key === 'config' ? DEFAULT_CONFIG : key === 'campaigns' || key === 'stats' ? {} : [];
            writeJson(filePath, defaultData);
        }
    });
}
initializeFiles();

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

function writeJson(filePath, data) {
    try { fs.writeFileSync(filePath, JSON.stringify(data, null, 2)); return true; } catch (e) { return false; }
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

function getCampaigns(options = {}) {
    const data = readJson(PATHS.campaigns) || {};
    const { campaigns } = validateCampaignCollection(data, { throwOnError: options.strict !== false });
    return campaigns;
}
function getCampaign(campaignId) {
    const campaigns = getCampaigns();
    return campaigns[campaignId] || null;
}
function saveCampaign(campaignId, campaignData) {
    const campaigns = getCampaigns();
    const nextCampaign = ensureCampaignValid({ ...campaignData, id: campaignId }, { context: `campaign ${campaignId}` });
    campaigns[campaignId] = nextCampaign;
    return writeJson(PATHS.campaigns, campaigns) ? nextCampaign : null;
}
function deleteCampaign(campaignId) {
    const campaigns = getCampaigns();
    if (!campaigns[campaignId]) return false;
    delete campaigns[campaignId];
    return writeJson(PATHS.campaigns, campaigns);
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

// Login rate limiting: 5 attempts per 15 minutes
const LOGIN_RATE_LIMIT_MAX = 5;
const LOGIN_RATE_LIMIT_WINDOW = 15 * 60 * 1000; // 15 minutes

// Simple hardcoded credentials for development
const ADMIN_CREDENTIALS = {
    username: 'admin',
    password: 'password123'
};

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
function checkRateLimit(ip) {
    // Bypass rate limiting for localhost
    if (isLocalhost(ip)) return { allowed: true };
    const now = Date.now();
    const requests = (rateLimitMap.get(ip) || []).filter(time => time > now - RATE_LIMIT_WINDOW);
    if (requests.length >= RATE_LIMIT_MAX) return { allowed: false, retryAfter: Math.ceil((requests[0] + RATE_LIMIT_WINDOW - now) / 1000) };
    requests.push(now);
    rateLimitMap.set(ip, requests);
    return { allowed: true };
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
function generateToken(username) {
    const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({
        username: username,
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + (24 * 60 * 60) // 24 hours
    })).toString('base64url');
    const signature = 'none';
    return `${header}.${payload}.${signature}`;
}

const MIME_TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif' };

function setNoCacheHeaders(res) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
}

function setSecurityHeaders(res) {
    res.setHeader('Content-Security-Policy', CSP_POLICY);
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
    const clientIP = ((req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')).split(',')[0].trim();
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${clientIP}`);

    const requestHost = getHostForRequest(req);
    const enforcingHttps = FORCE_HTTPS && !shouldSkipHttps(requestHost, clientIP);
    const requestIsSecure = isSecureRequest(req);

    if (enforcingHttps) {
        if (!requestIsSecure) {
            const redirectHost = requestHost || req.headers.host;
            if (redirectHost) {
                const location = `https://${redirectHost}${req.url}`;
                res.writeHead(301, { Location: location, 'Content-Type': 'text/plain' });
                return res.end('Redirecting to HTTPS');
            } else {
                res.writeHead(400, { 'Content-Type': 'text/plain' });
                return res.end('HTTPS required');
            }
        } else {
            res.setHeader('Strict-Transport-Security', HSTS_HEADER_VALUE);
        }
    }

    const session = getOrCreateSession(req, res, requestIsSecure);
    req.session = session;

    setSecurityHeaders(res);
    
    if (req.url.startsWith('/api/')) {
        const rateLimit = checkRateLimit(clientIP);
        if (!rateLimit.allowed) {
            setNoCacheHeaders(res);
            res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': rateLimit.retryAfter });
            return res.end(JSON.stringify({ error: 'Too many requests', retryAfter: rateLimit.retryAfter }));
        }
    }
    
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CSRF-Token');
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }
    
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    
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
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { username, password, csrfToken } = data || {};
                if (!enforceCsrf(req, res, csrfToken)) return;
                
                // Check login rate limit
                const rateLimit = checkLoginRateLimit(clientIP);
                if (!rateLimit.allowed) {
                    setNoCacheHeaders(res);
                    res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': rateLimit.retryAfter });
                    return res.end(JSON.stringify({ 
                        error: 'Too many login attempts. Please try again later.',
                        retryAfter: rateLimit.retryAfter 
                    }));
                }
                
                // Validate credentials
                if (username === ADMIN_CREDENTIALS.username && password === ADMIN_CREDENTIALS.password) {
                    // Generate token
                    const token = generateToken(username);
                    setNoCacheHeaders(res);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true, token }));
                } else {
                    // Record failed attempt
                    recordLoginAttempt(clientIP);
                    setNoCacheHeaders(res);
                    res.writeHead(401, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid username or password' }));
                }
            } catch (e) {
                setNoCacheHeaders(res);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid request data' }));
            }
        });
        return;
    }
    
    if (pathname === '/api/campaigns' && req.method === 'GET') {
        try {
            const campaigns = getCampaigns();
            const list = Object.entries(campaigns).map(([id, data]) => ({ id, name: data.productName, merchant: data.merchantName, price: data.pricing?.initialPrice || data.originalPrice }));
            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(list));
        } catch (error) {
            return sendJsonError(res, error);
        }
    }
    
    if (pathname.startsWith('/api/campaign/') && req.method === 'GET' && pathname.split('/').length === 4) {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        let campaign;
        try {
            campaign = getCampaign(campaignId);
        } catch (error) {
            return sendJsonError(res, error);
        }
        if (!campaign) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(campaign));
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

            let campaigns;
            try {
                campaigns = getCampaigns();
            } catch (error) {
                return sendJsonError(res, error);
            }

            if (!campaigns[campaignId]) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
            const updated = { ...campaigns[campaignId], ...data, id: campaignId };

            let persistedCampaign;
            try {
                persistedCampaign = saveCampaign(campaignId, updated);
            } catch (error) {
                return sendJsonError(res, error);
            }
            if (!persistedCampaign) { setNoCacheHeaders(res); res.writeHead(500); return res.end(JSON.stringify({ error: 'Failed to save' })); }

            setNoCacheHeaders(res);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, campaignId, campaign: persistedCampaign }));
        });
        return;
    }
    
    if (pathname.startsWith('/api/campaign/') && req.method === 'DELETE' && pathname.split('/').length === 4) {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        if (!enforceCsrf(req, res)) return;
        try {
            if (!deleteCampaign(campaignId)) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        } catch (error) {
            return sendJsonError(res, error);
        }
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }
    
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/config') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        let config;
        try {
            config = getCampaignConfig(campaignId);
        } catch (error) {
            return sendJsonError(res, error);
        }
        if (!config) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(config));
    }
    
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/buyers') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        let campaign;
        try {
            campaign = getCampaign(campaignId);
        } catch (error) {
            return sendJsonError(res, error);
        }
        if (!campaign) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        const pricing = campaign.pricing || {};
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ currentBuyers: (pricing.initialBuyers || campaign.initialBuyers || 0) + getParticipants(campaignId).length }));
    }
    
    // Campaign stats endpoint (SMS sent count, etc.)
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/stats') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        let campaign;
        try {
            campaign = getCampaign(campaignId);
        } catch (error) {
            return sendJsonError(res, error);
        }
        if (!campaign) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        const stats = getCampaignStats(campaignId);
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(stats));
    }

    // Export campaign participants as CSV
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/export') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        if (!isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
        let campaign;
        try {
            campaign = getCampaign(campaignId);
        } catch (error) {
            return sendJsonError(res, error);
        }
        if (!campaign) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        
        // Get participants for this campaign
        const participants = getParticipants(campaignId);
        
        // Create CSV content
        const headers = ['Phone', 'Email', 'Referral Code', 'Referred By', 'Joined Date'];
        const rows = participants.map(p => [
            p.phone || '',
            p.email || '',
            p.referralCode || '',
            p.referredBy || '',
            p.joinedAt ? new Date(p.joinedAt).toLocaleString() : ''
        ]);
        
        // Escape CSV values and build CSV string
        const escapeCsv = (value) => {
            const str = String(value);
            if (str.includes(',') || str.includes('"') || str.includes('\n')) {
                return '"' + str.replace(/"/g, '""') + '"';
            }
            return str;
        };
        
        const csvContent = [
            headers.join(','),
            ...rows.map(row => row.map(escapeCsv).join(','))
        ].join('\n');
        
        // Generate filename
        const safeCampaignName = (campaign.productName || 'campaign').replace(/[^a-zA-Z0-9_-]/g, '-');
        const filename = `${safeCampaignName}-${campaignId}-participants.csv`;
        
        setNoCacheHeaders(res);
        res.writeHead(200, { 
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`
        });
        return res.end(csvContent);
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

            let campaignId = data.id ? String(data.id) : generateCampaignId();
            if (data.id && !isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }

            let campaigns;
            try {
                campaigns = getCampaigns();
            } catch (error) {
                return sendJsonError(res, error);
            }

            if (campaigns[campaignId]) { setNoCacheHeaders(res); res.writeHead(409); return res.end(JSON.stringify({ error: 'Campaign ID already exists' })); }
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
                priceTiers: data.pricing?.tiers || [{buyers: 100, price: 40, couponCode: ''}, {buyers: 500, price: 30, couponCode: ''}, {buyers: 1000, price: 20, couponCode: ''}]
            };

            let persistedCampaign;
            try {
                persistedCampaign = saveCampaign(campaignId, newCampaign);
            } catch (error) {
                return sendJsonError(res, error);
            }
            if (!persistedCampaign) { setNoCacheHeaders(res); res.writeHead(500); return res.end(JSON.stringify({ error: 'Failed to save' })); }

            setNoCacheHeaders(res);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, campaignId, campaign: persistedCampaign }));
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

                const campaignId = data.campaignId ? String(data.campaignId) : null;
                if (campaignId && !isValidCampaignId(campaignId)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
                let campaign = null;
                if (campaignId) {
                    try {
                        campaign = getCampaign(campaignId);
                    } catch (error) {
                        return sendJsonError(res, error);
                    }
                    if (!campaign) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
                }

                const referralCode = data.referredBy ? data.referredBy.trim().toUpperCase() : null;
                if (referralCode && !isValidReferralCode(referralCode)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid referral code' })); }

                const existing = findParticipantByPhone(data.phone, campaignId);
                if (existing) { setNoCacheHeaders(res); res.writeHead(409); return res.end(JSON.stringify({ error: 'Already joined', alreadyJoined: true, referralCode: existing.referralCode })); }

                // Check if referrer was already unlocked BEFORE adding participant
                let wasUnlocked = false;
                if (referralCode) {
                    wasUnlocked = hasUnlockedBestPrice(referralCode, campaignId);
                }

                const participant = addParticipant(data.phone, data.email, referralCode, campaignId);
                if (!participant) { setNoCacheHeaders(res); res.writeHead(500); return res.end(JSON.stringify({ error: 'Failed to save' })); }
                sendWelcomeSMS(participant.phone || data.phone, participant.referralCode, campaignId);

                // Check if referrer just unlocked best price and send SMS if so
                let referrerUnlocked = false;
                if (referralCode) {
                    const newCount = getReferralCount(referralCode, campaignId);
                    const needed = Math.min(campaign?.referralsNeeded || campaign?.sharesRequired || DEFAULT_REFERRALS_NEEDED, MAX_REFERRALS);
                    referrerUnlocked = newCount >= needed;

                    // If just unlocked now (wasn't unlocked before), send unlock SMS
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
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getParticipants()));
    }
    
    if (pathname.startsWith('/api/referral/') && req.method === 'GET') {
        const campaignIdParam = new URL(req.url, `http://${req.headers.host}`).searchParams.get('campaignId');
        const referralCode = pathname.split('/')[3];
        if (!referralCode || !isValidReferralCode(referralCode)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Valid referral code required' })); }
        let campaignId = null;
        if (campaignIdParam) {
            if (!isValidCampaignId(campaignIdParam)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid campaign ID format' })); }
            campaignId = campaignIdParam;
            try {
                if (!getCampaign(campaignId)) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
            } catch (error) {
                return sendJsonError(res, error);
            }
        }
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getReferralStatus(referralCode, campaignId)));
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
    validateCampaignCollection
};
