# Group Buying - eStreamly

Mobile-optimized group buying landing page with live video, progress tracking, and SMS/email capture.

## Quick Start

```bash
cd group-buying
cp .env.example .env # fill in secrets before running
node server.js
```

- **Drop page**: `http://localhost:8080`
- **Admin panel**: `http://localhost:8080/admin.html`

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

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/config` | GET | Get current config |
| `/api/join` | POST | Join drop, returns referral code |
| `/api/participants` | GET | List all participants |
| `/api/referral/:code` | GET | Check referral count/status |
| `/api/admin/config` | POST | Update configuration |
| `/api/sms/webhook` | POST | Twilio incoming SMS webhook |
