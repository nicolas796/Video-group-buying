const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// ============================================
// CONFIGURATION
// ============================================
const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const DEFAULT_REFERRALS_NEEDED = 2;
const MAX_REFERRALS = 10;
const RATE_LIMIT_WINDOW = 60000; // 1 minute
const RATE_LIMIT_MAX = 10; // requests per window

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// File paths
const PATHS = {
    config: path.join(DATA_DIR, 'config.json'),
    participants: path.join(DATA_DIR, 'participants.json'),
    optouts: path.join(DATA_DIR, 'optouts.json')
};

// Default configuration
const DEFAULT_CONFIG = {
    initialBuyers: 500,
    initialPrice: 80,
    priceTiers: [
        {buyers: 100, price: 40},
        {buyers: 500, price: 30},
        {buyers: 1000, price: 20}
    ],
    countdownEnd: '2026-02-20T14:00:00-05:00',
    videoSource: 'https://vod.estreamly.com/assets/994758e3-c35f-4e26-9512-1babf10b6207/HLS/jUVhs_DTuiA6FDuYM_720.m3u8',
    product: {
        image: 'https://cdn.shopify.com/s/files/1/0576/9848/4364/files/478-Range-Rider-Denim.png?v=1763760948',
        name: '478 Range Rider Denim',
        description: 'Come in 3 sizes'
    },
    twilio: {
        accountSid: '',
        authToken: '',
        phoneNumber: '',
        enabled: false
    },
    referralsNeeded: DEFAULT_REFERRALS_NEEDED,
    domain: 'https://your-domain.com'
};

// Initialize files if they don't exist
function initializeFiles() {
    Object.entries(PATHS).forEach(([key, filePath]) => {
        if (!fs.existsSync(filePath)) {
            const defaultData = key === 'config' ? DEFAULT_CONFIG : (key === 'optouts' ? [] : []);
            writeJson(filePath, defaultData);
        }
    });
}

initializeFiles();

// ============================================
// UTILITIES
// ============================================

/**
 * Read JSON file safely
 */
function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        console.error(`Error reading ${filePath}:`, e.message);
        return null;
    }
}

/**
 * Write JSON file safely
 */
function writeJson(filePath, data) {
    try {
        fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        return true;
    } catch (e) {
        console.error(`Error writing ${filePath}:`, e.message);
        return false;
    }
}

/**
 * Normalize phone number (remove non-digits)
 */
function normalizePhone(phone) {
    return String(phone).replace(/\D/g, '');
}

/**
 * Validate phone number format
 */
function isValidPhone(phone) {
    const normalized = normalizePhone(phone);
    // Basic US phone validation (10 digits)
    return normalized.length >= 10 && normalized.length <= 15;
}

/**
 * Validate email format
 */
function isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
}

/**
 * Generate unique referral code
 */
function generateReferralCode() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/**
 * Get current config with computed values
 */
function getConfig() {
    const config = readJson(PATHS.config) || DEFAULT_CONFIG;
    const participants = readJson(PATHS.participants) || [];
    config.currentBuyers = (config.initialBuyers || 0) + participants.length;
    return config;
}

/**
 * Get all participants
 */
function getParticipants() {
    return readJson(PATHS.participants) || [];
}

// ============================================
// REFERRAL LOGIC
// ============================================

/**
 * Count successful referrals for a user
 */
function getReferralCount(referralCode) {
    const participants = getParticipants();
    return participants.filter(p => p.referredBy === referralCode).length;
}

/**
 * Check if user has unlocked best price via referrals
 */
function hasUnlockedBestPrice(referralCode) {
    if (!referralCode) return false;
    const config = getConfig();
    const referralsNeeded = Math.min(config.referralsNeeded || DEFAULT_REFERRALS_NEEDED, MAX_REFERRALS);
    return getReferralCount(referralCode) >= referralsNeeded;
}

/**
 * Get referral status for a user
 */
function getReferralStatus(referralCode) {
    const config = getConfig();
    const count = getReferralCount(referralCode);
    const referralsNeeded = Math.min(config.referralsNeeded || DEFAULT_REFERRALS_NEEDED, MAX_REFERRALS);
    const bestPrice = Math.min(...(config.priceTiers?.map(t => t.price) || [20]));
    
    return {
        referralCode,
        referralCount: count,
        unlockedBestPrice: hasUnlockedBestPrice(referralCode),
        bestPrice,
        referralsNeeded,
        referralsRemaining: Math.max(0, referralsNeeded - count)
    };
}

// ============================================
// SMS / TWILIO
// ============================================

/**
 * Check if phone is opted out
 */
function isOptedOut(phone) {
    const optouts = readJson(PATHS.optouts) || [];
    return optouts.includes(normalizePhone(phone));
}

/**
 * Send SMS via Twilio
 */
async function sendSMS(to, body) {
    const config = getConfig();
    const twilio = config.twilio || {};
    
    if (!twilio.enabled || !twilio.accountSid || !twilio.authToken || !twilio.phoneNumber) {
        console.log('[SMS] Twilio not configured or disabled');
        return { success: false, reason: 'not_configured' };
    }
    
    if (isOptedOut(to)) {
        console.log(`[SMS] Phone ${to} is opted out, skipping`);
        return { success: false, reason: 'opted_out' };
    }
    
    const postData = new URLSearchParams({
        To: to,
        From: twilio.phoneNumber,
        Body: body
    }).toString();
    
    const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64');
    
    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'api.twilio.com',
            port: 443,
            path: `/2010-04-01/Accounts/${twilio.accountSid}/Messages.json`,
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Authorization': `Basic ${auth}`,
                'Content-Length': Buffer.byteLength(postData)
            }
        };
        
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    console.log(`[SMS] Sent successfully to ${to}`);
                    resolve({ success: true, data: JSON.parse(data) });
                } else {
                    console.error(`[SMS] Twilio error: ${res.statusCode}`, data);
                    reject(new Error(`Twilio error: ${res.statusCode}`));
                }
            });
        });
        
        req.on('error', (e) => {
            console.error('[SMS] Request error:', e);
            reject(e);
        });
        
        req.write(postData);
        req.end();
    });
}

/**
 * Handle opt-out (STOP)
 */
async function handleOptOut(phone) {
    const optouts = readJson(PATHS.optouts) || [];
    const normalized = normalizePhone(phone);
    
    if (!optouts.includes(normalized)) {
        optouts.push(normalized);
        writeJson(PATHS.optouts, optouts);
    }
    
    return sendSMS(phone, "You've been unsubscribed. You will no longer receive messages. Reply START to resubscribe.");
}

/**
 * Handle opt-in (START)
 */
async function handleOptIn(phone) {
    const optouts = readJson(PATHS.optouts) || [];
    const normalized = normalizePhone(phone);
    const index = optouts.indexOf(normalized);
    
    if (index > -1) {
        optouts.splice(index, 1);
        writeJson(PATHS.optouts, optouts);
    }
    
    return sendSMS(phone, "You're subscribed! Welcome back to the drop.");
}

// ============================================
// PARTICIPANT MANAGEMENT
// ============================================

/**
 * Find participant by phone number
 */
function findParticipantByPhone(phone) {
    const participants = getParticipants();
    const normalizedPhone = normalizePhone(phone);
    return participants.find(p => normalizePhone(p.phone) === normalizedPhone);
}

/**
 * Add new participant
 */
function addParticipant(phone, email, referredBy) {
    const participants = getParticipants();
    const referralCode = generateReferralCode();
    
    const newParticipant = {
        phone,
        email,
        referralCode,
        referredBy: referredBy || null,
        joinedAt: new Date().toISOString()
    };
    
    participants.push(newParticipant);
    
    if (!writeJson(PATHS.participants, participants)) {
        return null;
    }
    
    return newParticipant;
}

/**
 * Send welcome SMS to new participant
 */
async function sendWelcomeSMS(phone, referralCode) {
    const config = getConfig();
    const bestPrice = Math.min(...(config.priceTiers || []).map(t => t.price));
    const domain = config.domain || 'https://your-domain.com';
    const referralUrl = `${domain}/?ref=${referralCode}`;
    const referralsNeeded = config.referralsNeeded || DEFAULT_REFERRALS_NEEDED;
    
    const smsBody = referralsNeeded === 1
        ? `You're in the drop! 🎉 Share your unique link to unlock the lowest price ($${bestPrice}) now: ${referralUrl} - Get 1 friend to join and you win! Reply STOP to unsubscribe.`
        : `You're in the drop! 🎉 Share your unique link to unlock the lowest price ($${bestPrice}) now: ${referralUrl} - Get ${referralsNeeded} friends to join and you win! Reply STOP to unsubscribe.`;
    
    try {
        return await sendSMS(phone, smsBody);
    } catch (error) {
        console.error('[SMS] Failed to send welcome SMS:', error);
        return { success: false, error: error.message };
    }
}

// ============================================
// RATE LIMITING (Simple in-memory)
// ============================================
const rateLimitMap = new Map();

function checkRateLimit(ip) {
    const now = Date.now();
    const windowStart = now - RATE_LIMIT_WINDOW;
    
    // Get requests from this IP
    const requests = rateLimitMap.get(ip) || [];
    const recentRequests = requests.filter(time => time > windowStart);
    
    if (recentRequests.length >= RATE_LIMIT_MAX) {
        return { allowed: false, retryAfter: Math.ceil((requests[0] + RATE_LIMIT_WINDOW - now) / 1000) };
    }
    
    recentRequests.push(now);
    rateLimitMap.set(ip, recentRequests);
    return { allowed: true };
}

// ============================================
// HTTP SERVER
// ============================================

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif'
};

const server = http.createServer((req, res) => {
    const clientIP = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const startTime = Date.now();
    
    // Log request
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${clientIP}`);
    
    // Rate limiting for API endpoints
    if (req.url.startsWith('/api/')) {
        const rateLimit = checkRateLimit(clientIP);
        if (!rateLimit.allowed) {
            res.writeHead(429, { 
                'Content-Type': 'application/json',
                'Retry-After': rateLimit.retryAfter
            });
            res.end(JSON.stringify({ error: 'Too many requests', retryAfter: rateLimit.retryAfter }));
            return;
        }
    }
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;
    
    // ============================================
    // API ROUTES
    // ============================================
    
    // GET /api/config - Get current configuration
    if (pathname === '/api/config' && req.method === 'GET') {
        const config = getConfig();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(config));
        return;
    }
    
    // POST /api/join - Join the drop
    if (pathname === '/api/join' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const data = JSON.parse(body);
                
                // Validate inputs
                if (!data.phone || !isValidPhone(data.phone)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Valid phone number required' }));
                    return;
                }
                
                if (!data.email || !isValidEmail(data.email)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Valid email required' }));
                    return;
                }
                
                // Check for duplicate phone
                const existingParticipant = findParticipantByPhone(data.phone);
                if (existingParticipant) {
                    res.writeHead(409, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        error: 'Phone number already registered for this drop',
                        alreadyJoined: true,
                        referralCode: existingParticipant.referralCode
                    }));
                    return;
                }
                
                // Add participant
                const newParticipant = addParticipant(data.phone, data.email, data.referredBy);
                if (!newParticipant) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to save participant' }));
                    return;
                }
                
                // Check if referrer unlocked best price
                const referrerUnlocked = data.referredBy ? hasUnlockedBestPrice(data.referredBy) : false;
                
                // Send welcome SMS (don't wait for it)
                sendWelcomeSMS(data.phone, newParticipant.referralCode);
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ 
                    success: true,
                    referralCode: newParticipant.referralCode,
                    referrerUnlocked
                }));
            } catch (e) {
                console.error('[API] Join error:', e);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid request data' }));
            }
        });
        return;
    }
    
    // GET /api/participants - Get all participants
    if (pathname === '/api/participants' && req.method === 'GET') {
        const participants = getParticipants();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(participants));
        return;
    }
    
    // GET /api/referral/:code - Get referral status
    if (pathname.startsWith('/api/referral/') && req.method === 'GET') {
        const referralCode = pathname.split('/')[3];
        if (!referralCode) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Referral code required' }));
            return;
        }
        
        const status = getReferralStatus(referralCode);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(status));
        return;
    }
    
    // POST /api/admin/config - Update configuration
    if (pathname === '/api/admin/config' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const newConfig = JSON.parse(body);
                const existingConfig = getConfig();
                
                // Validate required fields
                if (!newConfig.product || !newConfig.priceTiers) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing required fields' }));
                    return;
                }
                
                // Merge configs
                const mergedConfig = {
                    ...existingConfig,
                    ...newConfig,
                    product: newConfig.product,
                    referralsNeeded: Math.min(
                        parseInt(newConfig.referralsNeeded) || DEFAULT_REFERRALS_NEEDED,
                        MAX_REFERRALS
                    )
                };
                
                if (!writeJson(PATHS.config, mergedConfig)) {
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Failed to save configuration' }));
                    return;
                }
                
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true }));
            } catch (e) {
                console.error('[API] Config update error:', e);
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid configuration data' }));
            }
        });
        return;
    }
    
    // POST /api/sms/webhook - Twilio webhook
    if (pathname === '/api/sms/webhook' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const params = new URLSearchParams(body);
                const from = params.get('From');
                const message = (params.get('Body') || '').trim().toUpperCase();
                
                console.log(`[SMS Webhook] From: ${from}, Message: ${message}`);
                
                if (['STOP', 'UNSUBSCRIBE', 'CANCEL'].includes(message)) {
                    await handleOptOut(from);
                } else if (['START', 'YES', 'SUBSCRIBE'].includes(message)) {
                    await handleOptIn(from);
                }
                
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
            } catch (e) {
                console.error('[SMS Webhook] Error:', e);
                res.writeHead(200, { 'Content-Type': 'text/xml' });
                res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
            }
        });
        return;
    }
    
    // ============================================
    // STATIC FILES
    // ============================================
    
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);
    
    // Security: Prevent directory traversal
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
    }
    
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            } else {
                console.error('[Static] Error serving file:', err);
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Server Error');
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
        }
    });
});

server.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`🎯 Group Buying Server`);
    console.log(`========================================`);
    console.log(`Server running at: http://localhost:${PORT}`);
    console.log(`Data directory: ${DATA_DIR}`);
    console.log(`========================================`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM received, shutting down gracefully');
    server.close(() => {
        console.log('Server closed');
        process.exit(0);
    });
});
