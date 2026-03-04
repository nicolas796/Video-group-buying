#!/usr/bin/env node

const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key';
const { server, signToken, buildAuthPayload } = require('./server');
const BRANDS_FILE = path.join(__dirname, 'data', 'brands.json');
const SUPER_ADMIN_USER = {
    id: 'user_001',
    brandId: 'brand_001',
    isSuperAdmin: true
};
const REGULAR_USER = {
    id: 'user_brand002',
    brandId: 'brand_002',
    isSuperAdmin: false
};

function buildAuthToken({ id, brandId, isSuperAdmin }) {
    const payload = buildAuthPayload({
        id,
        brand_id: brandId || null,
        brandId: brandId || null,
        is_super_admin: Boolean(isSuperAdmin)
    });
    return signToken(payload);
}

function createRequest(port) {
    return function request(method, targetPath, { token, body } = {}) {
        return new Promise((resolve, reject) => {
            const payload = body ? JSON.stringify(body) : null;
            const headers = {
                'Content-Type': 'application/json'
            };
            if (payload) {
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
                res.on('data', chunk => {
                    data += chunk;
                });
                res.on('end', () => {
                    let parsed = null;
                    if (data) {
                        try {
                            parsed = JSON.parse(data);
                        } catch (error) {
                            return reject(new Error(`Failed to parse response from ${method} ${targetPath}: ${error.message}`));
                        }
                    }
                    resolve({ status: res.statusCode, body: parsed });
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

async function restoreBrandsBackup(backup) {
    if (typeof backup === 'string') {
        await fs.writeFile(BRANDS_FILE, backup, 'utf8');
    }
}

async function run() {
    const backup = await fs.readFile(BRANDS_FILE, 'utf8');
    let started = false;
    let port;
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
    const superToken = buildAuthToken(SUPER_ADMIN_USER);
    const regularToken = buildAuthToken(REGULAR_USER);

    try {
        // GET as super admin
        const listRes = await request('GET', '/api/brands', { token: superToken });
        assert.equal(listRes.status, 200, 'Super admin should fetch brands');
        assert.ok(Array.isArray(listRes.body?.brands), 'Brands payload missing');
        assert.ok(listRes.body.brands.every(brand => typeof brand.campaign_count === 'number'), 'campaign_count missing from brands');

        // GET as regular user should be forbidden
        const listRegular = await request('GET', '/api/brands', { token: regularToken });
        assert.equal(listRegular.status, 403, 'Regular user should not access brands list');

        // Create brand as super admin
        const brandName = `Test Brand ${Date.now()}`;
        const createRes = await request('POST', '/api/brands', {
            token: superToken,
            body: { name: brandName }
        });
        assert.equal(createRes.status, 201, 'Super admin should create brand');
        assert.equal(createRes.body?.success, true, 'Create response missing success flag');
        assert.equal(createRes.body?.brand?.name, brandName, 'Created brand name mismatch');
        const createdBrandId = createRes.body.brand.id;
        assert.ok(createdBrandId, 'Created brand id missing');

        // Regular user cannot create brand
        const blockedCreate = await request('POST', '/api/brands', {
            token: regularToken,
            body: { name: 'Blocked Brand' }
        });
        assert.equal(blockedCreate.status, 403, 'Regular user create should be forbidden');

        // Update created brand as super admin
        const updatedName = `${brandName} Updated`;
        const updateRes = await request('PUT', `/api/brands/${createdBrandId}`, {
            token: superToken,
            body: { name: updatedName }
        });
        assert.equal(updateRes.status, 200, 'Super admin should update brand');
        assert.equal(updateRes.body?.brand?.name, updatedName, 'Updated brand name mismatch');

        // Regular user update should fail
        const blockedUpdate = await request('PUT', `/api/brands/${createdBrandId}`, {
            token: regularToken,
            body: { name: 'No Access' }
        });
        assert.equal(blockedUpdate.status, 403, 'Regular user update should be forbidden');

        // Regular user delete should fail
        const blockedDelete = await request('DELETE', `/api/brands/${createdBrandId}`, { token: regularToken });
        assert.equal(blockedDelete.status, 403, 'Regular user delete should be forbidden');

        // Super admin cannot delete brand with campaigns
        const protectedDelete = await request('DELETE', '/api/brands/brand_001', { token: superToken });
        assert.equal(protectedDelete.status, 400, 'Deleting brand with campaigns should fail');
        assert.equal(protectedDelete.body?.error, 'Cannot delete brand with campaigns');

        // Super admin deletes the newly created brand (no campaigns)
        const deleteRes = await request('DELETE', `/api/brands/${createdBrandId}`, { token: superToken });
        assert.equal(deleteRes.status, 200, 'Super admin should delete unused brand');
        assert.equal(deleteRes.body?.success, true, 'Delete response missing success flag');

        console.log('✅ Brand API endpoints verified successfully');
    } finally {
        if (started) {
            await new Promise(resolve => server.close(resolve));
        }
        await restoreBrandsBackup(backup);
    }
}

run().catch(error => {
    console.error('❌ Brand API tests failed:', error);
    process.exit(1);
});
