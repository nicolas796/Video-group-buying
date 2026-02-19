// Group Buying App
let config = {};
let hls = null;
let userReferralCode = null;
let referredBy = null;

// Get referral code from URL
function getReferralFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('ref');
}

// DOM Elements
const video = document.getElementById('video-player');
const loading = document.getElementById('loading');
const landingView = document.getElementById('landing-view');
const successView = document.getElementById('success-view');
const joinForm = document.getElementById('join-form');

// Initialize
async function init() {
    await loadConfig();
    initPlayer();
    renderProductInfo();
    renderProgressBar();
    startCountdown();
    updateBuyerCount();
}

// Load config from "database"
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        config = await response.json();
    } catch (e) {
        console.error('Failed to load config:', e);
        // Fallback defaults
        config = {
            initialBuyers: 500,
            initialPrice: 80,
            priceTiers: [
                {buyers: 100, price: 40},
                {buyers: 500, price: 30},
                {buyers: 1000, price: 20}
            ],
            countdownEnd: '2026-02-20T14:00:00-05:00',
            videoSource: 'https://vod.estreamly.com/assets/994758e3-c35f-4e26-9512-1babf10b6207/HLS/jUVhs_DTuiA6FDuYM_720.m3u8',
            product: {
                image: 'https://cdn.shopify.com/s/files/1/0576/9848/4364/files/478-Range-Rider-Denim.png?v=1763760948',
                name: '478 Range Rider Denim',
                description: 'Come in 3 sizes'
            }
        };
        // Calculate current buyers for fallback
        config.currentBuyers = config.initialBuyers;
    }
}

// Initialize HLS Player
function initPlayer() {
    loading.classList.add('active');
    
    // Enable autoplay (muted is required for autoplay in modern browsers)
    video.muted = true;
    video.autoplay = true;
    video.loop = true;
    
    const attemptPlay = () => {
        video.play().catch(e => console.log('Autoplay prevented:', e));
    };
    
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = config.videoSource;
        video.addEventListener('loadedmetadata', () => {
            loading.classList.remove('active');
            attemptPlay();
        });
    } else if (Hls.isSupported()) {
        hls = new Hls({
            maxBufferLength: 30,
            maxMaxBufferLength: 60,
            enableWorker: true
        });
        
        hls.loadSource(config.videoSource);
        hls.attachMedia(video);
        
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
            loading.classList.remove('active');
            attemptPlay();
        });
        
        hls.on(Hls.Events.ERROR, (event, data) => {
            console.error('HLS Error:', data);
            if (data.fatal) {
                loading.textContent = 'Error loading video';
            }
        });
    } else {
        loading.textContent = 'Browser not supported';
    }
}

// Calculate current price based on buyers
function getCurrentPrice() {
    const buyers = config.currentBuyers;
    let price = config.initialPrice || 80; // Default max price
    
    for (const tier of config.priceTiers) {
        if (buyers >= tier.buyers) {
            price = tier.price;
        }
    }
    
    return price;
}

// Get next unlock tier
function getNextTier() {
    const buyers = config.currentBuyers;
    
    for (const tier of config.priceTiers) {
        if (buyers < tier.buyers) {
            return tier;
        }
    }
    return null;
}

// Render product info
function renderProductInfo() {
    const product = config.product || {};
    
    // Landing view (mini)
    const landingImg = document.getElementById('product-img');
    if (landingImg) landingImg.src = product.image || '';
    
    const landingName = document.getElementById('product-name');
    if (landingName) landingName.textContent = product.name || '';
    
    // Success view (full)
    const successImg = document.getElementById('product-img-success');
    if (successImg) successImg.src = product.image || '';
    
    const successName = document.getElementById('product-name-success');
    if (successName) successName.textContent = product.name || '';
}

// Render progress bar
function renderProgressBar() {
    const maxBuyers = Math.max(...config.priceTiers.map(t => t.buyers));
    const progress = Math.min((config.currentBuyers / maxBuyers) * 100, 100);
    const currentPrice = getCurrentPrice();
    const nextTier = getNextTier();
    const initialPrice = config.initialPrice || 80;
    
    // Update landing view (simple mini bar)
    const landingBar = document.getElementById('progress-bar');
    if (landingBar) {
        landingBar.style.width = `${progress}%`;
    }
    
    // Update success view (full bar with markers)
    updateProgressDisplay('progress-bar-success', 'tier-markers-success', 'tier-labels-success', progress, currentPrice, nextTier, initialPrice, true);
    
    // Update prices on landing view
    const currentPriceEl = document.getElementById('current-price');
    const initialPriceEl = document.getElementById('initial-price');
    if (currentPriceEl) currentPriceEl.textContent = `$${currentPrice}`;
    if (initialPriceEl) initialPriceEl.textContent = `$${initialPrice}`;
    
    // Update unlocked text
    const unlockedText = document.getElementById('unlocked-price');
    if (unlockedText) {
        if (nextTier) {
            unlockedText.textContent = `🔓 Unlock $${nextTier.price} at ${nextTier.buyers} buyers`;
        } else {
            unlockedText.textContent = '✅ Max discount unlocked!';
        }
    }
}

function updateProgressDisplay(barId, markersId, labelsId, progress, currentPrice, nextTier, initialPrice, isCompact = false) {
    const bar = document.getElementById(barId);
    const markers = document.getElementById(markersId);
    const labels = document.getElementById(labelsId);
    
    if (!bar || !markers || !labels) return;
    
    // Set progress bar width
    bar.style.width = `${progress}%`;
    
    // Clear and rebuild markers/labels
    markers.innerHTML = '';
    labels.innerHTML = '';
    
    const maxBuyers = Math.max(...config.priceTiers.map(t => t.buyers));
    
    config.priceTiers.forEach(tier => {
        const position = (tier.buyers / maxBuyers) * 100;
        const isUnlocked = config.currentBuyers >= tier.buyers;
        
        // Marker
        const marker = document.createElement('div');
        marker.className = `tier-marker ${isUnlocked ? 'unlocked' : ''}`;
        marker.style.left = `${position}%`;
        markers.appendChild(marker);
        
        // Label
        const label = document.createElement('div');
        label.className = 'tier-label';
        label.innerHTML = `
            <div class="tier-buyers">${tier.buyers}</div>
            <div class="tier-price">$${tier.price}</div>
        `;
        labels.appendChild(label);
    });
    
    // Update price display (success view only)
    const currentPriceEl = document.getElementById('current-price-success');
    const initialPriceEl = document.getElementById('initial-price-success');
    
    if (currentPriceEl) currentPriceEl.textContent = `$${currentPrice}`;
    if (initialPriceEl) initialPriceEl.textContent = `$${initialPrice}`;
    
    // Update unlock message on landing view
    if (!isCompact) {
        const unlockedPriceEl = document.getElementById('unlocked-price');
        if (nextTier) {
            unlockedPriceEl.textContent = `Unlock $${nextTier.price} at ${nextTier.buyers} buyers`;
        } else {
            unlockedPriceEl.textContent = 'Max discount unlocked!';
        }
    }
}

// Update buyer count display
function updateBuyerCount() {
    const countElements = [
        document.getElementById('buyer-count'),
        document.getElementById('buyer-count-success')
    ];
    
    countElements.forEach(el => {
        if (el) el.textContent = config.currentBuyers.toLocaleString();
    });
}

// Start countdown timer
function startCountdown() {
    const endDate = new Date(config.countdownEnd);
    
    function updateTimer() {
        const now = new Date();
        const diff = endDate - now;
        
        const days = diff > 0 ? Math.floor(diff / (1000 * 60 * 60 * 24)) : 0;
        const hours = diff > 0 ? Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)) : 0;
        const minutes = diff > 0 ? Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)) : 0;
        const seconds = diff > 0 ? Math.floor((diff % (1000 * 60)) / 1000) : 0;
        
        // Update both countdowns (landing and success views)
        const ids = ['', '-landing'];
        ids.forEach(suffix => {
            const daysEl = document.getElementById(`days${suffix}`);
            const hoursEl = document.getElementById(`hours${suffix}`);
            const minutesEl = document.getElementById(`minutes${suffix}`);
            const secondsEl = document.getElementById(`seconds${suffix}`);
            
            if (daysEl) daysEl.textContent = days.toString().padStart(2, '0');
            if (hoursEl) hoursEl.textContent = hours.toString().padStart(2, '0');
            if (minutesEl) minutesEl.textContent = minutes.toString().padStart(2, '0');
            if (secondsEl) secondsEl.textContent = seconds.toString().padStart(2, '0');
        });
    }
    
    updateTimer();
    setInterval(updateTimer, 1000);
}

// Handle form submission
joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const phone = document.getElementById('phone').value;
    const email = document.getElementById('email').value;
    
    // Get referral code from URL if present
    referredBy = getReferralFromUrl();
    
    try {
        const response = await fetch('/api/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, email, referredBy })
        });
        
        if (response.ok) {
            const data = await response.json();
            userReferralCode = data.referralCode;
            
            // Keep video playing, switch views
            landingView.classList.add('hidden');
            successView.classList.remove('hidden');
            
            // Refresh data
            await loadConfig();
            renderProgressBar();
            updateBuyerCount();
            
            // Setup referral section
            setupReferralSection();
        } else if (response.status === 409) {
            // Duplicate phone number
            const data = await response.json();
            alert('This phone number has already joined this drop! Check your SMS for your referral link.');
        } else {
            alert('Something went wrong. Please try again.');
        }
    } catch (e) {
        console.error('Join error:', e);
        alert('Network error. Please try again.');
    }
});

// Store referrals needed
let referralsNeeded = 2;

// Setup referral section
function setupReferralSection() {
    // Set best price in UI
    const bestPrice = Math.min(...config.priceTiers.map(t => t.price));
    document.getElementById('best-price').textContent = bestPrice;
    document.getElementById('unlocked-price-value').textContent = bestPrice;
    document.getElementById('share-best-price').textContent = bestPrice;
    
    // Generate referral dots (will be updated when we get actual config from API)
    generateReferralDots(referralsNeeded);
    
    // Start polling for referral updates
    pollReferralStatus();
}

// Generate referral dots dynamically
function generateReferralDots(count) {
    const container = document.getElementById('referral-dots-container');
    container.innerHTML = '';
    
    for (let i = 0; i < count; i++) {
        const dot = document.createElement('span');
        dot.className = 'dot';
        dot.id = `dot-${i}`;
        container.appendChild(dot);
    }
}

// Poll for referral status
async function pollReferralStatus() {
    if (!userReferralCode) return;
    
    try {
        const response = await fetch(`/api/referral/${userReferralCode}`);
        const data = await response.json();
        
        updateReferralUI(data);
        
        // Continue polling if not unlocked yet
        if (!data.unlockedBestPrice) {
            setTimeout(pollReferralStatus, 5000); // Check every 5 seconds
        }
    } catch (e) {
        console.error('Referral poll error:', e);
    }
}

// Update referral UI
function updateReferralUI(data) {
    const progressEl = document.getElementById('referral-progress');
    const unlockedEl = document.getElementById('referral-unlocked');
    const countEl = document.getElementById('referral-count');
    
    // Update referrals needed from server
    referralsNeeded = data.referralsNeeded || 2;
    document.getElementById('referrals-needed-text').textContent = referralsNeeded;
    
    // Generate dots if count changed
    generateReferralDots(referralsNeeded);
    
    // Update dots
    for (let i = 0; i < referralsNeeded; i++) {
        const dot = document.getElementById(`dot-${i}`);
        if (dot && data.referralCount > i) {
            dot.classList.add('filled');
        }
    }
    
    // Update count text
    countEl.textContent = `${data.referralCount} of ${referralsNeeded} referral${referralsNeeded !== 1 ? 's' : ''}`;
    
    // Show unlocked state if achieved
    if (data.unlockedBestPrice) {
        progressEl.classList.add('hidden');
        unlockedEl.classList.remove('hidden');
        
        // Also update the price display to show best price
        document.getElementById('current-price-success').textContent = `$${data.bestPrice}`;
    }
}

// Share function (uses referral link if available)
function share() {
    shareReferral();
}

// Share referral with custom message
function shareReferral() {
    const shareUrl = userReferralCode 
        ? `${window.location.origin}${window.location.pathname}?ref=${userReferralCode}`
        : window.location.href;
    
    const shareData = {
        title: 'Join the Drop!',
        text: `join the drop with me so we can all save money💰 on this product - ${shareUrl}`,
        url: shareUrl
    };
    
    if (navigator.share) {
        navigator.share(shareData).catch(e => {
            // User cancelled or share failed
            console.log('Share cancelled:', e);
        });
    } else {
        // Fallback: copy to clipboard
        const fullMessage = `${shareData.text}`;
        navigator.clipboard.writeText(fullMessage).then(() => {
            const btn = document.getElementById('share-btn');
            const originalText = btn.innerHTML;
            btn.innerHTML = '<span>✓ Copied!</span>';
            setTimeout(() => {
                btn.innerHTML = originalText;
            }, 2000);
        });
    }
}

// Toggle product info
function toggleProductInfo() {
    const btn = document.getElementById('info-btn');
    const details = document.getElementById('product-details');
    
    if (details.classList.contains('expanded')) {
        details.classList.remove('expanded');
        btn.classList.remove('active');
    } else {
        details.classList.add('expanded');
        btn.classList.add('active');
    }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', init);
