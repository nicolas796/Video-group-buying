let currentUser = null;
let isSuperAdmin = false;
let currentCampaignId = null;
let currentCampaign = null;
let allCampaigns = {};
let tiers = [];
let brandList = [];
let usersList = [];
let campaignsTableData = [];
let brandFilterValue = 'all';
const campaignDetailsCache = new Map();
const CAMPAIGN_PAGE_LIMIT = 100;
const MAX_CAMPAIGN_PAGE_REQUESTS = 25;
const STORAGE_KEYS = {
    token: 'adminToken',
    brand: 'adminBrandId',
    superAdmin: 'adminIsSuperAdmin'
};
const TAB_IDS = ['campaigns', 'brands', 'users'];
const brandModalState = { mode: 'create', brandId: null };
const userModalState = { mode: 'create', userId: null };

// Load UI after DOM ready
document.addEventListener('DOMContentLoaded', init);

async function init() {
    await loadCurrentUser();
    setupHeader();
    setupTabNavigation();
    bindModalEvents();
    bindFormEvents();

    if (isSuperAdmin) {
        document.getElementById('admin-tabs')?.classList.remove('hidden');
        await loadBrands();
        await loadUsers();
    } else {
        document.getElementById('admin-tabs')?.classList.add('hidden');
        document.getElementById('tab-brands')?.classList.add('hidden');
        document.getElementById('tab-users')?.classList.add('hidden');
    }

    await loadCampaignsList();
    applyInitialCampaignSelection();
}

async function loadCurrentUser() {
    try {
        const response = await fetch('/api/me', { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error('Unauthorized');
        }
        const payload = await response.json();
        currentUser = payload?.user || null;
        isSuperAdmin = Boolean(currentUser?.isSuperAdmin);
    } catch (error) {
        console.error('Failed to load current user:', error);
        localStorage.removeItem(STORAGE_KEYS.token);
        window.location.href = 'login.html';
    }
}

function setupHeader() {
    const emailEl = document.getElementById('current-user-email');
    const brandEl = document.getElementById('current-user-brand');
    const badge = document.getElementById('super-admin-badge');

    const email = currentUser?.email || currentUser?.username || 'Unknown user';
    const brandName = currentUser?.brand?.name || 'Unassigned';

    if (emailEl) emailEl.textContent = email;
    if (brandEl) brandEl.textContent = `Brand: ${brandName}`;
    if (badge) {
        if (isSuperAdmin) badge.classList.remove('hidden');
        else badge.classList.add('hidden');
    }
}

function setupTabNavigation() {
    const tabNav = document.getElementById('admin-tabs');
    if (!tabNav) return;
    tabNav.querySelectorAll('button[data-tab]').forEach(button => {
        button.addEventListener('click', () => setActiveTab(button.dataset.tab));
    });
}

function setActiveTab(target) {
    if (!isSuperAdmin && target !== 'campaigns') {
        return;
    }
    TAB_IDS.forEach(tabId => {
        const button = document.querySelector(`#admin-tabs button[data-tab="${tabId}"]`);
        const panel = document.getElementById(`tab-${tabId}`);
        if (!button || !panel) return;
        if (tabId === target) {
            button.classList.add('active');
            panel.classList.add('active');
        } else {
            button.classList.remove('active');
            panel.classList.remove('active');
        }
    });
}

function bindModalEvents() {
    document.querySelectorAll('[data-close-modal]').forEach(btn => {
        btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
    });

    ['participants-modal', 'brand-modal', 'user-modal'].forEach(id => {
        const modal = document.getElementById(id);
        if (!modal) return;
        modal.addEventListener('click', event => {
            if (event.target === modal) {
                closeModal(id);
            }
        });
    });
}

function bindFormEvents() {
    const adminForm = document.getElementById('admin-form');
    if (adminForm) {
        adminForm.addEventListener('submit', saveCampaign);
    }

    const brandForm = document.getElementById('brand-form');
    if (brandForm) {
        brandForm.addEventListener('submit', handleBrandSubmit);
    }

    const userForm = document.getElementById('user-form');
    if (userForm) {
        userForm.addEventListener('submit', handleUserSubmit);
    }

    const brandFilter = document.getElementById('brand-filter');
    if (brandFilter) {
        brandFilter.addEventListener('change', event => {
            brandFilterValue = event.target.value || 'all';
            renderCampaignTable();
        });
    }

    const createBrandBtn = document.getElementById('create-brand-btn');
    if (createBrandBtn) {
        createBrandBtn.addEventListener('click', () => openBrandModal('create'));
    }

    const createUserBtn = document.getElementById('create-user-btn');
    if (createUserBtn) {
        createUserBtn.addEventListener('click', () => openUserModal('create'));
    }
}

async function loadBrands() {
    if (!isSuperAdmin) return;
    try {
        const response = await fetch('/api/brands', { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error('Failed to load brands');
        }
        const data = await response.json();
        brandList = data?.brands || [];
        renderBrandTable();
        populateBrandFilter();
        populateUserBrandDropdown();
    } catch (error) {
        console.error('Error loading brands:', error);
        showToast('Failed to load brands', 'error');
    }
}

function renderBrandTable() {
    const tbody = document.querySelector('#brands-table tbody');
    if (!tbody) return;
    if (!brandList.length) {
        tbody.innerHTML = '<tr><td colspan="4">No brands found yet.</td></tr>';
        return;
    }
    tbody.innerHTML = brandList
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(brand => {
            const date = brand.created_at ? new Date(brand.created_at).toLocaleDateString() : '—';
            const disableDelete = brand.campaign_count > 0;
            const deleteTitle = disableDelete ? 'Cannot delete brand with active campaigns' : 'Delete brand';
            return `
                <tr>
                    <td>${brand.name}</td>
                    <td>${date}</td>
                    <td>
                        ${brand.campaign_count || 0}
                        ${brand.campaign_count > 0 ? '<span class="status-tag" style="margin-left:8px;">Active</span>' : ''}
                    </td>
                    <td>
                        <button type="button" class="btn-link" onclick="openBrandModal('edit', '${brand.id}')">Edit</button>
                        <span style="margin: 0 6px; color: #d1d5db;">|</span>
                        <button type="button" class="btn-link" title="${deleteTitle}" ${disableDelete ? 'disabled' : ''} onclick="deleteBrand('${brand.id}')">Delete</button>
                    </td>
                </tr>`;
        })
        .join('');
}

function populateBrandFilter() {
    const wrapper = document.getElementById('brand-filter-wrapper');
    const select = document.getElementById('brand-filter');
    if (!wrapper || !select) return;

    if (!isSuperAdmin || !brandList.length) {
        wrapper.classList.add('hidden');
        brandFilterValue = 'all';
        return;
    }

    wrapper.classList.remove('hidden');
    const options = ['<option value="all">All Brands</option>'];
    brandList
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(brand => {
            const selected = brand.id === brandFilterValue ? 'selected' : '';
            options.push(`<option value="${brand.id}" ${selected}>${brand.name}</option>`);
        });
    select.innerHTML = options.join('');
}

function populateUserBrandDropdown() {
    const select = document.getElementById('user-brand-select');
    if (!select) return;
    if (!brandList.length) {
        select.innerHTML = '<option value="">No brands available</option>';
        select.disabled = true;
        return;
    }
    select.disabled = false;
    select.innerHTML = [
        '<option value="">Select a brand</option>',
        ...brandList
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(brand => `<option value="${brand.id}">${brand.name}</option>`)
    ].join('');
}

function openBrandModal(mode, brandId = null) {
    brandModalState.mode = mode;
    brandModalState.brandId = brandId;
    const modal = document.getElementById('brand-modal');
    const title = document.getElementById('brand-modal-title');
    const input = document.getElementById('brand-name-input');
    const submitBtn = document.getElementById('brand-form-submit');

    if (!modal || !title || !input || !submitBtn) return;

    if (mode === 'edit' && brandId) {
        const brand = brandList.find(b => b.id === brandId);
        if (!brand) {
            showToast('Brand not found', 'error');
            return;
        }
        title.textContent = 'Rename Brand';
        input.value = brand.name;
        submitBtn.textContent = 'Update Brand';
    } else {
        title.textContent = 'Create Brand';
        input.value = '';
        submitBtn.textContent = 'Save Brand';
    }

    modal.classList.remove('hidden');
}

function closeModal(id) {
    const modal = document.getElementById(id);
    if (!modal) return;
    modal.classList.add('hidden');
}

async function handleBrandSubmit(event) {
    event.preventDefault();
    if (!isSuperAdmin) {
        showToast('Only super admins can manage brands', 'error');
        return;
    }
    const nameInput = document.getElementById('brand-name-input');
    const name = nameInput?.value?.trim();
    if (!name) {
        showToast('Brand name is required', 'error');
        return;
    }

    const csrfToken = await getCsrfToken();
    const payload = { name, csrfToken };
    const options = {
        method: brandModalState.mode === 'edit' ? 'PUT' : 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken || ''
        },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    };
    const url = brandModalState.mode === 'edit'
        ? `/api/brands/${brandModalState.brandId}`
        : '/api/brands';

    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error || 'Failed to save brand');
        }
        showToast('Brand saved', 'success');
        closeModal('brand-modal');
        await loadBrands();
        await loadCampaignsList();
    } catch (error) {
        console.error('Brand save error:', error);
        showToast(error.message, 'error');
    }
}

async function deleteBrand(brandId) {
    if (!isSuperAdmin) {
        showToast('Only super admins can delete brands', 'error');
        return;
    }
    const brand = brandList.find(b => b.id === brandId);
    if (!brand) {
        showToast('Brand not found', 'error');
        return;
    }
    if (brand.campaign_count > 0) {
        showToast('Cannot delete brand with campaigns', 'error');
        return;
    }
    if (!confirm(`Delete brand "${brand.name}"? This cannot be undone.`)) {
        return;
    }
    try {
        const csrfToken = await getCsrfToken();
        const response = await fetch(`/api/brands/${brandId}`, {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: { 'X-CSRF-Token': csrfToken || '' }
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error || 'Failed to delete brand');
        }
        showToast('Brand deleted', 'success');
        await loadBrands();
        await loadCampaignsList();
    } catch (error) {
        console.error('Delete brand error:', error);
        showToast(error.message, 'error');
    }
}

async function loadUsers() {
    if (!isSuperAdmin) return;
    try {
        const response = await fetch('/api/users', { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error('Failed to load users');
        }
        const data = await response.json();
        usersList = data?.users || [];
        renderUserTable();
    } catch (error) {
        console.error('Users load error:', error);
        showToast('Failed to load users', 'error');
    }
}

function renderUserTable() {
    const tbody = document.querySelector('#users-table tbody');
    if (!tbody) return;
    if (!usersList.length) {
        tbody.innerHTML = '<tr><td colspan="5">No users found.</td></tr>';
        return;
    }
    const brandMap = new Map(brandList.map(brand => [brand.id, brand.name]));
    tbody.innerHTML = usersList
        .sort((a, b) => a.email.localeCompare(b.email))
        .map(user => {
            const created = user.created_at ? new Date(user.created_at).toLocaleDateString() : '—';
            const brandName = brandMap.get(user.brand_id) || 'Unassigned';
            const badge = user.is_super_admin ? '<span class="badge badge-super">Yes</span>' : '<span class="badge badge-muted">No</span>';
            return `
                <tr>
                    <td>${user.email}</td>
                    <td>${brandName}</td>
                    <td>${badge}</td>
                    <td>${created}</td>
                    <td>
                        <button type="button" class="btn-link" onclick="openUserModal('edit', '${user.id}')">Edit</button>
                        <span style="margin: 0 6px; color: #d1d5db;">|</span>
                        <button type="button" class="btn-link" onclick="deleteUser('${user.id}')">Delete</button>
                    </td>
                </tr>`;
        })
        .join('');
}

function openUserModal(mode, userId = null) {
    if (!isSuperAdmin) {
        showToast('Only super admins can manage users', 'error');
        return;
    }
    userModalState.mode = mode;
    userModalState.userId = userId;

    const modal = document.getElementById('user-modal');
    const title = document.getElementById('user-modal-title');
    const emailInput = document.getElementById('user-email-input');
    const passwordGroup = document.getElementById('user-password-group');
    const passwordInput = document.getElementById('user-password-input');
    const brandSelect = document.getElementById('user-brand-select');
    const superCheckbox = document.getElementById('user-super-admin-checkbox');
    const submitBtn = document.getElementById('user-form-submit');

    if (!modal || !title || !emailInput || !passwordGroup || !passwordInput || !brandSelect || !superCheckbox || !submitBtn) return;

    passwordInput.value = '';

    if (mode === 'edit' && userId) {
        const user = usersList.find(u => u.id === userId);
        if (!user) {
            showToast('User not found', 'error');
            return;
        }
        title.textContent = 'Edit User';
        emailInput.value = user.email;
        emailInput.disabled = true;
        passwordGroup.style.display = 'none';
        brandSelect.value = user.brand_id || '';
        superCheckbox.checked = Boolean(user.is_super_admin);
        submitBtn.textContent = 'Update User';
    } else {
        title.textContent = 'Create User';
        emailInput.value = '';
        emailInput.disabled = false;
        passwordGroup.style.display = 'block';
        brandSelect.value = '';
        superCheckbox.checked = false;
        submitBtn.textContent = 'Create User';
    }

    modal.classList.remove('hidden');
}

async function handleUserSubmit(event) {
    event.preventDefault();
    if (!isSuperAdmin) {
        showToast('Only super admins can manage users', 'error');
        return;
    }

    const emailInput = document.getElementById('user-email-input');
    const passwordInput = document.getElementById('user-password-input');
    const brandSelect = document.getElementById('user-brand-select');
    const superCheckbox = document.getElementById('user-super-admin-checkbox');

    const isCreate = userModalState.mode === 'create';
    const email = emailInput?.value?.trim().toLowerCase();
    const password = passwordInput?.value || '';
    const brandId = brandSelect?.value || '';
    const isSuper = Boolean(superCheckbox?.checked);

    if (!email) {
        showToast('Email is required', 'error');
        return;
    }
    if (!brandId && !isSuper) {
        showToast('Brand selection is required', 'error');
        return;
    }
    if (isCreate && password.length < 6) {
        showToast('Password must be at least 6 characters', 'error');
        return;
    }

    const csrfToken = await getCsrfToken();
    const payload = {
        email,
        brand_id: brandId || null,
        is_super_admin: isSuper,
        csrfToken
    };
    if (isCreate) {
        payload.password = password;
    }

    const url = isCreate ? '/api/users' : `/api/users/${userModalState.userId}`;
    const options = {
        method: isCreate ? 'POST' : 'PUT',
        headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken || ''
        },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
    };

    try {
        const response = await fetch(url, options);
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error || 'Failed to save user');
        }
        showToast('User saved', 'success');
        closeModal('user-modal');
        await loadUsers();
    } catch (error) {
        console.error('User save error:', error);
        showToast(error.message, 'error');
    }
}

async function deleteUser(userId) {
    if (!isSuperAdmin) {
        showToast('Only super admins can delete users', 'error');
        return;
    }
    if (userId === currentUser?.id) {
        showToast('You cannot delete your own account', 'error');
        return;
    }
    const user = usersList.find(u => u.id === userId);
    if (!user) {
        showToast('User not found', 'error');
        return;
    }
    if (!confirm(`Delete ${user.email}? This cannot be undone.`)) {
        return;
    }
    try {
        const csrfToken = await getCsrfToken();
        const response = await fetch(`/api/users/${userId}`, {
            method: 'DELETE',
            credentials: 'same-origin',
            headers: { 'X-CSRF-Token': csrfToken || '' }
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error || 'Failed to delete user');
        }
        showToast('User deleted', 'success');
        await loadUsers();
    } catch (error) {
        console.error('User delete error:', error);
        showToast(error.message, 'error');
    }
}

async function loadCampaignsList() {
    const limit = CAMPAIGN_PAGE_LIMIT;
    const aggregatedCampaigns = [];
    let page = 1;
    let paginationMeta = null;
    let iterations = 0;

    try {
        while (true) {
            const response = await fetch(`/api/campaigns?page=${page}&limit=${limit}`, { credentials: 'same-origin' });
            if (!response.ok) {
                throw new Error(`Failed to load campaigns (page ${page})`);
            }
            const payload = await response.json();
            const batch = toCampaignArrayFromPayload(payload);
            aggregatedCampaigns.push(...batch);
            paginationMeta = normalizePaginationMeta(payload?.pagination, batch.length, page, limit);

            const reachedEnd = !paginationMeta || paginationMeta.totalPages === 0 || page >= paginationMeta.totalPages;
            if (reachedEnd) {
                break;
            }

            page += 1;
            iterations += 1;
            if (iterations >= MAX_CAMPAIGN_PAGE_REQUESTS) {
                console.warn('[Admin] Stopped campaign pagination after reaching safety limit');
                break;
            }
        }

        allCampaigns = {};
        aggregatedCampaigns.forEach(c => {
            if (c?.id) {
                allCampaigns[c.id] = c;
            }
        });

        await enrichCampaigns(aggregatedCampaigns);
        populateCampaignSelector(aggregatedCampaigns);
        renderCampaignTable();
        storeCampaignPaginationMeta(paginationMeta, aggregatedCampaigns.length);
    } catch (error) {
        console.error('Failed to load campaigns:', error);
        showToast('Failed to load campaigns list', 'error');
    }
}

function toCampaignArrayFromPayload(payload) {
    if (Array.isArray(payload?.campaigns)) {
        return payload.campaigns;
    }
    if (Array.isArray(payload)) {
        return payload;
    }
    return [];
}

function normalizePaginationMeta(meta, fallbackCount, page, limit) {
    if (!meta || typeof meta !== 'object') {
        return {
            page,
            limit,
            total: fallbackCount,
            totalPages: fallbackCount === 0 ? 0 : 1
        };
    }
    const normalizedLimit = Number.isFinite(Number(meta.limit)) ? Number(meta.limit) : limit;
    const normalizedTotal = Number.isFinite(Number(meta.total)) ? Number(meta.total) : fallbackCount;
    const normalizedPage = Number.isFinite(Number(meta.page)) ? Number(meta.page) : page;
    let normalizedTotalPages = Number.isFinite(Number(meta.totalPages)) ? Number(meta.totalPages) : null;
    if (normalizedTotalPages === null) {
        normalizedTotalPages = normalizedLimit > 0
            ? (normalizedTotal === 0 ? 0 : Math.ceil(normalizedTotal / normalizedLimit))
            : (fallbackCount === 0 ? 0 : 1);
    }
    return {
        page: normalizedPage,
        limit: normalizedLimit,
        total: normalizedTotal,
        totalPages: normalizedTotalPages
    };
}

function storeCampaignPaginationMeta(meta, loadedCount) {
    const fallback = {
        page: 1,
        limit: CAMPAIGN_PAGE_LIMIT,
        total: loadedCount,
        totalPages: loadedCount === 0 ? 0 : Math.ceil(loadedCount / CAMPAIGN_PAGE_LIMIT)
    };
    const snapshot = meta || fallback;
    if (typeof window !== 'undefined') {
        window.__campaignPagination = snapshot;
    }
    if (snapshot.total > loadedCount) {
        console.warn(`[Admin] Loaded ${loadedCount} of ${snapshot.total} campaign(s). Add UI pagination to access remaining records.`);
    }
}

async function enrichCampaigns(campaigns) {
    const detailPromises = campaigns.map(campaign => fetchCampaignDetail(campaign.id).catch(() => null));
    const details = await Promise.all(detailPromises);
    campaignsTableData = campaigns.map((campaign, index) => {
        const detail = details[index];
        const brandId = detail?.brand_id || detail?.brandId || null;
        const brandName = resolveBrandName(brandId);
        return {
            ...campaign,
            brand_id: brandId,
            brand_name: brandName,
            updated_at: detail?.updated_at || detail?.updatedAt || null
        };
    });
}

function resolveBrandName(brandId) {
    if (!brandId) {
        return currentUser?.brand?.name || 'Unassigned';
    }
    const brand = brandList.find(b => b.id === brandId);
    if (brand) return brand.name;
    return 'Unassigned';
}

function populateCampaignSelector(campaigns) {
    const selector = document.getElementById('campaign-selector');
    if (!selector) return;
    selector.innerHTML = '<option value="">-- Select a campaign --</option>';
    campaigns
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(campaign => {
            const option = document.createElement('option');
            option.value = campaign.id;
            option.textContent = `${campaign.name} (${campaign.id})`;
            selector.appendChild(option);
        });
}

function renderCampaignTable() {
    const tbody = document.querySelector('#campaigns-table tbody');
    if (!tbody) return;
    if (!campaignsTableData.length) {
        tbody.innerHTML = '<tr><td colspan="4">No campaigns found.</td></tr>';
        return;
    }
    const filtered = campaignsTableData.filter(campaign => {
        if (!isSuperAdmin || brandFilterValue === 'all') return true;
        return campaign.brand_id === brandFilterValue;
    });
    if (!filtered.length) {
        tbody.innerHTML = '<tr><td colspan="4">No campaigns for this brand.</td></tr>';
        return;
    }
    tbody.innerHTML = filtered
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(campaign => {
            const price = campaign.price ? `$${campaign.price}` : '—';
            return `
                <tr>
                    <td>
                        <div style="font-weight:600;">${campaign.name}</div>
                        <small style="color:#6b7280;">${campaign.id}</small>
                    </td>
                    <td>${campaign.brand_name || 'Unassigned'}</td>
                    <td>${price}</td>
                    <td>
                        <button type="button" class="btn-link" onclick="selectCampaignFromTable('${campaign.id}')">Edit</button>
                    </td>
                </tr>`;
        })
        .join('');
}

function selectCampaignFromTable(campaignId) {
    const selector = document.getElementById('campaign-selector');
    if (!selector) return;
    selector.value = campaignId;
    onCampaignSelect();
}

function applyInitialCampaignSelection() {
    const urlParams = new URLSearchParams(window.location.search);
    const campaignId = urlParams.get('v');
    if (!campaignId) return;
    const selector = document.getElementById('campaign-selector');
    if (!selector) return;
    const optionExists = Array.from(selector.options).some(option => option.value === campaignId);
    if (optionExists) {
        selector.value = campaignId;
        onCampaignSelect();
    } else {
        showToast('Campaign not found in URL parameter', 'error');
    }
}

async function fetchCampaignDetail(campaignId, forceRefresh = false) {
    if (!forceRefresh && campaignDetailsCache.has(campaignId)) {
        return campaignDetailsCache.get(campaignId);
    }
    const response = await fetch(`/api/campaign/${campaignId}`, { credentials: 'same-origin' });
    if (!response.ok) {
        throw new Error('Failed to load campaign');
    }
    const data = await response.json();
    campaignDetailsCache.set(campaignId, data);
    return data;
}

async function onCampaignSelect() {
    const selector = document.getElementById('campaign-selector');
    if (!selector) return;
    const campaignId = selector.value;

    if (!campaignId) {
        document.getElementById('admin-form').style.display = 'none';
        document.getElementById('no-campaign').style.display = 'block';
        document.getElementById('campaign-id-display').style.display = 'none';
        currentCampaignId = null;
        currentCampaign = null;
        return;
    }

    currentCampaignId = campaignId;
    try {
        const campaign = await fetchCampaignDetail(campaignId, true);
        currentCampaign = campaign;
        document.getElementById('admin-form').style.display = 'block';
        document.getElementById('no-campaign').style.display = 'none';
        document.getElementById('campaign-id-display').style.display = 'flex';
        document.getElementById('current-campaign-id').textContent = campaignId;
        const domain = window.location.origin;
        document.getElementById('campaign-url-hint').innerHTML = `<br><small>Landing page: <a href="${domain}/?v=${campaignId}" target="_blank">${domain}/?v=${campaignId}</a></small>`;
        populateForm();
        updateStats();
    } catch (error) {
        console.error('Error loading campaign:', error);
        showToast('Failed to load campaign data', 'error');
    }
}

// Existing campaign form helpers remain mostly unchanged
function setDefaultTiers() {
    tiers = [
        { buyers: 1000, price: 60, couponCode: '' },
        { buyers: 1500, price: 40, couponCode: '' },
        { buyers: 2000, price: 20, couponCode: '' }
    ];
}

function populateForm() {
    if (!currentCampaign) return;
    document.getElementById('product-image').value = currentCampaign.productImage || currentCampaign.imageUrl || '';
    document.getElementById('product-name').value = currentCampaign.productName || '';
    document.getElementById('product-description').value = currentCampaign.productDescription || currentCampaign.description || '';
    document.getElementById('video-source').value = currentCampaign.videoUrl || '';
    const checkoutUrl = currentCampaign.pricing?.checkoutUrl || currentCampaign.checkoutUrl || '';
    document.getElementById('checkout-url').value = checkoutUrl;
    document.getElementById('terms-url').value = currentCampaign.termsUrl || '';
    const pricing = currentCampaign.pricing || {};
    document.getElementById('initial-price').value = pricing.initialPrice || currentCampaign.originalPrice || 80;
    document.getElementById('initial-buyers').value = pricing.initialBuyers || currentCampaign.initialBuyers || 0;
    const tierData = pricing.tiers || currentCampaign.priceTiers || [
        { buyers: 100, price: 40, couponCode: '' },
        { buyers: 500, price: 30, couponCode: '' },
        { buyers: 1000, price: 20, couponCode: '' }
    ];
    tiers = tierData.map(t => ({ buyers: t.buyers, price: t.price, couponCode: t.couponCode || '' }));
    renderTiers();
    const countdownEnd = currentCampaign.countdownEnd;
    if (countdownEnd) {
        const endDate = new Date(countdownEnd);
        const localIso = new Date(endDate.getTime() - (endDate.getTimezoneOffset() * 60000)).toISOString().slice(0, 16);
        document.getElementById('countdown-end').value = localIso;
    }
    const twilio = currentCampaign.twilio || {};
    document.getElementById('twilio-enabled').checked = twilio.enabled || false;
    document.getElementById('twilio-sid').value = twilio.accountSid || '';
    document.getElementById('twilio-token').value = twilio.authToken || '';
    document.getElementById('twilio-number').value = twilio.phoneNumber || '';
    document.getElementById('domain').value = twilio.domain || window.location.origin;
    document.getElementById('referrals-needed').value = currentCampaign.referralsNeeded || currentCampaign.sharesRequired || 2;
}

function renderTiers() {
    const container = document.getElementById('price-tiers');
    if (!container) return;
    container.innerHTML = '';
    tiers.forEach((tier, index) => {
        const row = document.createElement('div');
        row.className = 'tier-row';
        row.innerHTML = `
            <span class="tier-label">${index + 1}.</span>
            <input type="number" placeholder="Buyers needed" value="${tier.buyers}" onchange="updateTier(${index}, 'buyers', this.value)">
            <input type="number" placeholder="Price ($)" value="${tier.price}" step="0.01" onchange="updateTier(${index}, 'price', this.value)">
            <input type="text" placeholder="Coupon code" value="${tier.couponCode || ''}" onchange="updateTier(${index}, 'couponCode', this.value)">
            <button type="button" class="remove-tier" onclick="removeTier(${index})">×</button>`;
        container.appendChild(row);
    });
}

function updateTier(index, field, value) {
    if (field === 'couponCode') {
        tiers[index][field] = value.trim();
    } else {
        tiers[index][field] = parseFloat(value) || 0;
    }
}

function addTier() {
    tiers.push({ buyers: 0, price: 0, couponCode: '' });
    renderTiers();
}

function removeTier(index) {
    tiers.splice(index, 1);
    renderTiers();
}

function getFormData() {
    return {
        productName: document.getElementById('product-name').value,
        productImage: document.getElementById('product-image').value,
        productDescription: document.getElementById('product-description').value,
        videoUrl: document.getElementById('video-source').value,
        twilio: {
            enabled: document.getElementById('twilio-enabled').checked,
            accountSid: document.getElementById('twilio-sid').value,
            authToken: document.getElementById('twilio-token').value,
            phoneNumber: document.getElementById('twilio-number').value,
            domain: document.getElementById('domain').value
        },
        pricing: {
            initialPrice: parseFloat(document.getElementById('initial-price').value) || 0,
            initialBuyers: parseInt(document.getElementById('initial-buyers').value) || 0,
            checkoutUrl: document.getElementById('checkout-url').value,
            tiers: tiers.map(tier => ({
                buyers: parseInt(tier.buyers) || 0,
                price: parseFloat(tier.price) || 0,
                couponCode: tier.couponCode || ''
            }))
        },
        termsUrl: document.getElementById('terms-url').value,
        referralsNeeded: parseInt(document.getElementById('referrals-needed').value) || 2,
        countdownEnd: new Date(document.getElementById('countdown-end').value).toISOString()
    };
}

async function saveCampaign(event) {
    event.preventDefault();
    if (!currentCampaignId) {
        showToast('No campaign selected', 'error');
        return;
    }
    const csrfToken = await getCsrfToken();
    const formData = getFormData();
    const payload = {
        ...currentCampaign,
        ...formData,
        pricing: {
            ...formData.pricing,
            tiers: formData.pricing.tiers.filter(t => t.buyers > 0).sort((a, b) => a.buyers - b.buyers)
        },
        price: Math.min(...tiers.map(t => t.price)) || 20,
        originalPrice: parseFloat(document.getElementById('initial-price').value) || 80,
        imageUrl: document.getElementById('product-image').value,
        sharesRequired: parseInt(document.getElementById('referrals-needed').value) || 2,
        initialBuyers: parseInt(document.getElementById('initial-buyers').value) || 0,
        priceTiers: formData.pricing.tiers.filter(t => t.buyers > 0).sort((a, b) => a.buyers - b.buyers),
        csrfToken
    };

    try {
        const response = await fetch(`/api/campaign/${currentCampaignId}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken || ''
            },
            credentials: 'same-origin',
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error || 'Failed to save campaign');
        }
        showToast('✅ Changes saved!', 'success');
        await loadCampaignsList();
    } catch (error) {
        console.error('Save error:', error);
        showToast(error.message, 'error');
    }
}

async function createNewCampaign() {
    const name = prompt('Enter product name for the new campaign:');
    if (!name) return;
    const videoUrl = prompt('Enter m3u8 video URL (optional):') || 'https://example.com/video.m3u8';
    const csrfToken = await getCsrfToken();
    const defaultCampaign = {
        productName: name,
        productImage: 'https://via.placeholder.com/400x300?text=Product+Image',
        productDescription: '<h4>Product Details</h4><p>Description coming soon...</p>',
        videoUrl,
        twilio: {
            enabled: false,
            accountSid: '',
            authToken: '',
            phoneNumber: '',
            domain: window.location.origin
        },
        pricing: {
            initialPrice: 80,
            initialBuyers: 100,
            checkoutUrl: '',
            tiers: [
                { buyers: 100, price: 40, couponCode: '' },
                { buyers: 500, price: 30, couponCode: '' },
                { buyers: 1000, price: 20, couponCode: '' }
            ]
        },
        referralsNeeded: 2,
        countdownEnd: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
        description: '<h4>Product Details</h4><p>Description coming soon...</p>',
        price: 20,
        originalPrice: 80,
        imageUrl: '',
        sharesRequired: 2,
        discountPercentage: 75,
        merchantName: '',
        merchantLogo: '',
        initialBuyers: 100,
        priceTiers: [
            { buyers: 100, price: 40, couponCode: '' },
            { buyers: 500, price: 30, couponCode: '' },
            { buyers: 1000, price: 20, couponCode: '' }
        ],
        csrfToken
    };

    try {
        const response = await fetch('/api/campaigns', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-CSRF-Token': csrfToken || ''
            },
            credentials: 'same-origin',
            body: JSON.stringify(defaultCampaign)
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error || 'Failed to create campaign');
        }
        const data = await response.json();
        showToast('✅ New campaign created!', 'success');
        await loadCampaignsList();
        const selector = document.getElementById('campaign-selector');
        if (selector) {
            selector.value = data.campaignId;
        }
        const url = new URL(window.location);
        url.searchParams.set('v', data.campaignId);
        window.history.pushState({}, '', url);
        await onCampaignSelect();
    } catch (error) {
        console.error('Error creating campaign:', error);
        showToast(error.message, 'error');
    }
}

async function getCsrfToken() {
    try {
        const response = await fetch('/api/csrf-token', { credentials: 'same-origin' });
        if (response.ok) {
            const data = await response.json();
            return data.token;
        }
    } catch (error) {
        console.error('Failed to get CSRF token:', error);
    }
    return null;
}

async function deleteCampaign() {
    if (!currentCampaignId) return;
    if (!confirm(`Delete campaign "${currentCampaign?.productName || currentCampaignId}"? This cannot be undone.`)) {
        return;
    }
    const csrfToken = await getCsrfToken();
    try {
        const response = await fetch(`/api/campaign/${currentCampaignId}`, {
            method: 'DELETE',
            headers: { 'X-CSRF-Token': csrfToken || '' },
            credentials: 'same-origin'
        });
        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            throw new Error(error?.error || 'Failed to delete campaign');
        }
        showToast('✅ Campaign deleted', 'success');
        const url = new URL(window.location);
        url.searchParams.delete('v');
        window.history.pushState({}, '', url);
        currentCampaignId = null;
        currentCampaign = null;
        document.getElementById('campaign-selector').value = '';
        document.getElementById('admin-form').style.display = 'none';
        document.getElementById('no-campaign').style.display = 'block';
        document.getElementById('campaign-id-display').style.display = 'none';
        await loadCampaignsList();
    } catch (error) {
        console.error('Delete error:', error);
        showToast(error.message, 'error');
    }
}

function resetForm() {
    if (confirm('Reset all changes to saved values?')) {
        populateForm();
        showToast('Form reset', 'success');
    }
}

async function updateStats() {
    if (!currentCampaignId) return;
    try {
        const [campaignRes, participantsRes, statsRes] = await Promise.all([
            fetch(`/api/campaign/${currentCampaignId}`, { credentials: 'same-origin' }),
            fetch('/api/participants', { credentials: 'same-origin' }),
            fetch(`/api/campaign/${currentCampaignId}/stats`, { credentials: 'same-origin' }).catch(() => null)
        ]);
        const campaign = await campaignRes.json();
        const allParticipants = await participantsRes.json();
        const statsData = statsRes ? await statsRes.json().catch(() => ({})) : {};
        if (!Array.isArray(allParticipants)) return;
        const participants = allParticipants.filter(p => p.campaignId === currentCampaignId);
        const pricing = campaign.pricing || {};
        const tiers = pricing.tiers || campaign.priceTiers || [];
        const initialPrice = pricing.initialPrice || campaign.originalPrice || 80;
        const initialBuyers = pricing.initialBuyers || campaign.initialBuyers || 0;
        const totalBuyers = initialBuyers + participants.length;
        let currentPrice = initialPrice;
        for (const tier of tiers.sort((a, b) => a.buyers - b.buyers)) {
            if (totalBuyers >= tier.buyers) {
                currentPrice = tier.price;
            }
        }
        const endDate = new Date(campaign.countdownEnd);
        const diff = endDate - new Date();
        let timeLeft = 'Ended';
        if (diff > 0) {
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            timeLeft = `${days}d ${hours}h`;
        }
        const smsSentCount = statsData.smsSentCount || 0;
        const expectedRevenue = participants.length * currentPrice;
        document.getElementById('stat-total-buyers').textContent = totalBuyers;
        document.getElementById('stat-real').textContent = participants.length;
        document.getElementById('stat-current-price').textContent = `$${currentPrice}`;
        document.getElementById('stat-time-left').textContent = timeLeft;
        document.getElementById('stat-sms-sent').textContent = smsSentCount;
        document.getElementById('stat-expected-revenue').textContent = `$${expectedRevenue.toLocaleString()}`;
    } catch (error) {
        console.error('Stats error:', error);
    }
}

async function viewParticipants() {
    try {
        const response = await fetch('/api/participants', { credentials: 'same-origin' });
        const allParticipants = await response.json();
        const participants = currentCampaignId ? allParticipants.filter(p => p.campaignId === currentCampaignId) : allParticipants;
        const tbody = document.querySelector('#participants-table tbody');
        if (!tbody) return;
        tbody.innerHTML = participants.map(p => `
            <tr>
                <td>${p.phone}</td>
                <td>${p.email}</td>
                <td><code>${p.referralCode || '-'}</code></td>
                <td>${p.referredBy || '-'}</td>
                <td>${p.campaignId || '-'}</td>
                <td>${new Date(p.joinedAt).toLocaleString()}</td>
            </tr>`).join('');
        document.getElementById('participants-modal').classList.remove('hidden');
    } catch (error) {
        showToast('Failed to load participants', 'error');
    }
}

function closeModalWithId(modalId) {
    closeModal(modalId);
}

async function downloadParticipants() {
    if (!currentCampaignId) {
        showToast('No campaign selected', 'error');
        return;
    }
    try {
        const response = await fetch(`/api/campaign/${currentCampaignId}/export`, { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error('Failed to export participants');
        }
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = 'participants.csv';
        if (contentDisposition) {
            const match = contentDisposition.match(/filename="?([^";]+)"?/);
            if (match) filename = match[1];
        }
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        window.URL.revokeObjectURL(url);
        showToast('✅ Download started!', 'success');
    } catch (error) {
        console.error('Export error:', error);
        showToast('❌ Failed to download participants', 'error');
    }
}

function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

async function logout() {
    if (!confirm('Are you sure you want to logout?')) return;
    try {
        await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    } catch (error) {
        console.warn('Logout request failed:', error);
    } finally {
        localStorage.removeItem(STORAGE_KEYS.token);
        localStorage.removeItem(STORAGE_KEYS.brand);
        localStorage.removeItem(STORAGE_KEYS.superAdmin);
        sessionStorage.removeItem(STORAGE_KEYS.brand);
        sessionStorage.removeItem(STORAGE_KEYS.superAdmin);
        window.location.href = 'login.html';
    }
}

// Keep stats auto-refresh
setInterval(() => {
    if (currentCampaignId) {
        updateStats();
    }
}, 10000);
