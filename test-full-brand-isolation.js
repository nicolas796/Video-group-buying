#!/usr/bin/env node

const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BRANDS_FILE = path.join(DATA_DIR, 'brands.json');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');

const SUPER_ADMIN = { email: 'admin@estreamly.com', password: 'ChangeMe123!' };
const TEST_USERS = {
    coca: { email: 'coke@example.com', password: 'FizzFactory!23' },
    pepsi: { email: 'pepsi@example.com', password: 'CrystalRefresh!23' }
};
const TEST_BRANDS = { coca: 'Coca Cola', pepsi: 'Pepsi' };
const TEST_CAMPAIGNS = {
    coca: 'Coca Cola VIP Drop',
    pepsi: 'Pepsi Spark Campaign'
};

function readJsonSafe(filePath) {
    return fs.readFile(filePath, 'utf8').then(data => JSON.parse(data));
}

async function backupFiles() {
    return {
        users: await fs.readFile(USERS_FILE, 'utf8'),
        brands: await fs.readFile(BRANDS_FILE, 'utf8'),
        campaigns: await fs.readFile(CAMPAIGNS_FILE, 'utf8')
    };
}

async function restoreFiles(backup) {
    await Promise.all([
        fs.writeFile(USERS_FILE, backup.users, 'utf8'),
        fs.writeFile(BRANDS_FILE, backup.brands, 'utf8'),
        fs.writeFile(CAMPAIGNS_FILE, backup.campaigns, 'utf8')
    ]);
}

function serializeUsers(usersWrapper, users) {
    if (Array.isArray(usersWrapper?.users)) {
        return JSON.stringify({ ...usersWrapper, users }, null, 2);
    }
    if (Array.isArray(usersWrapper)) {
        return JSON.stringify(users, null, 2);
    }
    return JSON.stringify({ users }, null, 2);
}

async function prepareUserStore() {
    const data = await readJsonSafe(USERS_FILE).catch(() => ({ users: [] }));
    const list = Array.isArray(data?.users) ? data.users : Array.isArray(data) ? data : [];
    if (!list.length) {
        throw new Error('User store is empty; cannot seed super admin');
    }
    const now = new Date().toISOString();
    const superIndex = list.findIndex(user => user?.is_super_admin || user?.isSuperAdmin);
    if (superIndex === -1) {
        throw new Error('No super admin found in user store');
    }
    const excludeEmails = new Set(Object.values(TEST_USERS).map(user => user.email.toLowerCase()));
    const hashedPassword = bcrypt.hashSync(SUPER_ADMIN.password, 12);
    const sanitized = [];
    list.forEach((user, index) => {
        if (index === superIndex) {
            sanitized.push({
                ...user,
                email: SUPER_ADMIN.email.toLowerCase(),
                brand_id: user.brand_id || user.brandId || 'brand_001',
                is_super_admin: true,
                password_hash: hashedPassword,
                updated_at: now
            });
            return;
        }
        const email = (user.email || '').trim().toLowerCase();
        if (excludeEmails.has(email)) {
            return;
        }
        sanitized.push(user);
    });
    const payload = serializeUsers(data, sanitized);
    await fs.writeFile(USERS_FILE, payload, 'utf8');
}

function serializeBrands(brandsWrapper, brands) {
    if (Array.isArray(brandsWrapper?.brands)) {
        return JSON.stringify({ ...brandsWrapper, brands }, null, 2);
    }
    if (Array.isArray(brandsWrapper)) {
        return JSON.stringify(brands, null, 2);
    }
    return JSON.stringify({ brands }, null, 2);
}

async function pruneTestBrands() {
    const data = await readJsonSafe(BRANDS_FILE).catch(() => ({ brands: [] }));
    const list = Array.isArray(data?.brands) ? data.brands : Array.isArray(data) ? data : [];
    const forbidden = new Set(Object.values(TEST_BRANDS).map(name => name.toLowerCase()));
    const filtered = list.filter(brand => !forbidden.has((brand?.name || '').trim().toLowerCase()));
    const payload = serializeBrands(data, filtered);
    await fs.writeFile(BRANDS_FILE, payload, 'utf8');
}

function toCampaignMap(raw) {
    if (!raw) return {};
    if (Array.isArray(raw)) {
        return raw.reduce((acc, campaign) => {
            if (campaign?.id) acc[campaign.id] = campaign;
            return acc;
        }, {});
    }
    if (Array.isArray(raw?.campaigns)) {
        return raw.campaigns.reduce((acc, campaign) => {
            if (campaign?.id) acc[campaign.id] = campaign;
            return acc;
        }, {});
    }
    return { ...raw };
}

function serializeCampaigns(raw, campaignsMap) {
    if (Array.isArray(raw?.campaigns)) {
        return JSON.stringify({ ...raw, campaigns: Object.values(campaignsMap) }, null, 2);
    }
    if (Array.isArray(raw)) {
        return JSON.stringify(Object.values(campaignsMap), null, 2);
    }
    return JSON.stringify(campaignsMap, null, 2);
}

function getCampaignListFromResponse(payload) {
    if (Array.isArray(payload?.campaigns)) {
        return payload.campaigns;
    }
    if (Array.isArray(payload)) {
        return payload;
    }
    return [];
}

async function pruneTestCampaigns() {
    const raw = await readJsonSafe(CAMPAIGNS_FILE).catch(() => ({}));
    const map = toCampaignMap(raw);
    const forbiddenNames = new Set(Object.values(TEST_CAMPAIGNS).map(name => name.toLowerCase()));
    const next = Object.entries(map).reduce((acc, [id, campaign]) => {
        const name = (campaign?.productName || '').trim().toLowerCase();
        if (forbiddenNames.has(name)) {
            return acc;
        }
        acc[id] = campaign;
        return acc;
    }, {});
    const payload = serializeCampaigns(raw, next);
    await fs.writeFile(CAMPAIGNS_FILE, payload, 'utf8');
}

class HttpClient {
    constructor(port) {
        this.port = port;
        this.cookies = {};
    }

    _applyCookies(headers = {}) {
        const pairs = Object.entries(this.cookies)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([name, value]) => `${name}=${value}`);
        if (pairs.length) {
            headers['Cookie'] = pairs.join('; ');
        }
        return headers;
    }

    _storeCookies(setCookieHeader) {
        if (!setCookieHeader) return;
        const entries = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
        entries.forEach(entry => {
            const [cookiePart] = entry.split(';');
            if (!cookiePart) return;
            const [name, ...rest] = cookiePart.split('=');
            if (!name) return;
            const value = rest.join('=').trim();
            if (!value) {
                delete this.cookies[name.trim()];
            } else {
                this.cookies[name.trim()] = value;
            }
        });
    }

    request(method, targetPath, { body = null, headers = {}, token = null, expectJson = true } = {}) {
        return new Promise((resolve, reject) => {
            let payload = null;
            const finalHeaders = { Accept: 'application/json', ...headers };
            if (body !== null && body !== undefined) {
                if (typeof body === 'string') {
                    payload = body;
                } else {
                    payload = JSON.stringify(body);
                }
                if (!finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
                    finalHeaders['Content-Type'] = 'application/json';
                }
                finalHeaders['Content-Length'] = Buffer.byteLength(payload);
            }
            if (token) {
                finalHeaders['Authorization'] = `Bearer ${token}`;
            }
            this._applyCookies(finalHeaders);

            const options = {
                method,
                hostname: '127.0.0.1',
                port: this.port,
                path: targetPath,
                headers: finalHeaders
            };

            const req = http.request(options, res => {
                let raw = '';
                res.setEncoding('utf8');
                res.on('data', chunk => raw += chunk);
                res.on('end', () => {
                    try {
                        this._storeCookies(res.headers['set-cookie']);
                        let parsed = null;
                        if (expectJson && raw) {
                            parsed = JSON.parse(raw);
                        } else if (expectJson && !raw) {
                            parsed = null;
                        }
                        resolve({ status: res.statusCode, body: parsed, headers: res.headers });
                    } catch (error) {
                        reject(new Error(`Failed to parse response from ${method} ${targetPath}: ${error.message}`));
                    }
                });
            });
            req.on('error', reject);
            if (payload) {
                req.write(payload);
            }
            req.end();
        });
    }

    async getCsrfToken() {
        const response = await this.request('GET', '/api/csrf-token');
        if (response.status !== 200 || !response.body?.token) {
            throw new Error('Failed to fetch CSRF token');
        }
        return response.body.token;
    }

    async login(email, password, csrfToken) {
        const response = await this.request('POST', '/api/login', {
            body: { email, password, csrfToken }
        });
        if (response.status !== 200) {
            throw new Error(`Login failed for ${email}: ${response.body?.error || response.status}`);
        }
        return response.body;
    }
}

function createCampaignPayload({ name, image, brandId, campaignId }) {
    const nowPlus = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return {
        id: campaignId,
        productName: name,
        productImage: image,
        productDescription: `${name} exclusive offer`,
        videoUrl: 'https://vod.estreamly.com/assets/demo/test_720.m3u8',
        twilio: {
            enabled: false,
            accountSid: '',
            authToken: '',
            phoneNumber: '',
            domain: 'https://example.com'
        },
        pricing: {
            initialPrice: 25,
            initialBuyers: 0,
            checkoutUrl: 'https://example.com/checkout',
            tiers: [
                { buyers: 1, price: 20, couponCode: 'DROP20' },
                { buyers: 10, price: 15, couponCode: 'DROP15' }
            ]
        },
        referralsNeeded: 2,
        countdownEnd: nowPlus,
        description: `${name} exclusive offer`,
        price: 15,
        originalPrice: 25,
        imageUrl: image,
        sharesRequired: 2,
        discountPercentage: 40,
        merchantName: name,
        merchantLogo: image,
        initialBuyers: 0,
        priceTiers: [
            { buyers: 1, price: 20, couponCode: 'DROP20' },
            { buyers: 10, price: 15, couponCode: 'DROP15' }
        ],
        termsUrl: 'https://example.com/terms',
        brand_id: brandId,
        brandId
    };
}

async function sanitizeDataFiles() {
    await prepareUserStore();
    await pruneTestBrands();
    await pruneTestCampaigns();
}

async function run() {
    const backups = await backupFiles();
    let serverInstance = null;
    let started = false;
    let port;

    try {
        await sanitizeDataFiles();
        ({ server: serverInstance } = require('./server'));

        await new Promise((resolve, reject) => {
            const onError = (error) => {
                serverInstance.off('error', onError);
                reject(error);
            };
            serverInstance.once('error', onError);
            serverInstance.listen(0, () => {
                serverInstance.off('error', onError);
                started = true;
                port = serverInstance.address().port;
                resolve();
            });
        });

        const adminClient = new HttpClient(port);
        const csrfToken = await adminClient.getCsrfToken();
        const loginResponse = await adminClient.login(SUPER_ADMIN.email, SUPER_ADMIN.password, csrfToken);
        assert.ok(loginResponse.token, 'Login response missing token');
        assert.equal(loginResponse.user?.is_super_admin, true, 'Super admin flag missing');
        const adminBrandContext = loginResponse.user?.brand_id || loginResponse.user?.brandId || null;
        assert.ok(adminBrandContext, 'Super admin brand context missing');
        const adminToken = loginResponse.token;

        // Create brands
        const cocaBrand = await adminClient.request('POST', '/api/brands', {
            token: adminToken,
            body: { name: TEST_BRANDS.coca }
        });
        assert.equal(cocaBrand.status, 201, 'Failed to create Coca Cola brand');
        const cocaBrandId = cocaBrand.body?.brand?.id;
        assert.ok(cocaBrandId, 'Coca Cola brand id missing');

        const pepsiBrand = await adminClient.request('POST', '/api/brands', {
            token: adminToken,
            body: { name: TEST_BRANDS.pepsi }
        });
        assert.equal(pepsiBrand.status, 201, 'Failed to create Pepsi brand');
        const pepsiBrandId = pepsiBrand.body?.brand?.id;
        assert.ok(pepsiBrandId, 'Pepsi brand id missing');

        // Create users
        const cocaUserRes = await adminClient.request('POST', '/api/users', {
            token: adminToken,
            body: {
                email: TEST_USERS.coca.email,
                password: TEST_USERS.coca.password,
                brand_id: cocaBrandId,
                is_super_admin: false
            }
        });
        assert.equal(cocaUserRes.status, 201, 'Failed to create Coca Cola user');

        const pepsiUserRes = await adminClient.request('POST', '/api/users', {
            token: adminToken,
            body: {
                email: TEST_USERS.pepsi.email,
                password: TEST_USERS.pepsi.password,
                brand_id: pepsiBrandId,
                is_super_admin: false
            }
        });
        assert.equal(pepsiUserRes.status, 201, 'Failed to create Pepsi user');

        const adminCsrf = await adminClient.getCsrfToken();

        // Create campaigns
        const cocaCampaignId = `coke_${Date.now()}`;
        const cocaCampaignPayload = createCampaignPayload({
            name: TEST_CAMPAIGNS.coca,
            image: 'https://images.unsplash.com/photo-1510626176961-4b57d4fbad03?w=640',
            brandId: cocaBrandId,
            campaignId: cocaCampaignId
        });
        cocaCampaignPayload.csrfToken = adminCsrf;
        const cocaCampaignRes = await adminClient.request('POST', '/api/campaigns', {
            token: adminToken,
            headers: { 'x-csrf-token': adminCsrf },
            body: cocaCampaignPayload
        });
        assert.equal(cocaCampaignRes.status, 201, 'Failed to create Coca Cola campaign');

        const pepsiCampaignId = `pepsi_${Date.now()}`;
        const pepsiCampaignPayload = createCampaignPayload({
            name: TEST_CAMPAIGNS.pepsi,
            image: 'https://images.unsplash.com/photo-1470337458703-46ad1756a187?w=640',
            brandId: pepsiBrandId,
            campaignId: pepsiCampaignId
        });
        pepsiCampaignPayload.csrfToken = adminCsrf;
        const pepsiCampaignRes = await adminClient.request('POST', '/api/campaigns', {
            token: adminToken,
            headers: { 'x-csrf-token': adminCsrf },
            body: pepsiCampaignPayload
        });
        assert.equal(pepsiCampaignRes.status, 201, 'Failed to create Pepsi campaign');

        // Coca Cola user login and campaign access
        const cocaClient = new HttpClient(port);
        const cocaCsrf = await cocaClient.getCsrfToken();
        const cocaLogin = await cocaClient.login(TEST_USERS.coca.email, TEST_USERS.coca.password, cocaCsrf);
        const cocaToken = cocaLogin.token;
        assert.ok(cocaToken, 'Coke user login token missing');

        const cocaCampaignList = await cocaClient.request('GET', '/api/campaigns', { token: cocaToken });
        assert.equal(cocaCampaignList.status, 200, 'Coke user GET /api/campaigns failed');
        const cocaCampaigns = getCampaignListFromResponse(cocaCampaignList.body);
        assert.equal(cocaCampaigns.length, 1, 'Coke user should only see one campaign');
        assert.equal(cocaCampaigns[0]?.id, cocaCampaignId, 'Coke user saw wrong campaign');

        const cokePepsiFetch = await cocaClient.request('GET', `/api/campaign/${pepsiCampaignId}`, { token: cocaToken });
        assert.equal(cokePepsiFetch.status, 404, 'Coke user should receive 404 when accessing Pepsi campaign');

        // Pepsi user login and campaign access
        const pepsiClient = new HttpClient(port);
        const pepsiCsrf = await pepsiClient.getCsrfToken();
        const pepsiLogin = await pepsiClient.login(TEST_USERS.pepsi.email, TEST_USERS.pepsi.password, pepsiCsrf);
        const pepsiToken = pepsiLogin.token;
        assert.ok(pepsiToken, 'Pepsi user login token missing');

        const pepsiCampaignList = await pepsiClient.request('GET', '/api/campaigns', { token: pepsiToken });
        assert.equal(pepsiCampaignList.status, 200, 'Pepsi user GET /api/campaigns failed');
        const pepsiCampaigns = getCampaignListFromResponse(pepsiCampaignList.body);
        assert.equal(pepsiCampaigns.length, 1, 'Pepsi user should only see one campaign');
        assert.equal(pepsiCampaigns[0]?.id, pepsiCampaignId, 'Pepsi user saw wrong campaign');

        // Super admin can see both campaigns
        const adminCampaigns = await adminClient.request('GET', '/api/campaigns', { token: adminToken });
        assert.equal(adminCampaigns.status, 200, 'Super admin GET /api/campaigns failed');
        const adminCampaignList = getCampaignListFromResponse(adminCampaigns.body);
        const adminCampaignIds = adminCampaignList.map(c => c.id);
        assert(adminCampaignIds.includes(cocaCampaignId), 'Super admin missing Coca Cola campaign');
        assert(adminCampaignIds.includes(pepsiCampaignId), 'Super admin missing Pepsi campaign');

        console.log('✅ All brand isolation tests passed');
    } finally {
        if (started && serverInstance) {
            await new Promise(resolve => serverInstance.close(resolve));
        }
        await restoreFiles(backups);
    }
}

run().catch(error => {
    console.error('❌ Brand isolation end-to-end test failed:', error);
    process.exit(1);
});
