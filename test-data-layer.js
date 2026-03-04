#!/usr/bin/env node

const {
  loadBrands,
  loadUsers,
  loadCampaigns,
} = require('./data-store');

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function toBrandList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.brands)) return payload.brands;
  if (Array.isArray(payload)) return payload;
  return [];
}

function toCampaignList(payload) {
  if (!payload) return [];
  if (Array.isArray(payload.campaigns)) return payload.campaigns;
  if (Array.isArray(payload)) return payload;
  if (typeof payload === 'object') return Object.values(payload);
  return [];
}

async function run() {
  const brandsData = await loadBrands();
  const brands = toBrandList(brandsData);
  assert(Array.isArray(brands), 'brands.json is missing the "brands" array');
  assert(brands.length > 0, 'brands.json has no brands defined');
  const invalidBrands = brands.filter(brand => !brand?.id || typeof brand.id !== 'string');
  assert(invalidBrands.length === 0, 'Each brand must include a string id');
  const brandIds = new Set(brands.map(brand => brand.id));

  const usersData = await loadUsers();
  assert(Array.isArray(usersData.users), 'users.json is missing the "users" array');
  assert(usersData.users.length > 0, 'users.json has no users defined');
  const adminUser = usersData.users.find((user) => user.is_super_admin);
  assert(adminUser, 'No super admin user found in users.json');
  assert(
    typeof adminUser.password_hash === 'string' && adminUser.password_hash.startsWith('$2b$'),
    'Super admin user does not have a bcrypt hash'
  );

  const campaignsData = await loadCampaigns();
  const campaigns = toCampaignList(campaignsData);
  assert(campaigns.length > 0, 'No campaigns found to verify');
  const campaignsMissingBrand = campaigns.filter((campaign) => {
    const brandId = campaign?.brand_id || campaign?.brandId || null;
    return !brandId || !brandIds.has(brandId);
  });
  assert(
    campaignsMissingBrand.length === 0,
    `Found ${campaignsMissingBrand.length} campaign(s) without a valid brand assignment`
  );

  console.log('[PASS] Data layer verified:', {
    brandCount: brands.length,
    userCount: usersData.users.length,
    campaignCount: campaigns.length,
    brandIds: Array.from(brandIds)
  });
}

run().catch((error) => {
  console.error('[FAIL] Data layer verification failed:', error.message);
  process.exit(1);
});
