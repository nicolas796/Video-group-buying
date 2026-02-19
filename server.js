const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const https = require('https');

const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Default config
const defaultConfig = {
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
    }
};

// Calculate total buyers: initial + actual participants
function getTotalBuyers() {
    const config = readJson(configPath) || defaultConfig;
    const participants = readJson(participantsPath) || [];
    return (config.initialBuyers || 0) + participants.length;
}

// Generate unique referral code
function generateReferralCode() {
    return crypto.randomBytes(4).toString('hex').toUpperCase();
}

// Count successful referrals for a user
function getReferralCount(referralCode) {
    const participants = readJson(participantsPath) || [];
    return participants.filter(p => p.referredBy === referralCode).length;
}

// Check if user has unlocked best price via referrals (2+ referrals)
function hasUnlockedBestPrice(referralCode) {
    if (!referralCode) return false;
    return getReferralCount(referralCode) >= 2;
}

// Get Twilio config
function getTwilioConfig() {
    const config = readJson(configPath) || defaultConfig;
    return config.twilio || defaultConfig.twilio;
}

// Check if phone is opted out
function isOptedOut(phone) {
    const optouts = readJson(optoutsPath) || [];
    return optouts.includes(normalizePhone(phone));
}

// Normalize phone number
function normalizePhone(phone) {
    return phone.replace(/\D/g, '');
}

// Send SMS via Twilio
function sendSMS(to, body) {
    return new Promise((resolve, reject) => {
        const twilio = getTwilioConfig();
        
        if (!twilio.enabled || !twilio.accountSid || !twilio.authToken || !twilio.phoneNumber) {
            console.log('Twilio not configured or disabled');
            resolve({ success: false, reason: 'not_configured' });
            return;
        }
        
        // Check opt-out
        if (isOptedOut(to)) {
            console.log(`Phone ${to} is opted out, skipping SMS`);
            resolve({ success: false, reason: 'opted_out' });
            return;
        }
        
        const postData = new URLSearchParams({
            To: to,
            From: twilio.phoneNumber,
            Body: body
        }).toString();
        
        const auth = Buffer.from(`${twilio.accountSid}:${twilio.authToken}`).toString('base64');
        
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
                    resolve({ success: true, data: JSON.parse(data) });
                } else {
                    console.error('Twilio error:', data);
                    reject(new Error(`Twilio error: ${res.statusCode}`));
                }
            });
        });
        
        req.on('error', (e) => {
            console.error('Twilio request error:', e);
            reject(e);
        });
        
        req.write(postData);
        req.end();
    });
}

// Handle opt-out (STOP)
function handleOptOut(phone) {
    const optouts = readJson(optoutsPath) || [];
    const normalized = normalizePhone(phone);
    
    if (!optouts.includes(normalized)) {
        optouts.push(normalized);
        writeJson(optoutsPath, optouts);
    }
    
    // Send confirmation
    return sendSMS(phone, "You've been unsubscribed. You will no longer receive messages. Reply START to resubscribe.");
}

// Handle opt-in (START)
function handleOptIn(phone) {
    const optouts = readJson(optoutsPath) || [];
    const normalized = normalizePhone(phone);
    const index = optouts.indexOf(normalized);
    
    if (index > -1) {
        optouts.splice(index, 1);
        writeJson(optoutsPath, optouts);
    }
    
    return sendSMS(phone, "You're subscribed! Welcome back to the drop.");
}

// Initialize files if they don't exist
const configPath = path.join(DATA_DIR, 'config.json');
const participantsPath = path.join(DATA_DIR, 'participants.json');
const optoutsPath = path.join(DATA_DIR, 'optouts.json');

if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2));
}

if (!fs.existsSync(participantsPath)) {
    fs.writeFileSync(participantsPath, '[]');
}

if (!fs.existsSync(optoutsPath)) {
    fs.writeFileSync(optoutsPath, '[]');
}

// MIME types
const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif'
};

// Read JSON file safely
function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
        return null;
    }
}

// Write JSON file
function writeJson(filePath, data) {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// Create server
const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;
    
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // API Routes
    if (pathname === '/api/config') {
        if (req.method === 'GET') {
            const config = readJson(configPath) || defaultConfig;
            // Calculate total buyers (initial + actual participants)
            const participants = readJson(participantsPath) || [];
            config.currentBuyers = (config.initialBuyers || 0) + participants.length;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(config));
            return;
        }
    }
    
    if (pathname === '/api/join') {
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const participants = readJson(participantsPath) || [];
                    const config = readJson(configPath) || defaultConfig;
                    
                    // Generate unique referral code for this user
                    const referralCode = generateReferralCode();
                    
                    // Add new participant
                    const newParticipant = {
                        phone: data.phone,
                        email: data.email,
                        referralCode: referralCode,
                        referredBy: data.referredBy || null,
                        joinedAt: new Date().toISOString()
                    };
                    
                    participants.push(newParticipant);
                    writeJson(participantsPath, participants);
                    
                    // Check if referrer unlocked best price
                    let referrerUnlocked = false;
                    if (data.referredBy) {
                        referrerUnlocked = hasUnlockedBestPrice(data.referredBy);
                    }
                    
                    // Send welcome SMS
                    const bestPrice = Math.min(...(config.priceTiers || []).map(t => t.price));
                    const domain = config.domain || 'https://your-domain.com';
                    const referralUrl = `${domain}/?ref=${referralCode}`;
                    
                    const smsBody = `You're in the drop! 🎉 Share your unique link to unlock the lowest price ($${bestPrice}) now: ${referralUrl} - Get 2 friends to join and you win! Reply STOP to unsubscribe.`;
                    
                    try {
                        await sendSMS(data.phone, smsBody);
                    } catch (smsError) {
                        console.error('SMS send failed:', smsError);
                        // Don't fail the request if SMS fails
                    }
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ 
                        success: true,
                        referralCode: referralCode,
                        referrerUnlocked: referrerUnlocked
                    }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid data' }));
                }
            });
            return;
        }
    }
    
    if (pathname === '/api/participants') {
        if (req.method === 'GET') {
            const participants = readJson(participantsPath) || [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(participants));
            return;
        }
    }
    
    // Get referral status for a user
    if (pathname.startsWith('/api/referral/')) {
        if (req.method === 'GET') {
            const referralCode = pathname.split('/')[3];
            const count = getReferralCount(referralCode);
            const unlocked = hasUnlockedBestPrice(referralCode);
            const bestPrice = Math.min(...(readJson(configPath)?.priceTiers?.map(t => t.price) || [20]));
            
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                referralCode: referralCode,
                referralCount: count,
                unlockedBestPrice: unlocked,
                bestPrice: bestPrice,
                referralsNeeded: Math.max(0, 2 - count)
            }));
            return;
        }
    }
    
    // Admin: Update config
    if (pathname === '/api/admin/config') {
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const newConfig = JSON.parse(body);
                    const existingConfig = readJson(configPath) || defaultConfig;
                    
                    // Merge with existing to preserve any extra fields
                    const mergedConfig = {
                        ...existingConfig,
                        ...newConfig,
                        product: newConfig.product // Always use new product data
                    };
                    
                    writeJson(configPath, mergedConfig);
                    
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid config data' }));
                }
            });
            return;
        }
    }
    
    // Twilio webhook for incoming SMS (STOP/START)
    if (pathname === '/api/sms/webhook') {
        if (req.method === 'POST') {
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', async () => {
                try {
                    const params = new URLSearchParams(body);
                    const from = params.get('From');
                    const message = (params.get('Body') || '').trim().toUpperCase();
                    
                    console.log(`SMS from ${from}: ${message}`);
                    
                    if (message === 'STOP' || message === 'UNSUBSCRIBE' || message === 'CANCEL') {
                        await handleOptOut(from);
                    } else if (message === 'START' || message === 'YES' || message === 'SUBSCRIBE') {
                        await handleOptIn(from);
                    }
                    
                    // Return empty TwiML
                    res.writeHead(200, { 'Content-Type': 'text/xml' });
                    res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
                } catch (e) {
                    console.error('Webhook error:', e);
                    res.writeHead(200, { 'Content-Type': 'text/xml' });
                    res.end('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
                }
            });
            return;
        }
    }
    
    // Static file serving
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(__dirname, filePath);
    
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    
    fs.readFile(filePath, (err, content) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404, { 'Content-Type': 'text/plain' });
                res.end('Not Found');
            } else {
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
    console.log(`Group Buying server running at http://localhost:${PORT}`);
    console.log('');
    console.log('Database files:');
    console.log(`  Config: ${configPath}`);
    console.log(`  Participants: ${participantsPath}`);
});
