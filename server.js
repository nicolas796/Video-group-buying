const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_REFERRALS_NEEDED = 2;
const MAX_REFERRALS = 10;
const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 10;

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const PATHS = {
    config: path.join(DATA_DIR, 'config.json'),
    participants: path.join(DATA_DIR, 'participants.json'),
    optouts: path.join(DATA_DIR, 'optouts.json'),
    campaigns: path.join(DATA_DIR, 'campaigns.json'),
    stats: path.join(DATA_DIR, 'stats.json')
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

function initializeFiles() {
    Object.entries(PATHS).forEach(([key, filePath]) => {
        if (!fs.existsSync(filePath)) {
            const defaultData = key === 'config' ? DEFAULT_CONFIG : key === 'campaigns' || key === 'stats' ? {} : [];
            writeJson(filePath, defaultData);
        }
    });
}
initializeFiles();

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

function normalizePhone(phone) { return String(phone).replace(/\D/g, ''); }
function isValidPhone(phone) { return normalizePhone(phone).length >= 10; }
function isValidEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email); }
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

function getCampaigns() { return readJson(PATHS.campaigns) || {}; }
function getCampaign(campaignId) { return getCampaigns()[campaignId] || null; }
function saveCampaign(campaignId, campaignData) {
    const campaigns = getCampaigns();
    campaigns[campaignId] = campaignData;
    return writeJson(PATHS.campaigns, campaigns);
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
    return getParticipants(campaignId).filter(p => p.referredBy === referralCode).length;
}

function hasUnlockedBestPrice(referralCode, campaignId = null) {
    if (!referralCode) return false;
    const campaign = getCampaign(campaignId);
    const needed = Math.min(campaign?.referralsNeeded || campaign?.sharesRequired || DEFAULT_REFERRALS_NEEDED, MAX_REFERRALS);
    return getReferralCount(referralCode, campaignId) >= needed;
}

function getReferralStatus(referralCode, campaignId = null) {
    const campaign = getCampaign(campaignId);
    const count = getReferralCount(referralCode, campaignId);
    const needed = Math.min(campaign?.referralsNeeded || campaign?.sharesRequired || DEFAULT_REFERRALS_NEEDED, MAX_REFERRALS);
    const tiers = campaign?.pricing?.tiers || campaign?.priceTiers || [];
    const bestPrice = tiers.length > 0 ? Math.min(...tiers.map(t => t.price)) : 20;
    return { referralCode, referralCount: count, unlockedBestPrice: hasUnlockedBestPrice(referralCode, campaignId), bestPrice, referralsNeeded: needed, referralsRemaining: Math.max(0, needed - count) };
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
    const newParticipant = { phone, email, referralCode: generateReferralCode(), referredBy: referredBy || null, campaignId: campaignId || null, joinedAt: new Date().toISOString() };
    participants.push(newParticipant);
    return writeJson(PATHS.participants, participants) ? newParticipant : null;
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
    const campaigns = getCampaigns();
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

const server = http.createServer((req, res) => {
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${clientIP}`);
    
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }
    
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    
    // API Routes
    
    // Login endpoint
    if (pathname === '/api/login' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { username, password } = data;
                
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
        const campaigns = getCampaigns();
        const list = Object.entries(campaigns).map(([id, data]) => ({ id, name: data.productName, merchant: data.merchantName, price: data.pricing?.initialPrice || data.originalPrice }));
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(list));
    }
    
    if (pathname.startsWith('/api/campaign/') && req.method === 'GET' && pathname.split('/').length === 4) {
        const campaignId = pathname.split('/')[3];
        const campaign = getCampaign(campaignId);
        if (!campaign) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(campaign));
    }
    
    if (pathname.startsWith('/api/campaign/') && req.method === 'PUT' && pathname.split('/').length === 4) {
        const campaignId = pathname.split('/')[3];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const campaigns = getCampaigns();
                if (!campaigns[campaignId]) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
                const updated = { ...campaigns[campaignId], ...data, id: campaignId };
                if (!saveCampaign(campaignId, updated)) { setNoCacheHeaders(res); res.writeHead(500); return res.end(JSON.stringify({ error: 'Failed to save' })); }
                setNoCacheHeaders(res);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, campaignId, campaign: updated }));
            } catch (e) { setNoCacheHeaders(res); res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid data' })); }
        });
        return;
    }
    
    if (pathname.startsWith('/api/campaign/') && req.method === 'DELETE' && pathname.split('/').length === 4) {
        const campaignId = pathname.split('/')[3];
        if (!deleteCampaign(campaignId)) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ success: true }));
    }
    
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/config') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        const config = getCampaignConfig(campaignId);
        if (!config) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(config));
    }
    
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/buyers') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        const campaign = getCampaign(campaignId);
        if (!campaign) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        const pricing = campaign.pricing || {};
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ currentBuyers: (pricing.initialBuyers || campaign.initialBuyers || 0) + getParticipants(campaignId).length }));
    }
    
    // Campaign stats endpoint (SMS sent count, etc.)
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/stats') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        const campaign = getCampaign(campaignId);
        if (!campaign) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
        const stats = getCampaignStats(campaignId);
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(stats));
    }

    // Export campaign participants as CSV
    if (pathname.startsWith('/api/campaign/') && pathname.endsWith('/export') && req.method === 'GET') {
        const campaignId = pathname.split('/')[3];
        const campaign = getCampaign(campaignId);
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
            try {
                const data = JSON.parse(body);
                const campaignId = data.id || generateCampaignId();
                const campaigns = getCampaigns();
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
                if (!saveCampaign(campaignId, newCampaign)) { setNoCacheHeaders(res); res.writeHead(500); return res.end(JSON.stringify({ error: 'Failed to save' })); }
                setNoCacheHeaders(res);
                res.writeHead(201, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, campaignId, campaign: newCampaign }));
            } catch (e) { setNoCacheHeaders(res); res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid data' })); }
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
                if (!data.phone || !isValidPhone(data.phone)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Valid phone required' })); }
                if (!data.email || !isValidEmail(data.email)) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Valid email required' })); }
                if (data.campaignId && !getCampaign(data.campaignId)) { setNoCacheHeaders(res); res.writeHead(404); return res.end(JSON.stringify({ error: 'Campaign not found' })); }
                const existing = findParticipantByPhone(data.phone, data.campaignId);
                if (existing) { setNoCacheHeaders(res); res.writeHead(409); return res.end(JSON.stringify({ error: 'Already joined', alreadyJoined: true, referralCode: existing.referralCode })); }

                // Check if referrer was already unlocked BEFORE adding participant
                let wasUnlocked = false;
                if (data.referredBy) {
                    wasUnlocked = hasUnlockedBestPrice(data.referredBy, data.campaignId);
                }

                const participant = addParticipant(data.phone, data.email, data.referredBy, data.campaignId);
                if (!participant) { setNoCacheHeaders(res); res.writeHead(500); return res.end(JSON.stringify({ error: 'Failed to save' })); }
                sendWelcomeSMS(data.phone, participant.referralCode, data.campaignId);

                // Check if referrer just unlocked best price and send SMS if so
                let referrerUnlocked = false;
                if (data.referredBy) {
                    const newCount = getReferralCount(data.referredBy, data.campaignId);
                    const campaign = getCampaign(data.campaignId);
                    const needed = Math.min(campaign?.referralsNeeded || campaign?.sharesRequired || DEFAULT_REFERRALS_NEEDED, MAX_REFERRALS);
                    referrerUnlocked = newCount >= needed;

                    // If just unlocked now (wasn't unlocked before), send unlock SMS
                    if (referrerUnlocked && !wasUnlocked) {
                        const referrer = getParticipants(data.campaignId).find(p => p.referralCode === data.referredBy);
                        if (referrer) {
                            sendUnlockSMS(referrer.phone, data.referredBy, data.campaignId);
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
    
    if (pathname === '/api/participants' && req.method === 'GET') {
        setNoCacheHeaders(res);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify(getParticipants()));
    }
    
    if (pathname.startsWith('/api/referral/') && req.method === 'GET') {
        const campaignId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('campaignId');
        const referralCode = pathname.split('/')[3];
        if (!referralCode) { setNoCacheHeaders(res); res.writeHead(400); return res.end(JSON.stringify({ error: 'Referral code required' })); }
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
    
    // Static files
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);
    if (!filePath.startsWith(__dirname)) { res.writeHead(403); return res.end('Forbidden'); }
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

server.listen(PORT, () => {
    console.log(`🎯 Group Buying Server running at http://localhost:${PORT}`);
    console.log(`Campaigns: ${Object.keys(getCampaigns()).join(', ') || 'none'}`);
    
    // Start the reminder SMS scheduler
    console.log(`[Reminder SMS] Starting scheduler (checking every ${REMINDER_CHECK_INTERVAL / 60000} minutes)`);
    scheduleReminderSMS(); // Run immediately on startup
    setInterval(scheduleReminderSMS, REMINDER_CHECK_INTERVAL);
});

process.on('SIGTERM', () => { server.close(() => process.exit(0)); });
