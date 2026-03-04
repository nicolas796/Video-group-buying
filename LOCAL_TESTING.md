# Brand Isolation - Local Testing Guide

## Quick Start
1. `cd group-buying`
2. `npm install`
3. `cp .env.example .env` and set a 32+ character `JWT_SECRET`
4. `node server.js`
5. Open `http://localhost:8080/admin.html`

## Default Credentials
- **Super Admin:** `admin@estreamly.com / ChangeMe123!`
- Rotate this as soon as you finish smoke testing. Use the Users tab to generate a new password.

## Manual Brand Isolation Walkthrough
1. Login as the super admin.
2. In **Brands**, create "Coca Cola" and "Pepsi".
3. In **Users**, invite a user for each brand.
4. In **Campaigns**, create campaigns for each brand (or assign existing ones).
5. Log out and back in as a brand user. Confirm you only see your brand.
6. Attempt to fetch another brand's campaign ID directly → expect a 404 instead of 403 (prevents leaking IDs).
7. Switch back to super admin to verify you can browse everything.

## Running Tests
Run all commands from the `group-buying` directory (server is auto-spawned where needed):

```bash
node test-brands-api.js
node test-users-api.js
node test-full-brand-isolation.js
node test-cache-and-pagination.js
node test-data-layer.js
node test-e2e-complete.js
node tests/referral-label.unit.test.js
python3 test_path_traversal.py
```

## Test Results
Successful runs end with:

```
✅ Final summary: "26/26 tests passed"
```

If any command exits non-zero, fix the underlying issue before continuing.

## Troubleshooting
- **CSRF token errors:** Ensure you fetch `/api/csrf-token` before login or admin POSTs. Tokens are single-use; grab a fresh one per form submit.
- **Port already in use:** Stop previous `node server.js` instances or set `PORT=0` when running automated tests so they can bind an ephemeral port.
- **Stale data files:** Tests back up and restore files, but if you kill them mid-run delete `data/*.backup.*.json` and re-copy from a clean snapshot.
- **JWT secret missing:** Admin login fails with `500` if `JWT_SECRET` is empty. Export it in `.env` or your shell before running the server/tests.

## File Structure
- `data/brands.json` - Brand definitions
- `data/users.json` - User accounts with brand assignment
- `data/campaigns.json` - Campaigns with `brand_id`
