#!/usr/bin/env node

/**
 * Campaign ID Generator
 * Generates new campaign IDs and creates campaigns with full configuration
 * 
 * Usage:
 *   node generate-campaign-id.js
 *   node generate-campaign-id.js --count=5
 *   node generate-campaign-id.js --create --name="My Product" --video="https://..."
 *   node generate-campaign-id.js --create-full --config=./campaign-config.json
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');

function generateCampaignId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const length = 11;
    let result = '';
    const randomBytes = crypto.randomBytes(length);
    for (let i = 0; i < length; i++) {
        result += chars[randomBytes[i] % chars.length];
    }
    return result;
}

function generateMultipleIds(count = 1) {
    const ids = new Set();
    while (ids.size < count) ids.add(generateCampaignId());
    return Array.from(ids);
}

function campaignExists(id) {
    if (!fs.existsSync(CAMPAIGNS_FILE)) return false;
    try { return !!JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8'))[id]; } catch (e) { return false; }
}

function generateUniqueCampaignId() {
    let id;
    do { id = generateCampaignId(); } while (campaignExists(id));
    return id;
}

function createCampaignTemplate(name, videoUrl, options = {}) {
    const endDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const initialPrice = options.initialPrice || 80;
    const tiers = options.tiers || [{ buyers: 100, price: 40 }, { buyers: 500, price: 30 }, { buyers: 1000, price: 20 }];
    
    return {
        // New structure
        id: options.id || generateUniqueCampaignId(),
        productName: name || 'New Product',
        productImage: options.productImage || options.imageUrl || '',
        productDescription: options.productDescription || options.description || '<h4>Product Details</h4><p>Description coming soon...</p>',
        videoUrl: videoUrl || '',
        twilio: {
            enabled: options.twilio?.enabled || false,
            accountSid: options.twilio?.accountSid || '',
            authToken: options.twilio?.authToken || '',
            phoneNumber: options.twilio?.phoneNumber || '',
            domain: options.twilio?.domain || options.domain || 'https://your-domain.com'
        },
        pricing: {
            initialPrice: initialPrice,
            initialBuyers: options.initialBuyers || options.pricing?.initialBuyers || 100,
            tiers: options.pricing?.tiers || tiers
        },
        referralsNeeded: options.referralsNeeded || options.sharesRequired || 2,
        countdownEnd: options.countdownEnd || endDate.toISOString(),
        // Legacy fields for backward compatibility
        description: options.productDescription || options.description || '<h4>Product Details</h4><p>Description coming soon...</p>',
        price: options.pricing?.tiers ? Math.min(...options.pricing.tiers.map(t => t.price)) : 20,
        originalPrice: initialPrice,
        imageUrl: options.productImage || options.imageUrl || '',
        sharesRequired: options.referralsNeeded || options.sharesRequired || 2,
        discountPercentage: options.discountPercentage || Math.round(((initialPrice - (tiers[tiers.length - 1]?.price || 20)) / initialPrice) * 100),
        merchantName: options.merchantName || '',
        merchantLogo: options.merchantLogo || '',
        initialBuyers: options.initialBuyers || options.pricing?.initialBuyers || 100,
        priceTiers: options.pricing?.tiers || tiers
    };
}

function addCampaign(campaignData) {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    let campaigns = {};
    if (fs.existsSync(CAMPAIGNS_FILE)) {
        try { campaigns = JSON.parse(fs.readFileSync(CAMPAIGNS_FILE, 'utf8')); } catch (e) { console.error('Error reading campaigns:', e.message); }
    }
    const id = campaignData.id || generateUniqueCampaignId();
    campaigns[id] = { ...campaignData, id };
    fs.writeFileSync(CAMPAIGNS_FILE, JSON.stringify(campaigns, null, 2));
    return id;
}

function parseArgs() {
    const args = process.argv.slice(2);
    const options = { count: 1, create: false, createFull: false, name: '', video: '', config: '', help: false };
    args.forEach(arg => {
        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--create' || arg === '-c') options.create = true;
        else if (arg === '--create-full') options.createFull = true;
        else if (arg.startsWith('--count=')) options.count = parseInt(arg.split('=')[1]) || 1;
        else if (arg.startsWith('--name=')) options.name = arg.split('=')[1];
        else if (arg.startsWith('--video=')) options.video = arg.split('=')[1];
        else if (arg.startsWith('--config=')) options.config = arg.split('=')[1];
    });
    return options;
}

function showHelp() {
    console.log(`
Campaign ID Generator
=====================

Usage:
  node generate-campaign-id.js [options]

Options:
  --help, -h          Show this help message
  --count=N           Generate N campaign IDs (default: 1)
  --create, -c        Create a new campaign with basic template
  --create-full       Create a new campaign from JSON config file
  --name="Product"    Product name (with --create)
  --video="URL"       Video URL (with --create)
  --config="path"     Path to JSON config file (with --create-full)

Examples:
  # Generate 5 campaign IDs
  node generate-campaign-id.js --count=5

  # Create a new campaign (basic)
  node generate-campaign-id.js --create --name="My Product" --video="https://example.com/video.m3u8"

  # Create from config file
  node generate-campaign-id.js --create-full --config=./my-campaign.json

Config file format for --create-full:
{
  "productName": "My Product",
  "productImage": "https://...",
  "productDescription": "<h4>Details</h4><p>...</p>",
  "videoUrl": "https://.../video.m3u8",
  "twilio": {
    "enabled": true,
    "accountSid": "AC...",
    "authToken": "...",
    "phoneNumber": "+1234567890",
    "domain": "https://my-domain.com"
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
  "countdownEnd": "2025-03-01T23:59:00Z"
}
`);
}

function main() {
    const options = parseArgs();
    if (options.help) { showHelp(); return; }
    
    if (options.createFull) {
        if (!options.config) { console.error('Error: --config required with --create-full'); process.exit(1); }
        if (!fs.existsSync(options.config)) { console.error(`Error: Config file not found: ${options.config}`); process.exit(1); }
        try {
            const configData = JSON.parse(fs.readFileSync(options.config, 'utf8'));
            const campaignData = createCampaignTemplate(configData.productName, configData.videoUrl, configData);
            const id = addCampaign(campaignData);
            console.log('\n✅ Campaign created from config!');
            console.log('========================');
            console.log(`Campaign ID: ${id}`);
            console.log(`Landing page: http://localhost:8080/?v=${id}`);
            console.log(`Admin page: http://localhost:8080/admin.html?v=${id}`);
            console.log('========================\n');
        } catch (e) { console.error('Error reading config file:', e.message); process.exit(1); }
    } else if (options.create) {
        const campaignData = createCampaignTemplate(options.name, options.video);
        const id = addCampaign(campaignData);
        console.log('\n✅ New campaign created!');
        console.log('========================');
        console.log(`Campaign ID: ${id}`);
        console.log(`Landing page: http://localhost:8080/?v=${id}`);
        console.log(`Admin page: http://localhost:8080/admin.html?v=${id}`);
        console.log('========================\n');
        console.log('Edit the campaign in admin.html or data/campaigns.json');
    } else {
        const ids = generateMultipleIds(options.count);
        if (options.count === 1) {
            console.log('\n🆔 Generated Campaign ID:');
            console.log('========================');
            console.log(ids[0]);
            console.log('========================\n');
        } else {
            console.log('\n🆔 Generated Campaign IDs:');
            console.log('========================');
            ids.forEach((id, i) => console.log(`${i + 1}. ${id}`));
            console.log('========================\n');
        }
        const existing = ids.filter(campaignExists);
        if (existing.length > 0) console.log(`⚠️  Note: ${existing.length} ID(s) already exist`);
    }
}

module.exports = {
    generateCampaignId,
    generateMultipleIds,
    generateUniqueCampaignId,
    createCampaignTemplate,
    addCampaign,
    campaignExists
};

if (require.main === module) main();
