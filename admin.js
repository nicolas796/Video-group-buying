let currentCampaignId = null;
let currentCampaign = null;
let allCampaigns = {};
let tiers = [];

// Load campaigns on page load
document.addEventListener('DOMContentLoaded', init);

async function init() {
    await loadCampaignsList();
    
    // Check for campaign ID in URL
    const urlParams = new URLSearchParams(window.location.search);
    const campaignIdFromUrl = urlParams.get('v');
    
    if (campaignIdFromUrl && allCampaigns[campaignIdFromUrl]) {
        // Auto-select campaign from URL
        document.getElementById('campaign-selector').value = campaignIdFromUrl;
        await onCampaignSelect();
    } else if (campaignIdFromUrl) {
        showToast('Campaign not found in URL parameter', 'error');
    }
}

// Load all campaigns for the dropdown
async function loadCampaignsList() {
    try {
        const response = await fetch('/api/campaigns');
        const campaigns = await response.json();
        
        // Convert array to object for easy lookup
        allCampaigns = {};
        campaigns.forEach(c => {
            allCampaigns[c.id] = c;
        });
        
        // Populate dropdown
        const selector = document.getElementById('campaign-selector');
        // Keep the first option
        selector.innerHTML = '<option value="">-- Select a campaign --</option>';
        
        campaigns.forEach(campaign => {
            const option = document.createElement('option');
            option.value = campaign.id;
            option.textContent = `${campaign.name} (${campaign.id})`;
            selector.appendChild(option);
        });
    } catch (e) {
        console.error('Failed to load campaigns:', e);
        showToast('Failed to load campaigns list', 'error');
    }
}

// Handle campaign selection
async function onCampaignSelect() {
    const selector = document.getElementById('campaign-selector');
    const campaignId = selector.value;
    
    if (!campaignId) {
        // No campaign selected
        document.getElementById('admin-form').style.display = 'none';
        document.getElementById('no-campaign').style.display = 'block';
        document.getElementById('campaign-id-display').style.display = 'none';
        currentCampaignId = null;
        currentCampaign = null;
        return;
    }
    
    currentCampaignId = campaignId;
    
    // Load full campaign data
    try {
        const response = await fetch(`/api/campaign/${campaignId}`);
        if (!response.ok) {
            throw new Error('Failed to load campaign');
        }
        
        currentCampaign = await response.json();
        
        // Show form
        document.getElementById('admin-form').style.display = 'block';
        document.getElementById('no-campaign').style.display = 'none';
        
        // Update campaign ID display
        document.getElementById('campaign-id-display').style.display = 'flex';
        document.getElementById('current-campaign-id').textContent = campaignId;
        
        const domain = window.location.origin;
        document.getElementById('campaign-url-hint').innerHTML = 
            `<br><small>Landing page: <a href="${domain}/?v=${campaignId}" target="_blank">${domain}/?v=${campaignId}</a></small>`;
        
        populateForm();
        updateStats();
    } catch (e) {
        console.error('Error loading campaign:', e);
        showToast('Failed to load campaign data', 'error');
    }
}

// Create new campaign
async function createNewCampaign() {
    const name = prompt('Enter product name for the new campaign:');
    if (!name) return;
    
    const videoUrl = prompt('Enter m3u8 video URL (optional):') || '';
    
    const defaultCampaign = {
        productName: name,
        productImage: '',
        productDescription: '<h4>Product Details</h4><p>Description coming soon...</p>',
        videoUrl: videoUrl,
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
        // Legacy fields for backward compatibility
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
            { buyers: 100, price: 40 },
            { buyers: 500, price: 30 },
            { buyers: 1000, price: 20 }
        ]
    };
    
    try {
        const response = await fetch('/api/campaigns', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(defaultCampaign)
        });
        
        if (response.ok) {
            const data = await response.json();
            showToast('✅ New campaign created!', 'success');
            
            // Reload campaigns list and select the new one
            await loadCampaignsList();
            document.getElementById('campaign-selector').value = data.campaignId;
            await onCampaignSelect();
            
            // Update URL without reloading
            const url = new URL(window.location);
            url.searchParams.set('v', data.campaignId);
            window.history.pushState({}, '', url);
        } else {
            const error = await response.json();
            showToast(`❌ ${error.error || 'Failed to create campaign'}`, 'error');
        }
    } catch (e) {
        console.error('Error creating campaign:', e);
        showToast('❌ Network error', 'error');
    }
}

// Populate form with current campaign values
function populateForm() {
    if (!currentCampaign) return;
    
    // Product
    document.getElementById('product-image').value = currentCampaign.productImage || currentCampaign.imageUrl || '';
    document.getElementById('product-name').value = currentCampaign.productName || '';
    document.getElementById('product-description').value = currentCampaign.productDescription || currentCampaign.description || '';
    
    // Video
    document.getElementById('video-source').value = currentCampaign.videoUrl || '';

    // Checkout URL
    const checkoutUrl = currentCampaign.pricing?.checkoutUrl || currentCampaign.checkoutUrl || '';
    document.getElementById('checkout-url').value = checkoutUrl;

    // Terms & Conditions URL
    document.getElementById('terms-url').value = currentCampaign.termsUrl || '';
    
    // Pricing - handle both new and legacy structure
    const pricing = currentCampaign.pricing || {};
    document.getElementById('initial-price').value = pricing.initialPrice || currentCampaign.originalPrice || 80;
    document.getElementById('initial-buyers').value = pricing.initialBuyers || currentCampaign.initialBuyers || 0;
    
    // Price tiers
    const tierData = pricing.tiers || currentCampaign.priceTiers || [
        { buyers: 100, price: 40, couponCode: '' },
        { buyers: 500, price: 30, couponCode: '' },
        { buyers: 1000, price: 20, couponCode: '' }
    ];
    tiers = tierData.map(t => ({
        buyers: t.buyers,
        price: t.price,
        couponCode: t.couponCode || ''
    }));
    renderTiers();
    
    // Countdown - convert to local datetime-local format
    const countdownEnd = currentCampaign.countdownEnd;
    if (countdownEnd) {
        const endDate = new Date(countdownEnd);
        const localIso = new Date(endDate.getTime() - (endDate.getTimezoneOffset() * 60000))
            .toISOString().slice(0, 16);
        document.getElementById('countdown-end').value = localIso;
    }
    
    // Twilio - handle both new and legacy structure
    const twilio = currentCampaign.twilio || {};
    document.getElementById('twilio-enabled').checked = twilio.enabled || false;
    document.getElementById('twilio-sid').value = twilio.accountSid || '';
    document.getElementById('twilio-token').value = twilio.authToken || '';
    document.getElementById('twilio-number').value = twilio.phoneNumber || '';
    document.getElementById('domain').value = twilio.domain || window.location.origin;
    
    // Referrals
    document.getElementById('referrals-needed').value = currentCampaign.referralsNeeded || currentCampaign.sharesRequired || 2;
}

// Render price tier rows
function renderTiers() {
    const container = document.getElementById('price-tiers');
    container.innerHTML = '';

    tiers.forEach((tier, index) => {
        const row = document.createElement('div');
        row.className = 'tier-row';
        row.innerHTML = `
            <span class="tier-label">${index + 1}.</span>
            <input type="number" placeholder="Buyers needed" value="${tier.buyers}"
                   onchange="updateTier(${index}, 'buyers', this.value)">
            <input type="number" placeholder="Price ($)" value="${tier.price}" step="0.01"
                   onchange="updateTier(${index}, 'price', this.value)">
            <input type="text" placeholder="Coupon code" value="${tier.couponCode || ''}"
                   onchange="updateTier(${index}, 'couponCode', this.value)">
            <button type="button" class="remove-tier" onclick="removeTier(${index})">×</button>
        `;
        container.appendChild(row);
    });
}

// Add new tier
function addTier() {
    tiers.push({ buyers: 0, price: 0, couponCode: '' });
    renderTiers();
}

// Update tier value
function updateTier(index, field, value) {
    if (field === 'couponCode') {
        tiers[index][field] = value.trim();
    } else {
        tiers[index][field] = parseFloat(value) || 0;
    }
}

// Remove tier
function removeTier(index) {
    tiers.splice(index, 1);
    renderTiers();
}

// Save campaign
async function saveCampaign(e) {
    e.preventDefault();
    
    if (!currentCampaignId) {
        showToast('No campaign selected', 'error');
        return;
    }
    
    // Build countdown ISO string
    const countdownInput = document.getElementById('countdown-end').value;
    const localDate = new Date(countdownInput);
    const countdownEnd = localDate.toISOString();
    
    // Build updated campaign object
    const updatedCampaign = {
        ...currentCampaign,
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
            initialPrice: parseFloat(document.getElementById('initial-price').value) || 80,
            initialBuyers: parseInt(document.getElementById('initial-buyers').value) || 0,
            checkoutUrl: document.getElementById('checkout-url').value.trim(),
            tiers: tiers.filter(t => t.buyers > 0).sort((a, b) => a.buyers - b.buyers)
        },
        termsUrl: document.getElementById('terms-url').value.trim(),
        referralsNeeded: parseInt(document.getElementById('referrals-needed').value) || 2,
        countdownEnd: countdownEnd,
        // Legacy fields for backward compatibility
        description: document.getElementById('product-description').value,
        price: Math.min(...tiers.map(t => t.price)) || 20,
        originalPrice: parseFloat(document.getElementById('initial-price').value) || 80,
        imageUrl: document.getElementById('product-image').value,
        sharesRequired: parseInt(document.getElementById('referrals-needed').value) || 2,
        initialBuyers: parseInt(document.getElementById('initial-buyers').value) || 0,
        priceTiers: tiers.filter(t => t.buyers > 0).sort((a, b) => a.buyers - b.buyers)
    };
    
    try {
        const response = await fetch(`/api/campaign/${currentCampaignId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(updatedCampaign)
        });
        
        if (response.ok) {
            showToast('✅ Changes saved!', 'success');
            currentCampaign = updatedCampaign;
            
            // Refresh the campaigns list to show updated name
            await loadCampaignsList();
            document.getElementById('campaign-selector').value = currentCampaignId;
        } else {
            const error = await response.json();
            showToast(`❌ ${error.error || 'Failed to save'}`, 'error');
        }
    } catch (e) {
        console.error('Save error:', e);
        showToast('❌ Network error', 'error');
    }
}

// Delete campaign
async function deleteCampaign() {
    if (!currentCampaignId) return;
    
    if (!confirm(`Are you sure you want to delete campaign "${currentCampaign.productName || currentCampaignId}"?\n\nThis action cannot be undone!`)) {
        return;
    }
    
    try {
        const response = await fetch(`/api/campaign/${currentCampaignId}`, {
            method: 'DELETE'
        });
        
        if (response.ok) {
            showToast('✅ Campaign deleted', 'success');
            
            // Clear URL parameter
            const url = new URL(window.location);
            url.searchParams.delete('v');
            window.history.pushState({}, '', url);
            
            // Reset form
            currentCampaignId = null;
            currentCampaign = null;
            document.getElementById('campaign-selector').value = '';
            document.getElementById('admin-form').style.display = 'none';
            document.getElementById('no-campaign').style.display = 'block';
            document.getElementById('campaign-id-display').style.display = 'none';
            
            // Refresh list
            await loadCampaignsList();
        } else {
            const error = await response.json();
            showToast(`❌ ${error.error || 'Failed to delete'}`, 'error');
        }
    } catch (e) {
        console.error('Delete error:', e);
        showToast('❌ Network error', 'error');
    }
}

// Reset form
function resetForm() {
    if (confirm('Reset all changes to saved values?')) {
        populateForm();
        showToast('Form reset', 'success');
    }
}

// Update stats display
async function updateStats() {
    if (!currentCampaignId) return;
    
    try {
        const [campaignRes, participantsRes] = await Promise.all([
            fetch(`/api/campaign/${currentCampaignId}`),
            fetch('/api/participants')
        ]);
        
        const campaign = await campaignRes.json();
        const allParticipants = await participantsRes.json();
        
        // Check if response is valid array (handle rate limiting errors, etc.)
        if (!Array.isArray(allParticipants)) {
            console.warn('Invalid participants data:', allParticipants);
            return; // Don't try to filter non-array
        }
        
        // Filter participants for current campaign
        const participants = allParticipants.filter(p => p.campaignId === currentCampaignId);
        
        // Calculate current price
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
        
        // Calculate time left
        const endDate = new Date(campaign.countdownEnd);
        const diff = endDate - new Date();
        let timeLeft = 'Ended';
        if (diff > 0) {
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            timeLeft = `${days}d ${hours}h`;
        }
        
        document.getElementById('stat-total-buyers').textContent = totalBuyers;
        document.getElementById('stat-real').textContent = participants.length;
        document.getElementById('stat-current-price').textContent = `$${currentPrice}`;
        document.getElementById('stat-time-left').textContent = timeLeft;
    } catch (e) {
        console.error('Stats error:', e);
    }
}

// View participants
async function viewParticipants() {
    try {
        const response = await fetch('/api/participants');
        const allParticipants = await response.json();
        
        // Filter by current campaign if one is selected
        const participants = currentCampaignId 
            ? allParticipants.filter(p => p.campaignId === currentCampaignId)
            : allParticipants;
        
        const tbody = document.querySelector('#participants-table tbody');
        tbody.innerHTML = participants.map(p => `
            <tr>
                <td>${p.phone}</td>
                <td>${p.email}</td>
                <td><code>${p.referralCode || '-'}</code></td>
                <td>${p.referredBy || '-'}</td>
                <td>${p.campaignId || '-'}</td>
                <td>${new Date(p.joinedAt).toLocaleString()}</td>
            </tr>
        `).join('');
        
        document.getElementById('participants-modal').classList.remove('hidden');
    } catch (e) {
        showToast('Failed to load participants', 'error');
    }
}

function closeModal() {
    document.getElementById('participants-modal').classList.add('hidden');
}

// Download participants as CSV
async function downloadParticipants() {
    if (!currentCampaignId) {
        showToast('No campaign selected', 'error');
        return;
    }
    
    try {
        const response = await fetch(`/api/campaign/${currentCampaignId}/export`);
        
        if (!response.ok) {
            throw new Error('Failed to export participants');
        }
        
        // Get the filename from the Content-Disposition header
        const contentDisposition = response.headers.get('Content-Disposition');
        let filename = 'participants.csv';
        if (contentDisposition) {
            const filenameMatch = contentDisposition.match(/filename="?([^"]+)"?/);
            if (filenameMatch) {
                filename = filenameMatch[1];
            }
        }
        
        // Get the CSV content
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        
        // Create a temporary link and trigger download
        const link = document.createElement('a');
        link.href = url;
        link.download = filename;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        
        // Clean up
        window.URL.revokeObjectURL(url);
        
        showToast('✅ Download started!', 'success');
    } catch (e) {
        console.error('Export error:', e);
        showToast('❌ Failed to download participants', 'error');
    }
}

// Show toast notification
function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = `toast ${type} show`;
    
    setTimeout(() => {
        toast.classList.remove('show');
    }, 3000);
}

// Event listeners
document.getElementById('admin-form').addEventListener('submit', saveCampaign);

// Close modal on outside click
document.getElementById('participants-modal').addEventListener('click', (e) => {
    if (e.target.id === 'participants-modal') closeModal();
});

// Refresh stats every 10 seconds when a campaign is selected
setInterval(() => {
    if (currentCampaignId) {
        updateStats();
    }
}, 10000);