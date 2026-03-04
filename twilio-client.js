const https = require('https');
const { URLSearchParams } = require('url');

function createHttpClient(accountSid, authToken) {
    return {
        messages: {
            create: ({ to, from, body }) => new Promise((resolve, reject) => {
                const postData = new URLSearchParams({ To: to, From: from, Body: body }).toString();
                const auth = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
                const req = https.request({
                    hostname: 'api.twilio.com',
                    port: 443,
                    path: `/2010-04-01/Accounts/${accountSid}/Messages.json`,
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Authorization': `Basic ${auth}`,
                        'Content-Length': Buffer.byteLength(postData)
                    }
                }, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            try {
                                resolve(JSON.parse(data));
                            } catch (error) {
                                resolve({ sid: null, raw: data });
                            }
                        } else {
                            const err = new Error(`Twilio error: ${res.statusCode}`);
                            err.status = res.statusCode;
                            err.response = data;
                            reject(err);
                        }
                    });
                });
                req.on('error', reject);
                req.write(postData);
                req.end();
            })
        }
    };
}

module.exports = function createTwilioClient(accountSid, authToken, options = {}) {
    if (String(process.env.USE_MOCK_TWILIO || '').toLowerCase() === 'true') {
        const createMock = require('./load-tests/mocks/twilio-mock');
        return createMock(accountSid, authToken, options);
    }
    return createHttpClient(accountSid, authToken, options);
};
