# Multi-Campaign Landing Page System

This group buying landing page now supports multiple campaigns via URL parameters.

## How It Works

Each campaign is identified by a unique 11-character ID (like YouTube: `005EZsfHkpI`).

Campaigns are loaded dynamically from `data/campaigns.json` based on the URL parameter `?v={CAMPAIGN_ID}`.

## Quick Start

### 1. Test with existing campaigns

Three sample campaigns are included in `data/campaigns.json`:

| Campaign ID | Product | URL |
|------------|---------|-----|
| `005EZsfHkpI` | Welding Gloves | `/?v=005EZsfHkpI` |
| `1aBcD2eFgHi` | Coffee Beans | `/?v=1aBcD2eFgHi` |
| `XyZ789pQrSt` | Headphones | `/?v=XyZ789pQrSt` |

Start the server and visit:
```
http://localhost:8080/?v=005EZsfHkpI
```

### 2. Generate a new campaign ID

```bash
# Generate a single ID
node generate-campaign-id.js

# Generate multiple IDs
node generate-campaign-id.js --count=5

# Create a new campaign with template
node generate-campaign-id.js --create --name="My Product" --video="https://example.com/video.m3u8"
```

### 3. Add a campaign manually

Edit `data/campaigns.json` and add a new entry:

```json
{
  "YOUR_NEW_ID": {
    "videoUrl": "https://your-video-url.m3u8",
    "productName": "Your Product Name",
    "description": "<h4>Details</h4><p>HTML description...</p>",
    "price": 20,
    "originalPrice": 80,
    "imageUrl": "https://your-image-url.jpg",
    "sharesRequired": 2,
    "discountPercentage": 75,
    "merchantName": "Your Store",
    "merchantLogo": "https://your-logo.png",
    "initialBuyers": 100,
    "priceTiers": [
      {"buyers": 100, "price": 40},
      {"buyers": 500, "price": 30},
      {"buyers": 1000, "price": 20}
    ],
    "countdownEnd": "2026-03-20T14:00:00-05:00"
  }
}
```

## Campaign Data Structure

| Field | Type | Description |
|-------|------|-------------|
| `videoUrl` | string | HLS video stream URL (.m3u8) |
| `productName` | string | Product name displayed in UI |
| `description` | string | HTML description shown in expandable section |
| `price` | number | Final/best price at max tier |
| `originalPrice` | number | Starting price (shown as crossed out) |
| `imageUrl` | string | Product image URL |
| `sharesRequired` | number | Number of referrals needed to unlock best price |
| `discountPercentage` | number | Discount % (for display purposes) |
| `merchantName` | string | Merchant/store name |
| `merchantLogo` | string | Merchant logo URL |
| `initialBuyers` | number | Starting buyer count (for social proof) |
| `priceTiers` | array | Array of {buyers, price} for group buying tiers |
| `countdownEnd` | string | ISO 8601 datetime for offer expiration |

## API Endpoints

### Campaign Management

```
GET  /api/campaigns              # List all campaigns
GET  /api/campaign/:id           # Get specific campaign
GET  /api/campaign/:id/config    # Get campaign config for UI
GET  /api/campaign/:id/buyers    # Get current buyer count
POST /api/campaigns              # Create new campaign
```

### Join & Referrals

```
POST /api/join                   # Join a campaign (include campaignId in body)
GET  /api/referral/:code         # Get referral status
```

## File Structure

```
group-buying/
├── index.html           # Landing page
├── app.js              # Main application (campaign-aware)
├── campaign-loader.js  # Campaign loading module
├── server.js           # Node.js server with campaign APIs
├── generate-campaign-id.js  # Campaign ID generator tool
├── data/
│   ├── campaigns.json  # All campaign data
│   ├── config.json     # Legacy config (optional)
│   ├── participants.json
│   └── optouts.json
└── README.md
```

## URL Parameters

| Parameter | Description |
|-----------|-------------|
| `?v={ID}` | Campaign ID (required) |
| `?ref={CODE}` | Referral code (optional) |

Example with both parameters:
```
http://localhost:8080/?v=005EZsfHkpI&ref=A1B2C3D4
```

## Error Handling

If a campaign is not found, a friendly error page is shown with:
- Error message explaining the issue
- List of available campaigns to choose from
- Campaign ID that was attempted

## Browser Console

The app logs useful information to the console:
- Campaign loaded successfully
- Campaign ID being used
- Merchant name
- Any errors during initialization

## Notes

- Each campaign maintains its own participant list
- Referral codes are unique per participant across all campaigns
- SMS messages include the campaign ID in the referral URL
- The legacy `/api/config` endpoint still works for backward compatibility
