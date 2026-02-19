let currentConfig = {};
let tiers = [];

// Load config on page load
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        currentConfig = await response.json();
        populateForm();
        updateStats();
    } catch (e) {
        showToast('Failed to load config', 'error');
    }
}

// Populate form with current values
function populateForm() {
    // Product
    document.getElementById('product-image').value = currentConfig.product?.image || '';
    document.getElementById('product-name').value = currentConfig.product?.name || '';
    document.getElementById('product-description').value = currentConfig.product?.description || '';
    
    // Video
    document.getElementById('video-source').value = currentConfig.videoSource || '';
    
    // Pricing
    document.getElementById('initial-price').value = currentConfig.initialPrice || 80;
    document.getElementById('initial-buyers').value = currentConfig.initialBuyers || 0;
    
    // Price tiers
    tiers = currentConfig.priceTiers || [
        {buyers: 100, price: 40},
        {buyers: 500, price: 30},
        {buyers: 1000, price: 20}
    ];
    renderTiers();
    
    // Countdown - convert to local datetime-local format
    if (currentConfig.countdownEnd) {
        const endDate = new Date(currentConfig.countdownEnd);
        const localIso = new Date(endDate.getTime() - (endDate.getTimezoneOffset() * 60000))
            .toISOString().slice(0, 16);
        document.getElementById('countdown-end').value = localIso;
    }
    
    // Twilio
    const twilio = currentConfig.twilio || {};
    document.getElementById('twilio-enabled').checked = twilio.enabled || false;
    document.getElementById('twilio-sid').value = twilio.accountSid || '';
    document.getElementById('twilio-token').value = twilio.authToken || '';
    document.getElementById('twilio-number').value = twilio.phoneNumber || '';
    document.getElementById('domain').value = currentConfig.domain || '';
    
    // Referrals
    document.getElementById('referrals-needed').value = currentConfig.referralsNeeded || 2;
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
            <button type="button" class="remove-tier" onclick="removeTier(${index})">×</button>
        `;
        container.appendChild(row);
    });
}

// Add new tier
function addTier() {
    tiers.push({buyers: 0, price: 0});
    renderTiers();
}

// Update tier value
function updateTier(index, field, value) {
    tiers[index][field] = parseFloat(value) || 0;
}

// Remove tier
function removeTier(index) {
    tiers.splice(index, 1);
    renderTiers();
}

// Save config
async function saveConfig(e) {
    e.preventDefault();
    
    // Build config object
    const countdownInput = document.getElementById('countdown-end').value;
    const localDate = new Date(countdownInput);
    const countdownEnd = localDate.toISOString(); // Convert to ISO with timezone
    
    const newConfig = {
        initialPrice: parseFloat(document.getElementById('initial-price').value) || 80,
        initialBuyers: parseInt(document.getElementById('initial-buyers').value) || 0,
        priceTiers: tiers.filter(t => t.buyers > 0),
        countdownEnd: countdownEnd,
        videoSource: document.getElementById('video-source').value,
        product: {
            image: document.getElementById('product-image').value,
            name: document.getElementById('product-name').value,
            description: document.getElementById('product-description').value
        },
        twilio: {
            enabled: document.getElementById('twilio-enabled').checked,
            accountSid: document.getElementById('twilio-sid').value,
            authToken: document.getElementById('twilio-token').value,
            phoneNumber: document.getElementById('twilio-number').value
        },
        domain: document.getElementById('domain').value,
        referralsNeeded: parseInt(document.getElementById('referrals-needed').value) || 2
    };
    
    try {
        const response = await fetch('/api/admin/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(newConfig)
        });
        
        if (response.ok) {
            showToast('✅ Changes saved!', 'success');
            loadConfig(); // Refresh
        } else {
            showToast('❌ Failed to save', 'error');
        }
    } catch (e) {
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
    try {
        const [configRes, participantsRes] = await Promise.all([
            fetch('/api/config'),
            fetch('/api/participants')
        ]);
        
        const config = await configRes.json();
        const participants = await participantsRes.json();
        
        // Calculate current price
        let currentPrice = config.initialPrice || 80;
        for (const tier of config.priceTiers || []) {
            if (config.currentBuyers >= tier.buyers) {
                currentPrice = tier.price;
            }
        }
        
        // Calculate time left
        const endDate = new Date(config.countdownEnd);
        const diff = endDate - new Date();
        let timeLeft = 'Ended';
        if (diff > 0) {
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            timeLeft = `${days}d ${hours}h`;
        }
        
        document.getElementById('stat-total-buyers').textContent = config.currentBuyers || 0;
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
        const participants = await response.json();
        
        const tbody = document.querySelector('#participants-table tbody');
        tbody.innerHTML = participants.map(p => `
            <tr>
                <td>${p.phone}</td>
                <td>${p.email}</td>
                <td><code>${p.referralCode || '-'}</code></td>
                <td>${p.referredBy || '-'}</td>
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
document.getElementById('admin-form').addEventListener('submit', saveConfig);

// Close modal on outside click
document.getElementById('participants-modal').addEventListener('click', (e) => {
    if (e.target.id === 'participants-modal') closeModal();
});

// Load on page load
loadConfig();

// Refresh stats every 10 seconds
setInterval(updateStats, 10000);
