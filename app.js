// Group Buying App - Multi-Campaign Support
let config = {};
let hls = null;
let userReferralCode = null;
let referredBy = null;
let referralsNeeded = 2;
let currentCampaignId = null;

function getReferralFromUrl() {
    return new URLSearchParams(window.location.search).get('ref');
}

const video = document.getElementById('video-player');
const loading = document.getElementById('loading');
const landingView = document.getElementById('landing-view');
const successView = document.getElementById('success-view');
const joinForm = document.getElementById('join-form');

async function init() {
    try {
        const campaignResult = await CampaignLoader.loadCampaignFromUrl();
        if (!campaignResult.success) {
            console.error('Campaign load error:', campaignResult.error);
            CampaignLoader.showCampaignError(campaignResult);
            return;
        }
        
        currentCampaignId = campaignResult.campaign.id;
        config = CampaignLoader.toLegacyConfig(campaignResult.campaign);
        config.campaignId = currentCampaignId;
        referralsNeeded = config.referralsNeeded || 2;
        
        initPlayer();
        renderProductInfo();
        updateTermsLink();
        renderProgressBar();
        startCountdown();
        updateBuyerCount();
        updateMerchantInfo();
        
        // Load real-time data from server
        await loadConfig();
        updateBuyerCount();
        renderProgressBar();
        
        console.log('Campaign loaded:', currentCampaignId, campaignResult.campaign.productName);
    } catch (e) {
        console.error('Init error:', e);
        showGenericError('Failed to initialize. Please try again later.');
    }
}

function showGenericError(message) {
    const container = document.querySelector('.container') || document.body;
    container.innerHTML = `
        <div style="padding: 40px 20px; text-align: center; max-width: 500px; margin: 0 auto;">
            <div style="font-size: 48px; margin-bottom: 16px;">⚠️</div>
            <h1 style="color: #fff; margin-bottom: 12px;">Something went wrong</h1>
            <p style="color: #aaa;">${message}</p>
            <button onclick="location.reload()" style="margin-top: 24px; padding: 12px 24px; background: linear-gradient(135deg, #FF4D8F, #FF8F4D); border: none; border-radius: 8px; color: white; font-weight: 600; cursor: pointer;">Try Again</button>
        </div>`;
}

function updateMerchantInfo() {
    const campaign = CampaignLoader.getCurrentCampaign();
    if (!campaign) return;
    document.title = `${campaign.productName} - Group Buying | eStreamly`;
}

async function loadConfig() {
    try {
        const response = await fetch(`/api/campaign/${currentCampaignId}/config?t=${Date.now()}`);
        if (!response.ok) throw new Error('Failed to load config');
        const serverConfig = await response.json();
        config.currentBuyers = serverConfig.currentBuyers || config.initialBuyers || 500;
        config.referralsNeeded = serverConfig.referralsNeeded || config.referralsNeeded || 2;
        referralsNeeded = config.referralsNeeded;
        
        // Recalculate current price and discount based on updated buyer count
        recalculateDiscount();
    } catch (e) {
        console.error('Failed to load config:', e);
        try {
            const response = await fetch(`/api/campaign/${currentCampaignId}/buyers?t=${Date.now()}`);
            if (response.ok) {
                const data = await response.json();
                config.currentBuyers = data.currentBuyers || config.initialBuyers || 500;
                recalculateDiscount();
            }
        } catch (err) {
            console.log('Using initial buyer count:', config.initialBuyers);
        }
    }
}

function recalculateDiscount() {
    const initialPrice = config.initialPrice || 80;
    let currentPrice = initialPrice;
    
    // Find current price based on buyer count
    for (const tier of config.priceTiers || []) {
        if ((config.currentBuyers || 0) >= tier.buyers) {
            currentPrice = tier.price;
        }
    }
    
    config.currentPrice = currentPrice;
    config.discountPercentage = initialPrice > 0 
        ? Math.round(((initialPrice - currentPrice) / initialPrice) * 100) 
        : 0;
}

function initPlayer() {
    if (!config.videoSource) return;
    loading.classList.add('active');
    video.muted = false;
    video.autoplay = true;
    video.loop = true;
    
    const attemptPlay = () => { video.play().catch(e => console.log('Autoplay prevented:', e)); };
    
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = config.videoSource;
        video.addEventListener('loadedmetadata', () => { loading.classList.remove('active'); attemptPlay(); });
    } else if (Hls.isSupported()) {
        hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60, enableWorker: true });
        hls.loadSource(config.videoSource);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => { loading.classList.remove('active'); attemptPlay(); });
        hls.on(Hls.Events.ERROR, (event, data) => { console.error('HLS Error:', data); if (data.fatal) loading.textContent = 'Error loading video'; });
    } else {
        loading.textContent = 'Browser not supported';
    }
}

function getCurrentPrice() {
    const buyers = config.currentBuyers || 0;
    let price = config.initialPrice || 80;
    for (const tier of config.priceTiers || []) {
        if (buyers >= tier.buyers) price = tier.price;
    }
    return price;
}

function getNextTier() {
    const buyers = config.currentBuyers || 0;
    for (const tier of config.priceTiers || []) {
        if (buyers < tier.buyers) return tier;
    }
    return null;
}

function renderProductInfo() {
    const product = config.product || {};
    const campaign = CampaignLoader.getCurrentCampaign();
    
    const landingImg = document.getElementById('product-img');
    if (landingImg) landingImg.src = product.image || '';
    
    const landingName = document.getElementById('product-name');
    if (landingName) landingName.textContent = product.name || '';
    
    const successImg = document.getElementById('product-img-success');
    if (successImg) successImg.src = product.image || '';
    
    const successName = document.getElementById('product-name-success');
    if (successName) successName.textContent = product.name || '';
    
    const detailsContent = document.getElementById('product-details-content');
    if (detailsContent && product.description) {
        // Sanitize HTML to prevent XSS attacks
        const cleanDescription = DOMPurify.sanitize(product.description);
        detailsContent.innerHTML = cleanDescription;
    }
    
    // Display discount percentage - recalculate based on current buyers, then display
    recalculateDiscount();
    const discountPercentage = config.discountPercentage || 0;
    if (discountPercentage > 0) {
        const discountBadge = document.querySelector('.discount-badge') || createDiscountBadge();
        discountBadge.textContent = `-${discountPercentage}%`;
    }
}

function createDiscountBadge() {
    const badge = document.createElement('span');
    badge.className = 'discount-badge';
    badge.style.cssText = 'background: linear-gradient(135deg, #FF4D8F, #FF8F4D); color: white; padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 14px; margin-left: 10px;';
    const priceTag = document.querySelector('.price-tag');
    if (priceTag) priceTag.appendChild(badge);
    return badge;
}

function renderProgressBar() {
    if (!config.priceTiers || config.priceTiers.length === 0) return;
    
    const maxBuyers = Math.max(...config.priceTiers.map(t => t.buyers));
    const progress = Math.min(((config.currentBuyers || 0) / maxBuyers) * 100, 100);
    const currentPrice = getCurrentPrice();
    const nextTier = getNextTier();
    const initialPrice = config.initialPrice || 80;
    
    // Update discount badge based on current price
    recalculateDiscount();
    const discountBadge = document.querySelector('.discount-badge') || createDiscountBadge();
    if (discountBadge && config.discountPercentage > 0) {
        discountBadge.textContent = `-${config.discountPercentage}%`;
    }
    
    const landingBar = document.getElementById('progress-bar');
    if (landingBar) landingBar.style.width = `${progress}%`;
    
    updateProgressDisplay('progress-bar-success', 'tier-markers-success', 'tier-labels-success', progress, currentPrice, initialPrice);
    
    const currentPriceEl = document.getElementById('current-price');
    const initialPriceEl = document.getElementById('initial-price');
    if (currentPriceEl) currentPriceEl.textContent = `$${currentPrice}`;
    if (initialPriceEl) initialPriceEl.textContent = `$${initialPrice}`;
    
    const unlockedText = document.getElementById('unlocked-price');
    if (unlockedText) {
        if (nextTier) {
            const nextDiscount = Math.round(((initialPrice - nextTier.price) / initialPrice) * 100);
            unlockedText.innerHTML = `🔓 Unlock $${nextTier.price} at ${nextTier.buyers} buyers! <strong style="color: #FF4D8F;">That's ${nextDiscount}% OFF!</strong>`;
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
        label.innerHTML = `<div class="tier-buyers">${tier.buyers}</div><div class="tier-price">$${tier.price}</div>`;
        labels.appendChild(label);
    });
    
    const currentPriceSuccessEl = document.getElementById('current-price-success');
    const initialPriceSuccessEl = document.getElementById('initial-price-success');
    if (currentPriceSuccessEl) currentPriceSuccessEl.textContent = `$${currentPrice}`;
    if (initialPriceSuccessEl) initialPriceSuccessEl.textContent = `$${initialPrice}`;
}

function updateBuyerCount() {
    const count = (config.currentBuyers || config.initialBuyers || 0).toLocaleString();
    const countEl = document.getElementById('buyer-count');
    const countSuccessEl = document.getElementById('buyer-count-success');
    if (countEl) countEl.textContent = count;
    if (countSuccessEl) countSuccessEl.textContent = count;
}

function startCountdown() {
    const endDate = new Date(config.countdownEnd);
    if (isNaN(endDate.getTime())) return;
    
    function updateTimer() {
        const diff = endDate - new Date();
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

joinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    
    const phone = document.getElementById('phone').value;
    const email = document.getElementById('email').value;
    
    if (phone.replace(/\D/g, '').length < 10) { alert('Please enter a valid phone number'); return; }
    if (!email.includes('@')) { alert('Please enter a valid email'); return; }
    
    referredBy = getReferralFromUrl();
    
    try {
        const response = await fetch('/api/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ phone, email, referredBy, campaignId: currentCampaignId })
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

function setupReferralSection() {
    const tiers = config.priceTiers || [];
    const bestPrice = tiers.length > 0 ? Math.min(...tiers.map(t => t.price)) : 20;
    
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

async function pollReferralStatus() {
    if (!userReferralCode) return;
    try {
        const response = await fetch(`/api/referral/${userReferralCode}?campaignId=${currentCampaignId}`);
        const data = await response.json();
        referralsNeeded = data.referralsNeeded || 2;
        updateReferralUI(data);
        if (!data.unlockedBestPrice) setTimeout(pollReferralStatus, 5000);
    } catch (e) {
        console.error('Referral poll error:', e);
        setTimeout(pollReferralStatus, 10000);
    }
}

function updateReferralUI(data) {
    const progressEl = document.getElementById('referral-progress');
    const unlockedEl = document.getElementById('referral-unlocked');
    const countEl = document.getElementById('referral-count');
    const referralsNeededTextEl = document.getElementById('referrals-needed-text');
    
    if (referralsNeededTextEl) referralsNeededTextEl.textContent = referralsNeeded;
    generateReferralDots(referralsNeeded);
    
    for (let i = 0; i < referralsNeeded; i++) {
        const dot = document.getElementById(`dot-${i}`);
        if (dot && data.referralCount > i) dot.classList.add('filled');
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

function shareReferral() {
    const shareUrl = userReferralCode 
        ? `${window.location.origin}${window.location.pathname}?v=${currentCampaignId}&ref=${userReferralCode}`
        : `${window.location.origin}${window.location.pathname}?v=${currentCampaignId}`;
    
    const shareData = { title: 'Join the Drop!', text: `Join the drop with me so we can all save money💰 - ${shareUrl}`, url: shareUrl };
    
    if (navigator.share) {
        navigator.share(shareData).catch(e => console.log('Share cancelled:', e));
    } else {
        navigator.clipboard.writeText(shareData.text).then(() => {
            const btn = document.getElementById('share-btn');
            if (btn) {
                btn.innerHTML = '<span>✓ Copied!</span>';
                setTimeout(() => btn.innerHTML = '<span>📤 Share with friends</span>', 2000);
            }
        });
    }
}

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

function updateTermsLink() {
    const termsLink = document.getElementById('terms-link');
    const termsCompliance = document.querySelector('.terms-compliance');
    
    if (!termsLink) return;

    // Always show T&C compliance text
    if (termsCompliance) {
        termsCompliance.style.display = 'block';
    }
    
    // Use client termsUrl if set, otherwise default to /terms.html
    termsLink.href = config.termsUrl || '/terms.html';
}

document.addEventListener('DOMContentLoaded', init);
