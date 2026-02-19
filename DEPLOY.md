# Deploy to Render

This guide walks you through deploying the Group Buying app on Render.

## Option 1: Deploy with Render Blueprint (Recommended)

1. **Push to GitHub**
   ```bash
   # Create a new repo on GitHub (don't initialize with README)
   # Then push:
   git remote add origin https://github.com/YOUR_USERNAME/estreamly-group-buying.git
   git branch -M main
   git push -u origin main
   ```

2. **Deploy on Render**
   - Go to [render.com](https://render.com) and sign in
   - Click **"New +"** → **"Blueprint"**
   - Connect your GitHub account and select the repo
   - Render will read `render.yaml` and configure everything automatically
   - Click **"Apply"**

3. **Done!** Your app will be live at `https://estreamly-group-buying.onrender.com`

## Option 2: Manual Deploy

1. **Push to GitHub** (same as above)

2. **Create Web Service on Render**
   - Go to [render.com](https://render.com)
   - Click **"New +"** → **"Web Service"**
   - Connect your GitHub repo
   - Configure:
     - **Name**: `estreamly-group-buying`
     - **Runtime**: Node
     - **Build Command**: `npm install`
     - **Start Command**: `npm start`
   - Click **"Create Web Service"**

3. **Add Disk (for persistent data)**
   - In your service dashboard, go to **"Disks"**
   - Click **"Add Disk"**
   - **Name**: `data`
   - **Mount Path**: `/opt/render/project/src/data`
   - **Size**: 1 GB
   - Save

## Post-Deploy Setup

### 1. Update Your Domain

Go to `data/config.json` in the admin panel and set:
```json
{
  "domain": "https://estreamly-group-buying.onrender.com"
}
```

This ensures referral links in SMS messages point to your live site.

### 2. Configure Twilio (Optional)

For SMS notifications:

1. In admin panel (`/admin.html`), fill in:
   - Account SID
   - Auth Token  
   - Twilio Phone Number
   - Enable SMS checkbox

2. In Twilio console, set webhook URL:
   ```
   https://estreamly-group-buying.onrender.com/api/sms/webhook
   ```

### 3. Customize Your Drop

Visit `/admin.html` on your live site to configure:
- Product details
- Video URL
- Pricing tiers
- Countdown end time
- Initial buyer count

## Environment Variables

If needed, set these in Render dashboard → Environment:

| Variable | Description |
|----------|-------------|
| `NODE_ENV` | Set to `production` |
| `PORT` | Render sets this automatically (usually 10000) |

## Troubleshooting

### Data not persisting?
Make sure the disk is mounted at `/opt/render/project/src/data`

### SMS not sending?
- Check Twilio credentials in admin panel
- Verify phone number has SMS capability
- Check optouts.json for blocked numbers

### Video not playing?
- Ensure m3u8 URL is publicly accessible
- Check CORS headers on video server

## Files Structure

```
group-buying/
├── data/              # Persistent data (disk mounted here)
│   ├── config.json    # All settings
│   ├── participants.json
│   └── optouts.json
├── index.html         # Main drop page
├── admin.html         # Admin panel
├── server.js          # Node.js server
├── render.yaml        # Render config
└── package.json
```

## Free Tier Limits

Render free tier:
- 512 MB RAM
- Spins down after 15 min inactivity (takes ~30s to wake up)
- 1 GB disk (included)

For production, consider upgrading to avoid spin-down.

## Support

- Render docs: [render.com/docs](https://render.com/docs)
- Twilio docs: [twilio.com/docs](https://twilio.com/docs)
