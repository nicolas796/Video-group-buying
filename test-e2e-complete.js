#!/usr/bin/env node

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
process.env.FORCE_HTTPS = 'false';

const path = require('path');
const fs = require('fs').promises;
const http = require('http');
const assert = require('node:assert/strict');
const bcrypt = require('bcrypt');
const { server } = require('./server');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const BRANDS_FILE = path.join(DATA_DIR, 'brands.json');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');

const SUPER_ADMIN = { email: 'admin@estreamly.com', password: 'ChangeMe123!' };
const TEST_BRANDS = { coca: 'Coca Cola', pepsi: 'Pepsi' };
const TEST_USERS = {
    coca: { email: 'coke@example.com', password: 'Coke123!' },
    pepsi: { email: 'pepsi@example.com', password: 'Pepsi123!' }
};
const TEST_CAMPAIGNS = {
    coca: 'Coca Cola Ultimate Drop',
    pepsi: 'Pepsi Spark Experience'
};

class Reporter {
    constructor() {
        this.total = 0;
        this.passed = 0;
        this.failed = 0;
        this.summaryPrinted = false;
        this.lastSummary = '';
    }

    section(title) {
        console.log(`\n=== ${title} ===`);
    }

    async check(description, fn) {
        this.total += 1;
        try {
            const detail = await fn();
            this.passed += 1;
            this.print('PASS', description, detail);
            return detail;
        } catch (error) {
            this.failed += 1;
            this.print('FAIL', description, error?.message || String(error));
            throw error;
        }
    }

    print(status, description, detail) {
        const prefix = status === 'PASS' ? '✅' : '❌';
        const detailText = detail ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
        const line = `${prefix} [${status}] ${description}${detailText}`;
        if (status === 'PASS') {
            console.log(line);
        } else {
            console.error(line);
        }
    }

    summary() {
        if (this.summaryPrinted) {
            return this.lastSummary;
        }
        const summaryText = `"${this.passed}/${this.total} tests passed"`;
        if (this.failed === 0) {
            console.log(`\n✅ Final summary: ${summaryText}`);
        } else {
            console.error(`\n❌ Final summary: ${summaryText}`);
        }
        this.summaryPrinted = true;
        this.lastSummary = summaryText;
        return summaryText;
    }
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
            if (!targetPath.startsWith('/')) {
                return reject(new Error(`Path must start with / (received: ${targetPath})`));
            }
            const finalHeaders = { Accept: 'application/json', ...headers };
            let payload = null;
            if (body !== null && body !== undefined) {
                payload = typeof body === 'string' ? body : JSON.stringify(body);
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
                        let parsed = raw;
                        if (expectJson) {
                            parsed = raw ? JSON.parse(raw) : null;
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
        if (response.status !== 200 || !response.body?.token) {
            throw new Error(`Login failed for ${email}: ${response.body?.error || response.status}`);
        }
        return response.body;
    }
}

function createCampaignId(prefix) {
    const random = Math.random().toString(36).slice(2, 8);
    return `${prefix}${random}`.slice(0, 32);
}

function createCampaignPayload({ campaignId, brandId, name, imageUrl }) {
    const countdown = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    return {
        id: campaignId,
        productName: name,
        productImage: imageUrl,
        productDescription: `${name} limited drop`,
        videoUrl: 'https://vod.estreamly.com/assets/994758e3-c35f-4e26-9512-1babf10b6207/HLS/jUVhs_DTuiA6FDuYM_720.m3u8',
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
        countdownEnd: countdown,
        description: `${name} limited drop`,
        price: 15,
        originalPrice: 25,
        imageUrl,
        sharesRequired: 2,
        discountPercentage: 40,
        merchantName: 'eStreamly Labs',
        merchantLogo: imageUrl,
        initialBuyers: 0,
        priceTiers: [
            { buyers: 1, price: 20, couponCode: 'DROP20' },
            { buyers: 10, price: 15, couponCode: 'DROP15' }
        ],
        termsUrl: 'https://www.estreamly.com/legal/terms',
        brand_id: brandId,
        brandId
    };
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

function getBrandListFromResponse(payload) {
    if (Array.isArray(payload?.brands)) {
        return payload.brands;
    }
    if (Array.isArray(payload)) {
        return payload;
    }
    return [];
}

async function readJsonSafe(filePath) {
    const raw = await fs.readFile(filePath, 'utf8').catch(error => {
        if (error.code === 'ENOENT') {
            return null;
        }
        throw error;
    });
    if (!raw) {
        return null;
    }
    return JSON.parse(raw);
}

function serializeCollection(raw, key, list) {
    if (Array.isArray(raw?.[key])) {
        return JSON.stringify({ ...raw, [key]: list }, null, 2);
    }
    if (Array.isArray(raw)) {
        return JSON.stringify(list, null, 2);
    }
    if (raw && typeof raw === 'object') {
        return JSON.stringify({ ...raw, [key]: list }, null, 2);
    }
    return JSON.stringify({ [key]: list }, null, 2);
}

function campaignsToMap(raw) {
    if (!raw) return {};
    if (Array.isArray(raw)) {
        return raw.reduce((acc, campaign) => {
            if (campaign?.id) {
                acc[campaign.id] = campaign;
            }
            return acc;
        }, {});
    }
    if (Array.isArray(raw?.campaigns)) {
        return raw.campaigns.reduce((acc, campaign) => {
            if (campaign?.id) {
                acc[campaign.id] = campaign;
            }
            return acc;
        }, {});
    }
    return { ...raw };
}

function serializeCampaigns(raw, map) {
    const list = Object.values(map);
    if (Array.isArray(raw?.campaigns)) {
        return JSON.stringify({ ...raw, campaigns: list }, null, 2);
    }
    if (Array.isArray(raw)) {
        return JSON.stringify(list, null, 2);
    }
    return JSON.stringify(map, null, 2);
}

async function backupFiles() {
    const entries = new Map();
    for (const file of [USERS_FILE, BRANDS_FILE, CAMPAIGNS_FILE]) {
        try {
            const contents = await fs.readFile(file, 'utf8');
            entries.set(file, contents);
        } catch (error) {
            if (error.code === 'ENOENT') {
                entries.set(file, null);
            } else {
                throw error;
            }
        }
    }
    return entries;
}

async function restoreFiles(backups) {
    for (const [file, contents] of backups.entries()) {
        if (contents === null) {
            await fs.rm(file, { force: true });
        } else {
            await fs.writeFile(file, contents, 'utf8');
        }
    }
}

async function ensureSuperAdminCredentials() {
    const raw = await readJsonSafe(USERS_FILE);
    if (!raw) {
        throw new Error('User store is missing');
    }
    const list = Array.isArray(raw?.users) ? raw.users : Array.isArray(raw) ? raw : [];
    if (!list.length) {
        throw new Error('User store is empty');
    }
    const forbidden = new Set(Object.values(TEST_USERS).map(user => user.email.toLowerCase()));
    const now = new Date().toISOString();
    const hashedPassword = await bcrypt.hash(SUPER_ADMIN.password, 12);
    let superAdminUpdated = false;
    const sanitized = [];
    for (const user of list) {
        const email = (user.email || '').trim().toLowerCase();
        if (forbidden.has(email)) {
            continue;
        }
        if (!superAdminUpdated && (user.is_super_admin || user.isSuperAdmin)) {
            sanitized.push({
                ...user,
                email: SUPER_ADMIN.email,
                brand_id: user.brand_id || user.brandId || 'brand_001',
                brandId: user.brand_id || user.brandId || 'brand_001',
                is_super_admin: true,
                isSuperAdmin: true,
                password_hash: hashedPassword,
                passwordHash: hashedPassword,
                updated_at: now
            });
            superAdminUpdated = true;
            continue;
        }
        sanitized.push(user);
    }
    if (!superAdminUpdated) {
        throw new Error('No super admin account found to update');
    }
    const payload = serializeCollection(raw, 'users', sanitized);
    await fs.writeFile(USERS_FILE, payload, 'utf8');
}

async function pruneBrands() {
    const raw = await readJsonSafe(BRANDS_FILE);
    if (!raw) return;
    const list = Array.isArray(raw?.brands) ? raw.brands : Array.isArray(raw) ? raw : [];
    const forbidden = new Set(Object.values(TEST_BRANDS).map(name => name.toLowerCase()));
    const filtered = list.filter(brand => !forbidden.has((brand?.name || '').toLowerCase()));
    const payload = serializeCollection(raw, 'brands', filtered);
    await fs.writeFile(BRANDS_FILE, payload, 'utf8');
}

async function pruneCampaigns() {
    const raw = await readJsonSafe(CAMPAIGNS_FILE);
    if (!raw) return;
    const map = campaignsToMap(raw);
    const forbidden = new Set(Object.values(TEST_CAMPAIGNS).map(name => name.toLowerCase()));
    for (const [campaignId, campaign] of Object.entries(map)) {
        const name = (campaign?.productName || '').toLowerCase();
        if (forbidden.has(name)) {
            delete map[campaignId];
        }
    }
    const payload = serializeCampaigns(raw, map);
    await fs.writeFile(CAMPAIGNS_FILE, payload, 'utf8');
}

async function sanitizeTestFixtures() {
    await ensureSuperAdminCredentials();
    await pruneBrands();
    await pruneCampaigns();
}

function startHttpServer() {
    return new Promise((resolve, reject) => {
        if (server.listening) {
            return reject(new Error('Test server is already running'));
        }
        const onError = (error) => {
            server.off('error', onError);
            reject(error);
        };
        server.once('error', onError);
        server.listen(0, () => {
            server.off('error', onError);
            const address = server.address();
            if (!address || !address.port) {
                return reject(new Error('Failed to retrieve server port'));
            }
            resolve(address.port);
        });
    });
}

function stopHttpServer() {
    return new Promise((resolve, reject) => {
        server.close(error => {
            if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
                return reject(error);
            }
            resolve();
        });
    });
}

async function runSuite() {
    const reporter = new Reporter();
    const backups = await backupFiles();
    let backupsRestored = false;
    let serverStarted = false;
    let port = null;

    const state = {
        brandIds: {},
        userIds: {},
        campaignIds: {}
    };

    let adminClient = null;
    let adminToken = null;
    let adminCsrfToken = null;
    let superAdminId = null;

    try {
        reporter.section('1. Setup');
        await reporter.check('Clean test data (Coke/Pepsi artifacts removed)', async () => {
            await sanitizeTestFixtures();
            return 'Fixtures sanitized';
        });

        port = await reporter.check('Start server on test port', async () => {
            const assignedPort = await startHttpServer();
            serverStarted = true;
            return assignedPort;
        });

        adminClient = new HttpClient(port);
        await reporter.check('Fetch CSRF token for super admin login', async () => {
            adminCsrfToken = await adminClient.getCsrfToken();
            assert.ok(adminCsrfToken, 'Missing CSRF token');
            return 'CSRF token acquired';
        });

        await reporter.check('Login as super admin', async () => {
            const response = await adminClient.login(SUPER_ADMIN.email, SUPER_ADMIN.password, adminCsrfToken);
            adminToken = response.token;
            superAdminId = response.user?.id || null;
            assert.ok(adminToken, 'Missing bearer token');
            assert.equal(response.user?.is_super_admin || response.user?.isSuperAdmin, true, 'Expected super admin privileges');
            return `Authenticated as ${response.user?.email}`;
        });

        reporter.section('2. Create Brands');
        const adminActionCsrf = await adminClient.getCsrfToken();

        await reporter.check('Create Coca Cola brand', async () => {
            const result = await adminClient.request('POST', '/api/brands', {
                token: adminToken,
                headers: { 'x-csrf-token': adminActionCsrf },
                body: { name: TEST_BRANDS.coca }
            });
            assert.equal(result.status, 201, `Expected 201, received ${result.status}`);
            const brandId = result.body?.brand?.id;
            assert.ok(brandId, 'Missing Coca Cola brand id');
            state.brandIds.coca = brandId;
            return `Brand ID ${brandId}`;
        });

        await reporter.check('Create Pepsi brand', async () => {
            const result = await adminClient.request('POST', '/api/brands', {
                token: adminToken,
                headers: { 'x-csrf-token': adminActionCsrf },
                body: { name: TEST_BRANDS.pepsi }
            });
            assert.equal(result.status, 201, `Expected 201, received ${result.status}`);
            const brandId = result.body?.brand?.id;
            assert.ok(brandId, 'Missing Pepsi brand id');
            state.brandIds.pepsi = brandId;
            return `Brand ID ${brandId}`;
        });

        reporter.section('3. Create Users');
        const cocaUserPayload = {
            email: TEST_USERS.coca.email,
            password: TEST_USERS.coca.password,
            brand_id: state.brandIds.coca,
            is_super_admin: false
        };
        const pepsiUserPayload = {
            email: TEST_USERS.pepsi.email,
            password: TEST_USERS.pepsi.password,
            brand_id: state.brandIds.pepsi,
            is_super_admin: false
        };

        await reporter.check('Create Coca Cola user', async () => {
            const result = await adminClient.request('POST', '/api/users', {
                token: adminToken,
                headers: { 'x-csrf-token': adminActionCsrf },
                body: cocaUserPayload
            });
            assert.equal(result.status, 201, `Expected 201, received ${result.status}`);
            const userId = result.body?.user?.id;
            assert.ok(userId, 'Missing Coca Cola user id');
            state.userIds.coca = userId;
            return `User ID ${userId}`;
        });

        await reporter.check('Create Pepsi user', async () => {
            const result = await adminClient.request('POST', '/api/users', {
                token: adminToken,
                headers: { 'x-csrf-token': adminActionCsrf },
                body: pepsiUserPayload
            });
            assert.equal(result.status, 201, `Expected 201, received ${result.status}`);
            const userId = result.body?.user?.id;
            assert.ok(userId, 'Missing Pepsi user id');
            state.userIds.pepsi = userId;
            return `User ID ${userId}`;
        });

        reporter.section('4. Create Campaigns');
        const cocaCampaignId = createCampaignId('coke');
        const pepsiCampaignId = createCampaignId('pepsi');
        state.campaignIds.coca = cocaCampaignId;
        state.campaignIds.pepsi = pepsiCampaignId;

        await reporter.check('Create Coca Cola campaign', async () => {
            const payload = createCampaignPayload({
                campaignId: cocaCampaignId,
                brandId: state.brandIds.coca,
                name: TEST_CAMPAIGNS.coca,
                imageUrl: 'https://images.unsplash.com/photo-1510626176961-4b57d4fbad03?w=640'
            });
            const result = await adminClient.request('POST', '/api/campaigns', {
                token: adminToken,
                headers: { 'x-csrf-token': adminActionCsrf },
                body: payload
            });
            assert.equal(result.status, 201, `Expected 201, received ${result.status}`);
            assert.equal(result.body?.campaignId, cocaCampaignId, 'Campaign ID mismatch');
            return `Campaign ${cocaCampaignId}`;
        });

        await reporter.check('Create Pepsi campaign', async () => {
            const payload = createCampaignPayload({
                campaignId: pepsiCampaignId,
                brandId: state.brandIds.pepsi,
                name: TEST_CAMPAIGNS.pepsi,
                imageUrl: 'https://images.unsplash.com/photo-1470337458703-46ad1756a187?w=640'
            });
            const result = await adminClient.request('POST', '/api/campaigns', {
                token: adminToken,
                headers: { 'x-csrf-token': adminActionCsrf },
                body: payload
            });
            assert.equal(result.status, 201, `Expected 201, received ${result.status}`);
            assert.equal(result.body?.campaignId, pepsiCampaignId, 'Campaign ID mismatch');
            return `Campaign ${pepsiCampaignId}`;
        });

        reporter.section('5. Test Brand Isolation');
        const cocaClient = new HttpClient(port);
        let cocaToken = null;
        await reporter.check('Login as coke@example.com', async () => {
            const csrf = await cocaClient.getCsrfToken();
            const response = await cocaClient.login(TEST_USERS.coca.email, TEST_USERS.coca.password, csrf);
            cocaToken = response.token;
            assert.ok(cocaToken, 'Missing Coca Cola user token');
            return 'Brand user authenticated';
        });

        await reporter.check('Coca Cola user sees only Coca Cola campaigns', async () => {
            const listResponse = await cocaClient.request('GET', '/api/campaigns', { token: cocaToken });
            assert.equal(listResponse.status, 200, `Unexpected status ${listResponse.status}`);
            const campaigns = getCampaignListFromResponse(listResponse.body);
            assert.equal(campaigns.length, 1, `Expected 1 campaign, received ${campaigns.length}`);
            assert.equal(campaigns[0]?.id, cocaCampaignId, 'Incorrect campaign returned');
            return 'Coca Cola campaign isolated';
        });

        await reporter.check('Coca Cola user blocked from Pepsi campaign (404)', async () => {
            const response = await cocaClient.request('GET', `/api/campaign/${pepsiCampaignId}`, { token: cocaToken });
            assert.equal(response.status, 404, `Expected 404, received ${response.status}`);
            return 'Pepsi campaign hidden via 404';
        });

        const pepsiClient = new HttpClient(port);
        let pepsiToken = null;
        await reporter.check('Login as pepsi@example.com', async () => {
            const csrf = await pepsiClient.getCsrfToken();
            const response = await pepsiClient.login(TEST_USERS.pepsi.email, TEST_USERS.pepsi.password, csrf);
            pepsiToken = response.token;
            assert.ok(pepsiToken, 'Missing Pepsi user token');
            return 'Brand user authenticated';
        });

        await reporter.check('Pepsi user sees only Pepsi campaigns', async () => {
            const listResponse = await pepsiClient.request('GET', '/api/campaigns', { token: pepsiToken });
            assert.equal(listResponse.status, 200, `Unexpected status ${listResponse.status}`);
            const campaigns = getCampaignListFromResponse(listResponse.body);
            assert.equal(campaigns.length, 1, `Expected 1 campaign, received ${campaigns.length}`);
            assert.equal(campaigns[0]?.id, pepsiCampaignId, 'Incorrect campaign returned');
            return 'Pepsi campaign isolated';
        });

        await reporter.check('Pepsi user blocked from Coca Cola campaign (404)', async () => {
            const response = await pepsiClient.request('GET', `/api/campaign/${cocaCampaignId}`, { token: pepsiToken });
            assert.equal(response.status, 404, `Expected 404, received ${response.status}`);
            return 'Coca Cola campaign hidden via 404';
        });

        reporter.section('6. Test Super Admin Access');
        await reporter.check('Super admin sees both campaigns', async () => {
            const response = await adminClient.request('GET', '/api/campaigns', { token: adminToken });
            assert.equal(response.status, 200, `Unexpected status ${response.status}`);
            const campaigns = getCampaignListFromResponse(response.body);
            const ids = new Set(campaigns.map(item => item.id));
            assert.ok(ids.has(cocaCampaignId), 'Missing Coca Cola campaign');
            assert.ok(ids.has(pepsiCampaignId), 'Missing Pepsi campaign');
            return `Campaigns visible: ${campaigns.length}`;
        });

        await reporter.check('Super admin sees both brands', async () => {
            const response = await adminClient.request('GET', '/api/brands', { token: adminToken });
            assert.equal(response.status, 200, `Unexpected status ${response.status}`);
            const brands = getBrandListFromResponse(response.body);
            const names = new Set(brands.map(brand => (brand.name || '').toLowerCase()));
            assert.ok(names.has(TEST_BRANDS.coca.toLowerCase()), 'Coca Cola missing');
            assert.ok(names.has(TEST_BRANDS.pepsi.toLowerCase()), 'Pepsi missing');
            return `Brands visible: ${brands.length}`;
        });

        reporter.section('7. Cleanup');
        const cleanupCsrf = await adminClient.getCsrfToken();

        await reporter.check('Delete Coca Cola campaign', async () => {
            const response = await adminClient.request('DELETE', `/api/campaign/${cocaCampaignId}`, {
                token: adminToken,
                headers: { 'x-csrf-token': cleanupCsrf }
            });
            assert.equal(response.status, 200, `Unexpected status ${response.status}`);
            return 'Coca Cola campaign deleted';
        });

        await reporter.check('Delete Pepsi campaign', async () => {
            const response = await adminClient.request('DELETE', `/api/campaign/${pepsiCampaignId}`, {
                token: adminToken,
                headers: { 'x-csrf-token': cleanupCsrf }
            });
            assert.equal(response.status, 200, `Unexpected status ${response.status}`);
            return 'Pepsi campaign deleted';
        });

        await reporter.check('Delete Coca Cola user', async () => {
            const response = await adminClient.request('DELETE', `/api/users/${state.userIds.coca}`, {
                token: adminToken,
                headers: { 'x-csrf-token': cleanupCsrf }
            });
            assert.equal(response.status, 200, `Unexpected status ${response.status}`);
            return 'Coca Cola user deleted';
        });

        await reporter.check('Delete Pepsi user', async () => {
            const response = await adminClient.request('DELETE', `/api/users/${state.userIds.pepsi}`, {
                token: adminToken,
                headers: { 'x-csrf-token': cleanupCsrf }
            });
            assert.equal(response.status, 200, `Unexpected status ${response.status}`);
            return 'Pepsi user deleted';
        });

        await reporter.check('Delete Coca Cola brand', async () => {
            const response = await adminClient.request('DELETE', `/api/brands/${state.brandIds.coca}`, {
                token: adminToken,
                headers: { 'x-csrf-token': cleanupCsrf }
            });
            assert.equal(response.status, 200, `Unexpected status ${response.status}`);
            return 'Coca Cola brand deleted';
        });

        await reporter.check('Delete Pepsi brand', async () => {
            const response = await adminClient.request('DELETE', `/api/brands/${state.brandIds.pepsi}`, {
                token: adminToken,
                headers: { 'x-csrf-token': cleanupCsrf }
            });
            assert.equal(response.status, 200, `Unexpected status ${response.status}`);
            return 'Pepsi brand deleted';
        });

        await reporter.check('Stop test server', async () => {
            await stopHttpServer();
            serverStarted = false;
            return 'Server stopped';
        });

        await reporter.check('Restore original data snapshot', async () => {
            await restoreFiles(backups);
            backupsRestored = true;
            return 'Data files reverted';
        });

        reporter.section('8. Reporting');
        reporter.summary();
    } catch (error) {
        console.error('\n❌ Test suite error:', error.stack || error.message);
        process.exitCode = 1;
    } finally {
        if (serverStarted) {
            await stopHttpServer().catch(err => console.error('Failed to stop server:', err.message));
        }
        if (!backupsRestored) {
            await restoreFiles(backups).catch(err => console.error('Failed to restore files:', err.message));
        }
        reporter.summary();
    }
}

runSuite().catch(error => {
    console.error('❌ Unhandled error:', error.stack || error.message);
    process.exit(1);
});
