// Group Buying App
let config = {};
let hls = null;
let userReferralCode = null;
let referredBy = null;
let referralsNeeded = 2;

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
    try {
        await loadConfig();
        initPlayer();
        renderProductInfo();
        renderProgressBar();
        startCountdown();
        updateBuyerCount();
    } catch (e) {
        console.error('Init error:', e);
    }
}

// Load config from "database"
async function loadConfig() {
    try {
        const response = await fetch('/api/config');
        config = await response.json();
        referralsNeeded = config.referralsNeeded || 2;
    } catch (e) {
        console.error('Failed to load config:', e);
        // Fallback defaults
        config = {
            initialBuyers: 500,
            initialPrice: 80,
            referralsNeeded: 2,
            priceTiers: [
                {buyers: 100, price: 40},
                {buyers: 500, price: 30},
                {buyers: 1000, price: 20}
            ],
            countdownEnd: '2026-02-20T14:00:00-05:00',
            videoSource: 'https://vod.estreamly.com/assets/994758e3-c35f-4e26-9512-1babf10b6207/HLS/jUVhs_DTuiA6FDuYM_720.m3u8',
            product: {
                image: '',
                name: '',
                description: ''
            }
        };
        config.currentBuyers = config.initialBuyers;
    }
}

// Initialize HLS Player
function initPlayer() {
    if (!config.videoSource) return;
    
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
    const buyers = config.currentBuyers || 0;
    let price = config.initialPrice || 80;
    
    for (const tier of config.priceTiers || []) {
        if (buyers >= tier.buyers) {
            price = tier.price;
        }
    }
    
    return price;
}

// Get next unlock tier
function getNextTier() {
    const buyers = config.currentBuyers || 0;
    
    for (const tier of config.priceTiers || []) {
        if (buyers < tier.buyers) {
            return tier;
        }
    }
    return null;
}

// Render product info
function renderProductInfo() {
    const product = config.product || {};
    
    // Landing view
    const landingImg = document.getElementById('product-img');
    if (landingImg) landingImg.src = product.image || '';
    
    const landingName = document.getElementById('product-name');
    if (landingName) landingName.textContent = product.name || '';
    
    // Success view
    const successImg = document.getElementById('product-img-success');
    if (successImg) successImg.src = product.image || '';
    
    const successName = document.getElementById('product-name-success');
    if (successName) successName.textContent = product.name || '';
    
    // Product details
    const detailsContent = document.getElementById('product-details-content');
    if (detailsContent && product.description) {
        detailsContent.innerHTML = product.description;
    }
}

// Render progress bar
function renderProgressBar() {
    if (!config.priceTiers || config.priceTiers.length === 0) return;
    
    const maxBuyers = Math.max(...config.priceTiers.map(t => t.buyers));
    const progress = Math.min(((config.currentBuyers || 0) / maxBuyers) * 100, 100);
    const currentPrice = getCurrentPrice();
    const nextTier = getNextTier();
    const initialPrice = config.initialPrice || 80;
    
    // Update landing view (simple mini bar)
    const landingBar = document.getElementById('progress-bar');
    if (landingBar) {
        landingBar.style.width = `${progress}%`;
    }
    
    // Update success view (full bar with markers)
    updateProgressDisplay('progress-bar-success', 'tier-markers-success', 'tier-labels-success', progress, currentPrice, initialPrice);
    
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

function updateProgressDisplay(barId, markersId, labelsId, progress, currentPrice, initialPrice) {
    const bar = document.getElementById(barId);
    const markers = document.getElementById(markersId);
    const labels = document.getElementById(labelsId);
    
    if (!bar || !markers || !labels) return;
    
    bar.style.width = `${progress}%`;
    
    markers.innerHTML = '';
    labels.innerHTML = '';
    
    const maxBuyers = Math.max(...config.priceTiers.map(t => t.buyers));
    
    config.priceTiers.forEach(tier => {
        const position = (tier.buyers / maxBuyers) * 100;
        const isUnlocked = (config.currentBuyers || 0) >= tier.buyers;
        
        const marker = document.createElement('div');
        marker.className = `tier-marker ${isUnlocked ? 'unlocked' : ''}`;
        marker.style.left = `${position}%`;
        markers.appendChild(marker);
        
        const label = document.createElement('div');
        label.className = 'tier-label';
        label.innerHTML = `
            <div class="tier-buyers">${tier.buyers}</div>
            <div class="tier-price">$${tier.price}</div>
        `;
        labels.appendChild(label);
    });
    
    const currentPriceEl = document.getElementById('current-price-success');
    const initialPriceEl = document.getElementById('initial-price-success');
    
    if (currentPriceEl) currentPriceEl.textContent = `$${currentPrice}`;
    if (initialPriceEl) initialPriceEl.textContent = `$${initialPrice}`;
}

// Update buyer count display
function updateBuyerCount() {
    const count = (config.currentBuyers || 0).toLocaleString();
    
    const countEl = document.getElementById('buyer-count');
    const countSuccessEl = document.getElementById('buyer-count-success');
    
    if (countEl) countEl.textContent = count;
    if (countSuccessEl) countSuccessEl.textContent = count;
}

// Start countdown timer
function startCountdown() {
    const endDate = new Date(config.countdownEnd);
    if (isNaN(endDate.getTime())) return;
    
    function updateTimer() {
        const now = new Date();
        const diff = endDate - now;
        
        const days = diff > 0 ? Math.floor(diff / (1000 * 60 * 60 * 24)) : 0;
        const hours = diff > 0 ? Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)) : 0;
        const minutes = diff > 0 ? Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)) : 0;
        const seconds = diff > 0 ? Math.floor((diff % (1000 * 60)) / 1000) : 0;
        
        updateCountdownDisplay(days, hours, minutes, seconds);
    }
    
    updateTimer();
    setInterval(updateTimer, 1000);
}

function updateCountdownDisplay(days, hours, minutes, seconds) {
    const pad = (n) => n.toString().padStart(2, '0');
    
    const daysLanding = document.getElementById('days-landing');
    const hoursLanding = document.getElementById('hours-landing');
    const minutesLanding = document.getElementById('minutes-landing');
    const secondsLanding = document.getElementById('seconds-landing');
    
    if (daysLanding) daysLanding.textContent = pad(days);
    if (hoursLanding) hoursLanding.textContent = pad(hours);
    if (minutesLanding) minutesLanding.textContent = pad(minutes);
    if (secondsLanding) secondsLanding.textContent = pad(seconds);
    
    const daysEl = document.getElementById('days');
    const hoursEl = document.getElementById('hours');
    const minutesEl = document.getElementById('minutes');
    const secondsEl = document.getElementById('seconds');
    
    if (daysEl) daysEl.textContent = pad(days);
    if (hoursEl) hoursEl.textContent = pad(hours);
    if (minutesEl) minutesEl.textContent = pad(minutes);
    if (secondsEl) secondsEl.textContent = pad(seconds);
}

// Handle form submission
joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const phone = document.getElementById('phone').value;
    const email = document.getElementById('email').value;
    
    // Basic validation
    const phoneDigits = phone.replace(/\D/g, '');
    if (phoneDigits.length < 10) {
        alert('Please enter a valid phone number');
        return;
    }
    
    if (!email.includes('@')) {
        alert('Please enter a valid email');
        return;
    }
    
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
            
            landingView.classList.add('hidden');
            successView.classList.remove('hidden');
            
            await loadConfig();
            renderProgressBar();
            updateBuyerCount();
            setupReferralSection();
        } else if (response.status === 409) {
            alert('This phone number has already joined this drop! Check your SMS for your referral link.');
        } else {
            const error = await response.json();
            alert(error.error || 'Something went wrong. Please try again.');
        }
    } catch (e) {
        console.error('Join error:', e);
        alert('Network error. Please try again.');
    }
});

// Setup referral section
function setupReferralSection() {
    const bestPrice = Math.min(...(config.priceTiers || []).map(t => t.price));
    
    const bestPriceEl = document.getElementById('best-price');
    const unlockedPriceValueEl = document.getElementById('unlocked-price-value');
    const shareBestPriceEl = document.getElementById('share-best-price');
    const referralsNeededTextEl = document.getElementById('referrals-needed-text');
    
    if (bestPriceEl) bestPriceEl.textContent = bestPrice;
    if (unlockedPriceValueEl) unlockedPriceValueEl.textContent = bestPrice;
    if (shareBestPriceEl) shareBestPriceEl.textContent = bestPrice;
    if (referralsNeededTextEl) referralsNeededTextEl.textContent = referralsNeeded;
    
    generateReferralDots(referralsNeeded);
    pollReferralStatus();
}

// Generate referral dots dynamically
function generateReferralDots(count) {
    const container = document.getElementById('referral-dots-container');
    if (!container) return;
    
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
        
        referralsNeeded = data.referralsNeeded || 2;
        updateReferralUI(data);
        
        if (!data.unlockedBestPrice) {
            setTimeout(pollReferralStatus, 5000);
        }
    } catch (e) {
        console.error('Referral poll error:', e);
        setTimeout(pollReferralStatus, 10000);
    }
}

// Update referral UI
function updateReferralUI(data) {
    const progressEl = document.getElementById('referral-progress');
    const unlockedEl = document.getElementById('referral-unlocked');
    const countEl = document.getElementById('referral-count');
    const referralsNeededTextEl = document.getElementById('referrals-needed-text');
    
    if (referralsNeededTextEl) referralsNeededTextEl.textContent = referralsNeeded;
    
    generateReferralDots(referralsNeeded);
    
    for (let i = 0; i < referralsNeeded; i++) {
        const dot = document.getElementById(`dot-${i}`);
        if (dot && data.referralCount > i) {
            dot.classList.add('filled');
        }
    }
    
    if (countEl) {
        const plural = referralsNeeded !== 1 ? 's' : '';
        countEl.textContent = `${data.referralCount} of ${referralsNeeded} referral${plural}`;
    }
    
    if (data.unlockedBestPrice && progressEl && unlockedEl) {
        progressEl.classList.add('hidden');
        unlockedEl.classList.remove('hidden');
        
        const currentPriceSuccessEl = document.getElementById('current-price-success');
        if (currentPriceSuccessEl) currentPriceSuccessEl.textContent = `$${data.bestPrice}`;
    }
}

// Share function
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
        navigator.share(shareData).catch(e => console.log('Share cancelled:', e));
    } else {
        navigator.clipboard.writeText(shareData.text).then(() => {
            const btn = document.getElementById('share-btn');
            if (btn) {
                btn.innerHTML = '<span>✓ Copied!</span>';
                setTimeout(() => {
                    btn.innerHTML = '<span>📤 Share with friends</span>';
                }, 2000);
            }
        });
    }
}

// Toggle product info
function toggleProductInfo() {
    const btn = document.getElementById('info-btn');
    const details = document.getElementById('product-details');
    
    if (!btn || !details) return;
    
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
