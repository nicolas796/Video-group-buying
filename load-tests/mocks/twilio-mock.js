const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_RPS = parseInt(process.env.TWILIO_MOCK_MAX_RPS || '35', 10);
const FAILURE_RATE = parseFloat(process.env.TWILIO_MOCK_FAILURE_RATE || '0.02');
const BASE_LATENCY_MS = parseInt(process.env.TWILIO_MOCK_LATENCY_MS || '150', 10);
const JITTER_MS = parseInt(process.env.TWILIO_MOCK_LATENCY_JITTER_MS || '200', 10);
const RATE_WINDOW_MS = 1000;
const LOG_PATH = process.env.TWILIO_MOCK_LOG_PATH || path.join(__dirname, 'twilio-messages.log');

const recentRequests = [];

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function recordRequest() {
    const now = Date.now();
    recentRequests.push(now);
    while (recentRequests.length && now - recentRequests[0] > RATE_WINDOW_MS) {
        recentRequests.shift();
    }
    if (recentRequests.length > MAX_RPS) {
        const err = new Error('Twilio mock rate limit exceeded');
        err.status = 429;
        throw err;
    }
}

function maybeFail() {
    if (Math.random() < FAILURE_RATE) {
        const err = new Error('Twilio mock injected failure');
        err.status = 502;
        throw err;
    }
}

function logMessage(entry) {
    try {
        const dir = path.dirname(LOG_PATH);
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(LOG_PATH, JSON.stringify(entry) + '\n', 'utf8');
    } catch (error) {
        console.warn('[Twilio Mock] Failed to write log:', error.message);
    }
}

function createMockClient(accountSid = 'ACXXXXXXXXXXXXXXXXXXXXXXXXXXXX', authToken = 'mock-token', overrides = {}) {
    const sender = overrides.phoneNumber || process.env.TWILIO_MOCK_DEFAULT_FROM || '+15555550100';

    return {
        messages: {
            async create(payload = {}) {
                recordRequest();
                maybeFail();
                const latency = BASE_LATENCY_MS + Math.floor(Math.random() * JITTER_MS);
                if (latency > 0) {
                    await sleep(latency);
                }
                const sid = `SM${crypto.randomUUID().replace(/-/g, '').slice(0, 32)}`;
                const response = {
                    sid,
                    status: 'queued',
                    from: payload.from || sender,
                    to: payload.to,
                    body: payload.body,
                    accountSid,
                    numSegments: '1',
                    direction: 'outbound-api',
                    apiVersion: '2010-04-01',
                    price: null,
                    uri: `/2010-04-01/Accounts/${accountSid}/Messages/${sid}.json`,
                    dateCreated: new Date().toISOString(),
                    dateUpdated: new Date().toISOString()
                };

                logMessage({
                    timestamp: new Date().toISOString(),
                    to: payload.to,
                    from: response.from,
                    body: payload.body,
                    campaignId: payload.campaignId || null,
                    sid,
                    latencyMs: latency,
                    accountSid
                });

                return response;
            }
        }
    };
}

module.exports = createMockClient;
