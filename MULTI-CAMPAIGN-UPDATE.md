# Multi-Campaign Admin Interface - Implementation Summary

## ✅ Completed Changes

### 1. Updated Campaign Data Structure (`data/campaigns.json`)

Each campaign now includes ALL admin-configurable fields:

```json
{
  "id": "005EZsfHkpI",
  "productName": "Product Name",
  "productImage": "https://...",
  "productDescription": "<h4>HTML description</h4>",
  "videoUrl": "https://.../video.m3u8",
  "twilio": {
    "enabled": true,
    "accountSid": "AC...",
    "authToken": "...",
    "phoneNumber": "+1234567890",
    "domain": "https://your-domain.com"
  },
  "pricing": {
    "initialPrice": 99.99,
    "initialBuyers": 10,
    "tiers": [
      {"buyers": 50, "price": 79.99},
      {"buyers": 100, "price": 59.99}
    ]
  },
  "referralsNeeded": 2,
  "countdownEnd": "2025-03-01T23:59:00Z",
  // Legacy fields maintained for backward compatibility
  "description": "...",
  "price": 20,
  "originalPrice": 99.99,
  "imageUrl": "...",
  "sharesRequired": 2,
  "discountPercentage": 75,
  "merchantName": "",
  "merchantLogo": "",
  "initialBuyers": 10,
  "priceTiers": [...]
}
```

### 2. Updated Admin Interface (`admin.html` + `admin.js`)

New features:
- **Campaign Selector Dropdown** at the top of the page
- **"+ New Campaign"** button to create campaigns
- **Campaign ID Display** showing the ID and links
- **Auto-population** of all fields when selecting a campaign
- **Save Changes** button saves via PUT /api/campaign/:id
- **Delete Campaign** button with confirmation
- **URL Support**: `admin.html?v=CAMPAIGN_ID` auto-selects that campaign

### 3. New API Endpoints (`server.js`)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/campaigns` | GET | List all campaigns (id, name, merchant, price) |
| `/api/campaigns` | POST | Create new campaign |
| `/api/campaign/:id` | GET | Get full campaign data |
| `/api/campaign/:id` | PUT | Update campaign (saves to campaigns.json) |
| `/api/campaign/:id` | DELETE | Delete campaign |
| `/api/campaign/:id/config` | GET | Get campaign config for landing page |
| `/api/campaign/:id/buyers` | GET | Get current buyer count |

### 4. Updated Campaign Loader (`campaign-loader.js`)

- Now reads from the new campaign structure
- Maps `pricing.tiers` and other new fields to legacy config format
- Supports campaign-specific Twilio configuration

### 5. Updated Landing Page (`app.js`)

- Reads all campaign fields from the new structure
- Falls back to legacy fields for backward compatibility
- Supports campaign-specific pricing and referral settings

### 6. Updated CLI Tool (`generate-campaign-id.js`)

New options:
```bash
# Create campaign with full config from JSON file
node generate-campaign-id.js --create-full --config=./campaign-config.json

# Config file format:
{
  "productName": "My Product",
  "productImage": "https://...",
  "productDescription": "<h4>Details</h4>...",
  "videoUrl": "https://...",
  "twilio": { "enabled": true, ... },
  "pricing": { "initialPrice": 99.99, "initialBuyers": 10, "tiers": [...] },
  "referralsNeeded": 2,
  "countdownEnd": "2025-03-01T23:59:00Z"
}
```

## How to Use the New Admin Interface

### 1. Access the Admin Page
```
http://localhost:8080/admin.html
```

### 2. Select a Campaign
- Use the dropdown to select an existing campaign
- All fields will auto-populate with that campaign's data

### 3. Create a New Campaign
- Click "+ New Campaign" button
- Enter product name and optional video URL
- A new campaign will be created with default values
- You'll be redirected to edit the new campaign

### 4. Edit Campaign Settings
- **Product**: Image URL, Name, Description (HTML supported)
- **Video**: m3u8 URL for the video player
- **Twilio SMS**: Enable/disable SMS, configure credentials
- **Pricing**: Initial price, initial buyers count, price tiers
- **Referrals**: Number of referrals needed to unlock best price
- **Countdown**: End date/time for the campaign

### 5. Save Changes
- Click "💾 Save Changes" to persist to campaigns.json
- Changes are immediately live on the landing page

### 6. Direct URL Access
- Open `admin.html?v=CAMPAIGN_ID` to directly edit a campaign
- Example: `http://localhost:8080/admin.html?v=005EZsfHkpI`

## File Structure

```
group-buying/
├── data/
│   └── campaigns.json       # All campaigns with new structure
├── admin.html              # Updated with campaign selector
├── admin.js                # Multi-campaign management logic
├── admin.css               # Styles for new UI elements
├── server.js               # New PUT/DELETE endpoints
├── campaign-loader.js      # Reads new campaign structure
├── app.js                  # Uses campaign-specific settings
└── generate-campaign-id.js # Creates campaigns with all fields
```

## Backward Compatibility

- Legacy fields are maintained in campaigns.json for existing code
- Landing pages work with both old and new campaign structures
- Existing campaigns are automatically compatible
