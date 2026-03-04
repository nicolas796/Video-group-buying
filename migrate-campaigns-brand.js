#!/usr/bin/env node

const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const CAMPAIGNS_FILE = path.join(DATA_DIR, 'campaigns.json');
const DEFAULT_BRAND_ID = 'brand_001';

async function migrateCampaigns() {
  console.log(`Migrating campaigns file: ${CAMPAIGNS_FILE}`);
  const raw = await fs.readFile(CAMPAIGNS_FILE, 'utf8');
  const campaigns = JSON.parse(raw);
  let updatedCount = 0;
  const total = Object.keys(campaigns).length;

  for (const campaignId of Object.keys(campaigns)) {
    const campaign = campaigns[campaignId];
    if (campaign.brand_id !== DEFAULT_BRAND_ID) {
      if (campaign.brand_id && campaign.brand_id !== DEFAULT_BRAND_ID) {
        console.warn(`Overwriting brand_id for campaign ${campaignId} (was ${campaign.brand_id})`);
      }
      campaign.brand_id = DEFAULT_BRAND_ID;
      updatedCount += 1;
    }
  }

  const tmpPath = `${CAMPAIGNS_FILE}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmpPath, JSON.stringify(campaigns, null, 2));
  await fs.rename(tmpPath, CAMPAIGNS_FILE);

  console.log(`Migrated ${updatedCount} campaign(s) to ${DEFAULT_BRAND_ID} (out of ${total})`);
}

migrateCampaigns().catch((error) => {
  console.error('Campaign migration failed:', error);
  process.exit(1);
});
