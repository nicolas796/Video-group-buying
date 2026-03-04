const fs = require('fs');
const path = require('path');

const { validateBrandRecord, validateUserRecord, validateCampaignRecord, DataValidationError, resolveCampaignName } = require('./schemas');
const { createBackupAsync } = require('./backup-manager');

const fsp = fs.promises;
const DATA_DIR = path.join(__dirname, 'data');
const cache = new Map();
const CACHE_TTL = {
  brands: 60000,
  users: 30000,
};

function tmpFilePath(targetPath) {
  return `${targetPath}.${process.pid}.${Date.now()}.tmp`;
}

async function ensureDirectory(filePath) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
}

async function atomicWriteJson(filePath, data) {
  await ensureDirectory(filePath);
  await createBackupAsync(filePath);
  const payload = JSON.stringify(data, null, 2);
  const tempPath = tmpFilePath(filePath);
  await fsp.writeFile(tempPath, payload, 'utf8');
  await fsp.rename(tempPath, filePath);
}

async function ensureFile(filePath, defaultValue) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
  } catch {
    await atomicWriteJson(filePath, defaultValue);
  }
}

async function readJson(fileName, defaultValue) {
  const filePath = path.join(DATA_DIR, fileName);
  await ensureFile(filePath, defaultValue);
  const raw = await fsp.readFile(filePath, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (error) {
    error.message = `Failed to parse ${filePath}: ${error.message}`;
    throw error;
  }
}

async function writeJson(fileName, data) {
  const filePath = path.join(DATA_DIR, fileName);
  await atomicWriteJson(filePath, data);
}

function arrayFromContainer(container, key) {
  if (Array.isArray(container)) return container;
  if (container && typeof container === 'object' && Array.isArray(container[key])) {
    return container[key];
  }
  return [];
}

function wrapArray(container, key, values) {
  if (Array.isArray(container)) {
    return values;
  }
  if (container && typeof container === 'object') {
    return { ...container, [key]: values };
  }
  return { [key]: values };
}

function extractCampaignArray(container) {
  if (Array.isArray(container)) {
    return container;
  }
  if (container && typeof container === 'object') {
    if (Array.isArray(container.campaigns)) {
      return container.campaigns;
    }
    return Object.values(container);
  }
  return [];
}

function wrapCampaignContainer(container, records) {
  if (Array.isArray(container)) {
    return records;
  }
  if (container && typeof container === 'object') {
    if (Array.isArray(container.campaigns)) {
      return { ...container, campaigns: records };
    }
    return records.reduce((acc, record) => {
      if (record && record.id) {
        acc[record.id] = record;
      }
      return acc;
    }, {});
  }
  return { campaigns: records };
}

function logValidation(fileName, identifier, messages = [], level = 'warn') {
  if (!messages.length) return;
  const prefix = `[Data Validation] ${fileName}${identifier ? `:${identifier}` : ''}`;
  messages.forEach(message => {
    if (level === 'error') {
      console.error(`${prefix} ${message}`);
    } else {
      console.warn(`${prefix} ${message}`);
    }
  });
}

function collectBrandIds(brandsContainer) {
  const brands = arrayFromContainer(brandsContainer, 'brands');
  return new Set(brands.map(item => item?.id).filter(Boolean));
}

async function getCached(key, loader, ttl) {
  if (typeof loader !== 'function') {
    throw new TypeError('loader must be a function');
  }
  if (typeof ttl !== 'number' || ttl <= 0) {
    return loader();
  }
  const cached = cache.get(key);
  if (cached && (Date.now() - cached.time) < ttl) {
    return cached.data;
  }
  const data = await loader();
  cache.set(key, { data, time: Date.now() });
  return data;
}

function invalidateCache(key) {
  cache.delete(key);
}

async function loadBrands() {
  return getCached('brands', async () => {
    const data = await readJson('brands.json', { brands: [] });
    const source = arrayFromContainer(data, 'brands');
    const seen = new Set();
    const sanitized = [];

    source.forEach(entry => {
      const result = validateBrandRecord(entry || {});
      const identifier = entry?.id || entry?.name || 'unknown';
      if (!result.valid) {
        logValidation('brands.json', identifier, result.errors, 'error');
        return;
      }
      if (result.warnings.length) {
        logValidation('brands.json', identifier, result.warnings, 'warn');
      }
      if (seen.has(result.value.id)) {
        logValidation('brands.json', identifier, ['duplicate brand id skipped'], 'warn');
        return;
      }
      seen.add(result.value.id);
      sanitized.push(result.value);
    });

    return wrapArray(data, 'brands', sanitized);
  }, CACHE_TTL.brands);
}

async function saveBrands(data) {
  const source = arrayFromContainer(data, 'brands');
  const seen = new Set();
  const sanitized = [];
  const errors = [];

  source.forEach(entry => {
    const result = validateBrandRecord(entry || {});
    const identifier = entry?.id || entry?.name || 'unknown';
    if (!result.valid) {
      result.errors.forEach(err => errors.push(`${identifier}: ${err}`));
      return;
    }
    if (seen.has(result.value.id)) {
      errors.push(`${identifier}: duplicate brand id`);
      return;
    }
    seen.add(result.value.id);
    sanitized.push(result.value);
  });

  if (errors.length) {
    throw new DataValidationError('Invalid brand data', errors);
  }

  const payload = wrapArray(data, 'brands', sanitized);
  await writeJson('brands.json', payload);
  invalidateCache('brands');
  return payload;
}

async function loadUsers() {
  return getCached('users', async () => {
    const data = await readJson('users.json', { users: [] });
    const source = arrayFromContainer(data, 'users');
    const brandsContainer = await loadBrands();
    const brandIds = collectBrandIds(brandsContainer);
    const sanitized = [];

    source.forEach(entry => {
      const result = validateUserRecord(entry || {}, { brandIds, strictBrandCheck: false });
      const identifier = entry?.id || entry?.email || 'unknown';
      if (!result.valid) {
        logValidation('users.json', identifier, result.errors, 'error');
        return;
      }
      if (result.warnings.length) {
        logValidation('users.json', identifier, result.warnings, 'warn');
      }
      sanitized.push(result.value);
    });

    return wrapArray(data, 'users', sanitized);
  }, CACHE_TTL.users);
}

async function saveUsers(data) {
  const source = arrayFromContainer(data, 'users');
  const brandsContainer = await loadBrands();
  const brandIds = collectBrandIds(brandsContainer);
  const sanitized = [];
  const errors = [];

  source.forEach(entry => {
    const result = validateUserRecord(entry || {}, { brandIds, strictBrandCheck: true });
    const identifier = entry?.id || entry?.email || 'unknown';
    if (!result.valid) {
      result.errors.forEach(err => errors.push(`${identifier}: ${err}`));
      return;
    }
    sanitized.push(result.value);
  });

  if (errors.length) {
    throw new DataValidationError('Invalid user data', errors);
  }

  const payload = wrapArray(data, 'users', sanitized);
  await writeJson('users.json', payload);
  invalidateCache('users');
  return payload;
}

async function loadCampaigns() {
  const data = await readJson('campaigns.json', {});
  const source = extractCampaignArray(data);
  const brandsContainer = await loadBrands();
  const brandIds = collectBrandIds(brandsContainer);
  const sanitized = [];

  source.forEach(entry => {
    const result = validateCampaignRecord(entry || {}, { brandIds, strictBrandCheck: false });
    const identifier = entry?.id || resolveCampaignName(entry) || 'unknown';
    if (!result.valid) {
      logValidation('campaigns.json', identifier, result.errors, 'error');
      return;
    }
    if (result.warnings.length) {
      logValidation('campaigns.json', identifier, result.warnings, 'warn');
    }
    sanitized.push(result.value);
  });

  return wrapCampaignContainer(data, sanitized);
}

async function saveCampaigns(data) {
  const source = extractCampaignArray(data);
  const brandsContainer = await loadBrands();
  const brandIds = collectBrandIds(brandsContainer);
  const sanitized = [];
  const errors = [];

  source.forEach(entry => {
    const result = validateCampaignRecord(entry || {}, { brandIds, strictBrandCheck: true });
    const identifier = entry?.id || resolveCampaignName(entry) || 'unknown';
    if (!result.valid) {
      result.errors.forEach(err => errors.push(`${identifier}: ${err}`));
      return;
    }
    sanitized.push(result.value);
  });

  if (errors.length) {
    throw new DataValidationError('Invalid campaign data', errors);
  }

  const payload = wrapCampaignContainer(data, sanitized);
  await writeJson('campaigns.json', payload);
  return payload;
}

module.exports = {
  loadBrands,
  saveBrands,
  loadUsers,
  saveUsers,
  loadCampaigns,
  saveCampaigns,
};
