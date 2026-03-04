# Group Buying - eStreamly

Mobile-optimized group buying landing page with live video, progress tracking, referrals, and SMS/email capture for multi-brand operators.

## Multi-Tenant Brand Isolation

### What it is
Every admin, campaign, participant, and notification is scoped to a `brand_id`. Brand admins can only see and edit resources that belong to their tenant, while super admins can monitor or impersonate any brand without logging out.

### Why it exists
Retail partners such as Coke and Pepsi need to run overlapping drops without leaking data to each other. Brand isolation keeps audiences, referral links, and SMS activity partitioned so agency teams can host dozens of concurrent drops from a single deployment.

### How it works
- **Brand-aware storage** lives in `data/brands.json`, `data/users.json`, and `data/campaigns.json`. Every campaign row records the owning `brand_id`.
- **Auth tokens** are issued after a CSRF-protected login with bcrypt password verification. Each token carries the user's brand scope and `is_super_admin` flag.
- **API enforcement** happens in `requireAuth`/`requireCampaignAccess`, which filter `/api/campaigns`, `/api/participants`, referrals, notifications, and uploads by brand.
- **Super admin tooling** includes brand CRUD, user management (invites, resets, toggling super-admin), cross-brand campaign edits, and guard rails that prevent deleting a brand that still owns campaigns.

#### Default Super Admin Credentials
- **Email:** `admin@estreamly.com`
- **Password:** `ChangeMe123!`

> ⚠️ **Security warning:** Change the default password immediately in any shared environment. Use the Users tab to rotate the credentials and store them securely. See [LOCAL_TESTING.md](LOCAL_TESTING.md) for the full local workflow and validation checklist.

## Quick Start

```bash
cd group-buying
npm install
cp .env.example .env  # fill in JWT_SECRET before running
node server.js
```

- Drop page: `http://localhost:8080` (use your configured PORT if different)
- Admin panel: `http://localhost:8080/admin.html`
- Detailed brand-by-brand validation steps live in [LOCAL_TESTING.md](LOCAL_TESTING.md).

## Environment Variables & Secrets

All sensitive configuration (Twilio credentials, admin overrides, HTTPS settings, etc.) should be supplied through environment variables instead of committing raw values into the repo.

1. Copy `.env.example` to `.env` and populate it with your local/staging values.
2. Load the variables before running the server (e.g., `export $(grep -v '^#' .env | xargs) && node server.js`).
3. Keep `.env` out of Git — it is already ignored, but double-check with `git status` before committing.
4. `data/config.json` may contain runtime values for Twilio credentials once you save them via the admin panel. Treat that file as sensitive data: never commit it after populating secrets. If you need a sanitized reference, create a `config.example.json` without real secrets.
5. See `SECRETS.md` for the full secrets-management checklist (rotation, storage, incident response).

## HTTPS Enforcement Middleware

A dedicated middleware now runs before every request:

1. In production (`NODE_ENV=production`) or whenever `FORCE_HTTPS=true`, HTTP traffic is 301-redirected to the HTTPS version of the requested host.
2. Once a request is already secure, the middleware adds HSTS (`Strict-Transport-Security: max-age=31536000; includeSubDomains`) so browsers remember to use HTTPS.
3. Hosts/IPs listed in `HTTPS_EXEMPT_HOSTS` (defaults: `localhost,127.0.0.1`) skip both the redirect and the HSTS header, keeping local development HTTP-friendly.

Environment overrides:
- `FORCE_HTTPS=true|false` — force enable/disable the middleware regardless of `NODE_ENV` (defaults to `true` in production, `false` elsewhere).
- `HTTPS_EXEMPT_HOSTS=localhost,127.0.0.1` — comma-separated list of hosts/IPs that should never be redirected.

Because the middleware runs before any other handler, no application code runs without HTTPS when enforcement is active.

## API Overview

| Endpoint | Method(s) | Auth | Description |
|----------|-----------|------|-------------|
| `/api/config` | GET | Public | Returns the campaign config (pricing, countdown, media) used by the drop page. |
| `/api/join` | POST | Public (rate limited) | Adds a participant, generates referral code, and fires Twilio capture logic. |
| `/api/participants` | GET | Admin token | Lists participants for the caller's brand; super admins get all brands. |
| `/api/referral/:code?campaignId=XYZ` | GET | Public | Returns referral progress for the supplied code/campaign pair. |
| `/api/referral/:code?campaignId=XYZ` | POST/PUT | Admin token | Allows admins to credit referrals manually (brand scoped). |
| `/api/admin/config` | POST | Admin token + CSRF | Updates campaign config, price tiers, countdown, and Twilio settings. |
| `/api/login` | POST | CSRF | Issues a bearer token for admin access; response includes brand context. |
| `/api/logout` | POST | Admin token | Revokes the caller's session. |
| `/api/me` | GET | Admin token | Returns the authenticated user's profile, brand scope, and permissions. |
| `/api/brands` | GET/POST | Super admin | Lists or creates brands. Non-super admins receive 403. |
| `/api/brands/:id` | PUT/DELETE | Super admin | Updates or deletes a brand (deletion blocked when campaigns exist). |
| `/api/users` | GET/POST | Super admin | Lists or invites users with assigned brands. |
| `/api/users/:id` | PUT/DELETE | Super admin | Rotates passwords, toggles super-admin, or deletes users. |
| `/api/campaigns` | GET/POST | Admin token | Brand-filtered list/create endpoint; super admins can set `brand_id`. |
| `/api/campaign/:id` | GET | Admin token | Fetches a single campaign; cross-brand access returns 404. |
| `/api/sms/webhook` | POST | Twilio | Handles inbound STOP/START messages and delivery receipts. |

## Admin Panel

Manage your drop at **`http://localhost:8080/admin.html`**

Configure everything:
- 📦 Product details (image, name, description)
- 🎥 Video URL (m3u8)
- 💰 Initial price & buyer count
- 🎯 Price tiers (buyers needed → price unlocked)
- ⏰ Countdown end time
- 📱 Twilio SMS settings
- 📊 Live stats & participant list

## Twilio SMS Integration

When someone joins, they automatically receive an SMS:

> "You're in the drop! 🎉 Share your unique link to unlock the lowest price ($20) now: https://your-domain.com/?ref=A3F9B2D1 - Get 2 friends to join and you win! Reply STOP to unsubscribe."

**Setup:**
1. Get a Twilio account at [twilio.com](https://twilio.com)
2. Buy a phone number with SMS capability
3. In admin panel, enter:
   - Account SID
   - Auth Token
   - Twilio Phone Number
   - Your domain (for referral links)
4. Set webhook URL in Twilio: `https://your-domain.com/api/sms/webhook`

**SMS Commands:**
- `STOP` - Unsubscribe from messages
- `START` - Resubscribe

## Database

All data stored in JSON files (no database server needed):

### `data/config.json`
- `initialBuyers` - Starting buyer count (for social proof)
- `initialPrice` - Default/max price
- `priceTiers` - Unlock thresholds and prices
- `countdownEnd` - When the drop ends (ISO 8601)
- `videoSource` - m3u8 URL
- `product` - Product details
- `twilio` - Twilio credentials
- `domain` - Your domain for referral links

### `data/participants.json`
Auto-populated when users join:
- `phone` - Cellphone number
- `email` - Email address
- `referralCode` - Unique referral code
- `referredBy` - Who referred them (if anyone)
- `joinedAt` - Timestamp

### `data/optouts.json`
Phone numbers that have opted out of SMS.

## Referral System

Each user gets a unique referral code in their URL (`?ref=XXXXXX`).

**🎁 Unlock best price instantly**: Get 2 friends to join via your link → unlock the lowest price immediately (skip the countdown).

## Price Tier Logic

Default:
- 0-99 buyers: $80
- 100+ buyers: $40
- 500+ buyers: $30
- 1000+ buyers: $20
# Deploy trigger
