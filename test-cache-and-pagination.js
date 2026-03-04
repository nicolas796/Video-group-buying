#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key';

const DATA_DIR = path.join(__dirname, 'data');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
const { server, signToken, buildAuthPayload } = require('./server');

function buildAuthToken({ id, brandId, isSuperAdmin }) {
    const payload = buildAuthPayload({
        id,
        brand_id: brandId,
        brandId,
        is_super_admin: Boolean(isSuperAdmin)
    });
    return signToken(payload);
}

function createRequest(port) {
    return function request(method, targetPath, { token, body } = {}) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const headers = { Accept: 'application/json' };
            if (payload) {
                headers['Content-Type'] = 'application/json';
                headers['Content-Length'] = Buffer.byteLength(payload);
            }
            if (token) {
                headers['Authorization'] = `Bearer ${token}`;
            }
            const options = {
                method,
                hostname: '127.0.0.1',
                port,
                path: targetPath,
                headers
            };
            const req = http.request(options, res => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        const parsed = data ? JSON.parse(data) : null;
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
    };
}

function toCampaignList(payload) {
    if (Array.isArray(payload?.campaigns)) {
        return payload.campaigns;
    }
    if (Array.isArray(payload)) {
        return payload;
    }
    return [];
}

function buildCampaign(id, brandId, name, price) {
    return {
        id,
        name,
        productName: name,
        productDescription: `${name} description`,
        brand_id: brandId,
        brandId,
        merchantName: `${brandId} Merchant`,
        price,
        originalPrice: price * 1.5,
        pricing: {
            initialPrice: price * 1.5,
            initialBuyers: 0,
            checkoutUrl: 'https://example.com/checkout',
            tiers: [
                { buyers: 10, price: price - 5, couponCode: 'DROP10' },
                { buyers: 25, price: price - 10, couponCode: 'DROP25' }
            ]
        },
        countdownEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        referralsNeeded: 2
    };
}

function createFixtureCampaigns() {
    return [
        buildCampaign('brand1_alpha', 'brand_001', 'Brand 1 Alpha', 90),
        buildCampaign('brand1_beta', 'brand_001', 'Brand 1 Beta', 95),
        buildCampaign('brand1_gamma', 'brand_001', 'Brand 1 Gamma', 100),
        buildCampaign('brand1_delta', 'brand_001', 'Brand 1 Delta', 105),
        buildCampaign('brand2_alpha', 'brand_002', 'Brand 2 Alpha', 80),
        buildCampaign('brand2_beta', 'brand_002', 'Brand 2 Beta', 82)
    ];
}

async function testCachingLayer() {
    const counts = { brands: 0, users: 0 };
    const originalReadFile = fs.promises.readFile;
    fs.promises.readFile = async (...args) => {
        try {
            const fileName = path.basename(args[0]);
            if (fileName === 'brands.json') counts.brands += 1;
            if (fileName === 'users.json') counts.users += 1;
        } catch (error) {
            // no-op counting error
        }
        return originalReadFile(...args);
    };

    try {
        delete require.cache[require.resolve('./data-store')];
        const store = require('./data-store');

        await store.loadBrands();
        await store.loadBrands();
        assert.equal(counts.brands, 1, 'Brand cache should avoid repeated disk reads');

        counts.brands = 0;
        counts.users = 0;
        delete require.cache[require.resolve('./data-store')];
        const freshStore = require('./data-store');
        await freshStore.loadUsers();
        await freshStore.loadUsers();
        assert.equal(counts.users, 1, 'User cache should avoid repeated disk reads');
        assert.equal(counts.brands, 1, 'Brand data should only be read once while loading users');

        console.log('✅ Data-store caching reduces redundant file reads');
    } finally {
        fs.promises.readFile = originalReadFile;
        delete require.cache[require.resolve('./data-store')];
    }
}

async function testCampaignPagination() {
    const backup = await fs.promises.readFile(CAMPAIGNS_FILE, 'utf8');
    const fixture = createFixtureCampaigns();
    await fs.promises.writeFile(CAMPAIGNS_FILE, JSON.stringify({ campaigns: fixture }, null, 2));

    const superToken = buildAuthToken({ id: 'user_001', brandId: 'brand_001', isSuperAdmin: true });
    const brandToken = buildAuthToken({ id: 'user_brand002', brandId: 'brand_002', isSuperAdmin: false });
    const brandTwoIds = fixture.filter(item => item.brand_id === 'brand_002').map(item => item.id);
    const expectedSecondBrandTwo = brandTwoIds[1];

    let started = false;
    let port;
    try {
        await new Promise((resolve, reject) => {
            const onError = (error) => {
                server.off('error', onError);
                reject(error);
            };
            server.once('error', onError);
            server.listen(0, () => {
                server.off('error', onError);
                started = true;
                port = server.address().port;
                resolve();
            });
        });

        const request = createRequest(port);

        const superRes = await request('GET', '/api/campaigns?brandId=brand_002&limit=1&page=2', { token: superToken });
        assert.equal(superRes.status, 200, 'Super admin brand-filtered request failed');
        const superCampaigns = toCampaignList(superRes.body);
        assert.equal(superCampaigns.length, 1, 'Filtered pagination should return one record per page');
        assert.equal(superCampaigns[0]?.id, expectedSecondBrandTwo, 'Brand filter must apply before pagination for super admins');
        assert.equal(superRes.body?.pagination?.page, 2, 'Pagination metadata should reflect requested page');
        assert.equal(superRes.body?.pagination?.total, brandTwoIds.length, 'Total count should match filtered campaigns');

        const brandRes = await request('GET', '/api/campaigns?limit=1&page=2', { token: brandToken });
        assert.equal(brandRes.status, 200, 'Brand user request failed');
        const brandCampaigns = toCampaignList(brandRes.body);
        assert.equal(brandCampaigns.length, 1, 'Brand user pagination should return one record per page');
        assert.equal(brandCampaigns[0]?.id, expectedSecondBrandTwo, 'Brand user should only see their own campaigns across pages');

        console.log('✅ Campaign pagination returns correct slices and metadata');
    } finally {
        if (started) {
            await new Promise(resolve => server.close(resolve));
        }
        await fs.promises.writeFile(CAMPAIGNS_FILE, backup, 'utf8');
    }
}

async function run() {
    await testCachingLayer();
    await testCampaignPagination();
    console.log('🎉 Cache and pagination tests completed successfully');
}

run().catch(error => {
    console.error('❌ Cache & pagination tests failed:', error);
    process.exit(1);
});
