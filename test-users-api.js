#!/usr/bin/env node

const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-key';
const { server, signToken, buildAuthPayload } = require('./server');

const USERS_FILE = path.join(__dirname, 'data', 'users.json');
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

async function restoreUsersBackup(backup) {
    if (typeof backup === 'string') {
        await fs.writeFile(USERS_FILE, backup, 'utf8');
    }
}

async function run() {
    const backup = await fs.readFile(USERS_FILE, 'utf8');
    let started = false;
    let port;

    await new Promise((resolve, reject) => {
        const onError = error => {
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
        // Super admin can list users
        const listRes = await request('GET', '/api/users', { token: superToken });
        assert.equal(listRes.status, 200, 'Super admin should fetch users');
        assert.ok(Array.isArray(listRes.body?.users), 'Users array missing');
        assert.ok(listRes.body.users.every(user => Object.prototype.hasOwnProperty.call(user, 'brand_name')), 'brand_name missing from response');
        const initialCount = listRes.body.users.length;

        // Regular user cannot list users
        const blockedList = await request('GET', '/api/users', { token: regularToken });
        assert.equal(blockedList.status, 403, 'Regular user list should be forbidden');

        // Create new user as super admin
        const newUserPayload = {
            email: `api_user_${Date.now()}@example.com`,
            password: 'secret123',
            brand_id: 'brand_002',
            is_super_admin: false
        };
        const createRes = await request('POST', '/api/users', {
            token: superToken,
            body: newUserPayload
        });
        assert.equal(createRes.status, 201, 'Create should return 201');
        assert.equal(createRes.body?.success, true, 'Create response missing success');
        const createdUser = createRes.body?.user;
        assert.ok(createdUser?.id, 'Created user id missing');
        assert.equal(createdUser.brand_id, newUserPayload.brand_id, 'Created user brand mismatch');
        assert.equal(createdUser.is_super_admin, false, 'Created user super admin flag mismatch');

        // Duplicate email should fail
        const duplicateRes = await request('POST', '/api/users', {
            token: superToken,
            body: newUserPayload
        });
        assert.equal(duplicateRes.status, 409, 'Duplicate email should be rejected');

        // Regular user cannot create users
        const regularCreate = await request('POST', '/api/users', {
            token: regularToken,
            body: {
                email: 'blocked@example.com',
                password: 'secret123',
                brand_id: 'brand_001',
                is_super_admin: false
            }
        });
        assert.equal(regularCreate.status, 403, 'Regular user create should be forbidden');

        // Update user brand and super admin flag
        const updateRes = await request('PUT', `/api/users/${createdUser.id}`, {
            token: superToken,
            body: {
                brand_id: 'brand_001',
                is_super_admin: true
            }
        });
        assert.equal(updateRes.status, 200, 'Update should succeed');
        assert.equal(updateRes.body?.user?.brand_id, 'brand_001', 'Updated brand_id mismatch');
        assert.equal(updateRes.body?.user?.brand_name, 'Default Brand', 'Updated brand_name mismatch');
        assert.equal(updateRes.body?.user?.is_super_admin, true, 'Updated super admin flag mismatch');

        // Cannot remove own super admin status
        const selfDemote = await request('PUT', `/api/users/${SUPER_ADMIN_USER.id}`, {
            token: superToken,
            body: { is_super_admin: false }
        });
        assert.equal(selfDemote.status, 400, 'Self-demotion should be blocked');
        assert.match(selfDemote.body?.error || '', /cannot remove/i, 'Self-demotion error message missing');

        // Regular user cannot update users
        const regularUpdate = await request('PUT', `/api/users/${createdUser.id}`, {
            token: regularToken,
            body: { brand_id: 'brand_002' }
        });
        assert.equal(regularUpdate.status, 403, 'Regular user update should be forbidden');

        // Cannot delete own account
        const selfDelete = await request('DELETE', `/api/users/${SUPER_ADMIN_USER.id}`, { token: superToken });
        assert.equal(selfDelete.status, 400, 'Deleting self should be blocked');

        // Regular user cannot delete users
        const regularDelete = await request('DELETE', `/api/users/${createdUser.id}`, { token: regularToken });
        assert.equal(regularDelete.status, 403, 'Regular user delete should be forbidden');

        // Super admin deletes created user
        const deleteRes = await request('DELETE', `/api/users/${createdUser.id}`, { token: superToken });
        assert.equal(deleteRes.status, 200, 'Delete should succeed');
        assert.equal(deleteRes.body?.success, true, 'Delete response missing success');

        // Confirm user count back to original
        const finalList = await request('GET', '/api/users', { token: superToken });
        assert.equal(finalList.status, 200, 'Final list should succeed');
        assert.equal(finalList.body.users.length, initialCount, 'User count should return to original');

        console.log('✅ Users API endpoints verified successfully');
    } finally {
        if (started) {
            await new Promise(resolve => server.close(resolve));
        }
        await restoreUsersBackup(backup);
    }
}

run().catch(error => {
    console.error('❌ Users API tests failed:', error);
    process.exit(1);
});
