/**
 * Group Buying App - Refactored Frontend
 * Features: Modular design, error boundaries, memory management, validation
 */

// ============================================
// CONFIGURATION & STATE
// ============================================
const AppState = {
    config: null,
    hls: null,
    userReferralCode: null,
    referredBy: null,
    referralsNeeded: 2,
    countdownInterval: null,
    pollTimeout: null,
    elements: {} // Cached DOM elements
};

// ============================================
// DOM CACHE - Cache frequently accessed elements
// ============================================
function cacheElements() {
    AppState.elements = {
        video: document.getElementById('video-player'),
        loading: document.getElementById('loading'),
        landingView: document.getElementById('landing-view'),
        successView: document.getElementById('success-view'),
        joinForm: document.getElementById('join-form'),
        productImg: document.getElementById('product-img'),
        productName: document.getElementById('product-name'),
        productImgSuccess: document.getElementById('product-img-success'),
        productNameSuccess: document.getElementById('product-name-success'),
        progressBar: document.getElementById('progress-bar'),
        progressBarSuccess: document.getElementById('progress-bar-success'),
        tierMarkersSuccess: document.getElementById('tier-markers-success'),
        tierLabelsSuccess: document.getElementById('tier-labels-success'),
        currentPrice: document.getElementById('current-price'),
        currentPriceSuccess: document.getElementById('current-price-success'),
        initialPrice: document.getElementById('initial-price'),
        initialPriceSuccess: document.getElementById('initial-price-success'),
        unlockedPrice: document.getElementById('unlocked-price'),
        buyerCount: document.getElementById('buyer-count'),
        buyerCountSuccess: document.getElementById('buyer-count-success'),
        referralDotsContainer: document.getElementById('referral-dots-container'),
        referralCount: document.getElementById('referral-count'),
        referralsNeededText: document.getElementById('referrals-needed-text'),
        bestPrice: document.getElementById('best-price'),
        unlockedPriceValue: document.getElementById('unlocked-price-value'),
        shareBestPrice: document.getElementById('share-best-price'),
        referralProgress: document.getElementById('referral-progress'),
        referralUnlocked: document.getElementById('referral-unlocked'),
        daysLanding: document.getElementById('days-landing'),
        hoursLanding: document.getElementById('hours-landing'),
        minutesLanding: document.getElementById('minutes-landing'),
        secondsLanding: document.getElementById('seconds-landing'),
        days: document.getElementById('days'),
        hours: document.getElementById('hours'),
        minutes: document.getElementById('minutes'),
        seconds: document.getElementById('seconds')
    };
}

// ============================================
// ERROR HANDLING
// ============================================
class AppError extends Error {
    constructor(message, type = 'general') {
        super(message);
        this.type = type;
    }
}

function handleError(error, context = '') {
    console.error(`[${context}] Error:`, error);
    
    // User-friendly error messages
    const userMessage = error instanceof AppError 
        ? error.message 
        : 'Something went wrong. Please try again.';
    
    // Don't show alert for network polling errors
    if (context !== 'poll') {
        alert(userMessage);
    }
}

// ============================================
// VALIDATION
// ============================================
const Validation = {
    phone: (phone) => {
        const normalized = phone.replace(/\D/g, '');
        return normalized.length >= 10 && normalized.length <= 15;
    },
    
    email: (email) => {
        return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    }
};

// ============================================
// API CLIENT
// ============================================
const API = {
    async fetch(url, options = {}) {
        try {
            const response = await fetch(url, {
                ...options,
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                }
            });
            
            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: 'Unknown error' }));
                throw new AppError(error.error || `HTTP ${response.status}`, 'api');
            }
            
            return response.json();
        } catch (error) {
            if (error instanceof AppError) throw error;
            throw new AppError('Network error. Please check your connection.', 'network');
        }
    },
    
    getConfig() {
        return this.fetch('/api/config');
    },
    
    join(phone, email, referredBy) {
        return this.fetch('/api/join', {
            method: 'POST',
            body: JSON.stringify({ phone, email, referredBy })
        });
    },
    
    getReferralStatus(referralCode) {
        return this.fetch(`/api/referral/${referralCode}`);
    }
};

// ============================================
// VIDEO PLAYER
// ============================================
const VideoPlayer = {
    init() {
        const { video, loading } = AppState.elements;
        if (!video || !AppState.config?.videoSource) return;
        
        loading.classList.add('active');
        
        // Configure video
        video.muted = true;
        video.autoplay = true;
        video.loop = true;
        
        const attemptPlay = () => {
            video.play().catch(e => console.log('[Video] Autoplay prevented:', e));
        };
        
        // Native HLS support (Safari)
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = AppState.config.videoSource;
            video.addEventListener('loadedmetadata', () => {
                loading.classList.remove('active');
                attemptPlay();
            }, { once: true });
        } 
        // hls.js for other browsers
        else if (window.Hls?.isSupported()) {
            AppState.hls = new Hls({
                maxBufferLength: 30,
                maxMaxBufferLength: 60,
                enableWorker: true
            });
            
            AppState.hls.loadSource(AppState.config.videoSource);
            AppState.hls.attachMedia(video);
            
            AppState.hls.on(Hls.Events.MANIFEST_PARSED, () => {
                loading.classList.remove('active');
                attemptPlay();
            });
            
            AppState.hls.on(Hls.Events.ERROR, (event, data) => {
                console.error('[Video] HLS Error:', data);
                if (data.fatal) {
                    loading.textContent = 'Error loading video';
                }
            });
        } else {
            loading.textContent = 'Browser not supported';
        }
    },
    
    destroy() {
        if (AppState.hls) {
            AppState.hls.destroy();
            AppState.hls = null;
        }
    }
};

// ============================================
// UI RENDERERS
// ============================================
const Renderers = {
    product() {
        const { config } = AppState;
        const product = config.product || {};
        
        if (AppState.elements.productImg) {
            AppState.elements.productImg.src = product.image || '';
        }
        if (AppState.elements.productName) {
            AppState.elements.productName.textContent = product.name || '';
        }
        if (AppState.elements.productImgSuccess) {
            AppState.elements.productImgSuccess.src = product.image || '';
        }
        if (AppState.elements.productNameSuccess) {
            AppState.elements.productNameSuccess.textContent = product.name || '';
        }
        
        // Load product details into expandable section
        const detailsContent = document.getElementById('product-details-content');
        if (detailsContent && product.description) {
            // Check if description contains HTML/list items
            if (product.description.includes('<') || product.description.includes('-')) {
                detailsContent.innerHTML = product.description;
            } else {
                detailsContent.innerHTML = `<h4>Product Details</h4><p>${product.description}</p>`;
            }
        }
    },
    
    progressBar() {
        const { config } = AppState;
        if (!config?.priceTiers?.length) return;
        
        const maxBuyers = Math.max(...config.priceTiers.map(t => t.buyers));
        const currentBuyers = config.currentBuyers || 0;
        const progress = Math.min((currentBuyers / maxBuyers) * 100, 100);
        
        // Calculate current price
        let currentPrice = config.initialPrice || 80;
        for (const tier of config.priceTiers) {
            if (currentBuyers >= tier.buyers) {
                currentPrice = tier.price;
            }
        }
        
        // Update landing view
        if (AppState.elements.progressBar) {
            AppState.elements.progressBar.style.width = `${progress}%`;
        }
        if (AppState.elements.currentPrice) {
            AppState.elements.currentPrice.textContent = `$${currentPrice}`;
        }
        if (AppState.elements.initialPrice) {
            AppState.elements.initialPrice.textContent = `$${config.initialPrice || 80}`;
        }
        
        // Find next tier
        const nextTier = config.priceTiers.find(t => currentBuyers < t.buyers);
        if (AppState.elements.unlockedPrice) {
            AppState.elements.unlockedPrice.textContent = nextTier 
                ? `🔓 Unlock $${nextTier.price} at ${nextTier.buyers} buyers`
                : '✅ Max discount unlocked!';
        }
        
        // Update success view
        this.renderProgressWithTiers(progress, currentPrice, config);
        
        // Update buyer counts
        const countText = currentBuyers.toLocaleString();
        if (AppState.elements.buyerCount) {
            AppState.elements.buyerCount.textContent = countText;
        }
        if (AppState.elements.buyerCountSuccess) {
            AppState.elements.buyerCountSuccess.textContent = countText;
        }
    },
    
    renderProgressWithTiers(progress, currentPrice, config) {
        const { progressBarSuccess, tierMarkersSuccess, tierLabelsSuccess, 
                currentPriceSuccess, initialPriceSuccess } = AppState.elements;
        
        if (!progressBarSuccess || !tierMarkersSuccess || !tierLabelsSuccess) return;
        
        progressBarSuccess.style.width = `${progress}%`;
        
        // Clear and rebuild markers/labels
        tierMarkersSuccess.innerHTML = '';
        tierLabelsSuccess.innerHTML = '';
        
        const maxBuyers = Math.max(...config.priceTiers.map(t => t.buyers));
        const currentBuyers = config.currentBuyers || 0;
        
        config.priceTiers.forEach(tier => {
            const position = (tier.buyers / maxBuyers) * 100;
            const isUnlocked = currentBuyers >= tier.buyers;
            
            // Marker
            const marker = document.createElement('div');
            marker.className = `tier-marker ${isUnlocked ? 'unlocked' : ''}`;
            marker.style.left = `${position}%`;
            tierMarkersSuccess.appendChild(marker);
            
            // Label
            const label = document.createElement('div');
            label.className = 'tier-label';
            label.innerHTML = `
                <div class="tier-buyers">${tier.buyers}</div>
                <div class="tier-price">$${tier.price}</div>
            `;
            tierLabelsSuccess.appendChild(label);
        });
        
        if (currentPriceSuccess) {
            currentPriceSuccess.textContent = `$${currentPrice}`;
        }
        if (initialPriceSuccess) {
            initialPriceSuccess.textContent = `$${config.initialPrice || 80}`;
        }
    },
    
    referralDots(count) {
        const container = AppState.elements.referralDotsContainer;
        if (!container) return;
        
        container.innerHTML = '';
        for (let i = 0; i < count; i++) {
            const dot = document.createElement('span');
            dot.className = 'dot';
            dot.id = `dot-${i}`;
            container.appendChild(dot);
        }
    },
    
    referralStatus(data) {
        const { referralProgress, referralUnlocked, referralCount, 
                referralsNeededText, bestPrice, unlockedPriceValue } = AppState.elements;
        
        if (!referralProgress || !referralUnlocked) return;
        
        // Update config from server
        AppState.referralsNeeded = data.referralsNeeded || 2;
        
        if (referralsNeededText) {
            referralsNeededText.textContent = AppState.referralsNeeded;
        }
        
        // Regenerate dots if needed
        this.referralDots(AppState.referralsNeeded);
        
        // Update dots
        for (let i = 0; i < AppState.referralsNeeded; i++) {
            const dot = document.getElementById(`dot-${i}`);
            if (dot && data.referralCount > i) {
                dot.classList.add('filled');
            }
        }
        
        // Update count text
        if (referralCount) {
            const plural = AppState.referralsNeeded !== 1 ? 's' : '';
            referralCount.textContent = `${data.referralCount} of ${AppState.referralsNeeded} referral${plural}`;
        }
        
        // Show unlocked state
        if (data.unlockedBestPrice) {
            referralProgress.classList.add('hidden');
            referralUnlocked.classList.remove('hidden');
            
            if (AppState.elements.currentPriceSuccess) {
                AppState.elements.currentPriceSuccess.textContent = `$${data.bestPrice}`;
            }
        }
    }
};

// ============================================
// COUNTDOWN TIMER
// ============================================
const Countdown = {
    start() {
        this.stop(); // Clear any existing interval
        
        const endDate = new Date(AppState.config?.countdownEnd);
        if (isNaN(endDate.getTime())) return;
        
        const update = () => {
            const now = new Date();
            const diff = endDate - now;
            
            const days = diff > 0 ? Math.floor(diff / (1000 * 60 * 60 * 24)) : 0;
            const hours = diff > 0 ? Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60)) : 0;
            const minutes = diff > 0 ? Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60)) : 0;
            const seconds = diff > 0 ? Math.floor((diff % (1000 * 60)) / 1000) : 0;
            
            this.updateDisplay(days, hours, minutes, seconds);
        };
        
        update();
        AppState.countdownInterval = setInterval(update, 1000);
    },
    
    stop() {
        if (AppState.countdownInterval) {
            clearInterval(AppState.countdownInterval);
            AppState.countdownInterval = null;
        }
    },
    
    updateDisplay(days, hours, minutes, seconds) {
        const pad = (n) => n.toString().padStart(2, '0');
        
        // Landing view
        if (AppState.elements.daysLanding) AppState.elements.daysLanding.textContent = pad(days);
        if (AppState.elements.hoursLanding) AppState.elements.hoursLanding.textContent = pad(hours);
        if (AppState.elements.minutesLanding) AppState.elements.minutesLanding.textContent = pad(minutes);
        if (AppState.elements.secondsLanding) AppState.elements.secondsLanding.textContent = pad(seconds);
        
        // Success view
        if (AppState.elements.days) AppState.elements.days.textContent = pad(days);
        if (AppState.elements.hours) AppState.elements.hours.textContent = pad(hours);
        if (AppState.elements.minutes) AppState.elements.minutes.textContent = pad(minutes);
        if (AppState.elements.seconds) AppState.elements.seconds.textContent = pad(seconds);
    }
};

// ============================================
// REFERRAL POLLING
// ============================================
const ReferralPoller = {
    start() {
        if (!AppState.userReferralCode) return;
        
        const poll = async () => {
            try {
                const data = await API.getReferralStatus(AppState.userReferralCode);
                Renderers.referralStatus(data);
                
                // Continue polling if not unlocked
                if (!data.unlockedBestPrice) {
                    AppState.pollTimeout = setTimeout(poll, 5000);
                }
            } catch (error) {
                handleError(error, 'poll');
                // Retry on error
                AppState.pollTimeout = setTimeout(poll, 10000);
            }
        };
        
        poll();
    },
    
    stop() {
        if (AppState.pollTimeout) {
            clearTimeout(AppState.pollTimeout);
            AppState.pollTimeout = null;
        }
    }
};

// ============================================
// FORM HANDLING
// ============================================
async function handleJoinSubmit(e) {
    e.preventDefault();
    
    const phoneInput = document.getElementById('phone');
    const emailInput = document.getElementById('email');
    
    const phone = phoneInput?.value?.trim();
    const email = emailInput?.value?.trim();
    
    // Validate
    if (!Validation.phone(phone)) {
        alert('Please enter a valid phone number');
        phoneInput?.focus();
        return;
    }
    
    if (!Validation.email(email)) {
        alert('Please enter a valid email address');
        emailInput?.focus();
        return;
    }
    
    // Show loading state
    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn?.textContent;
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Joining...';
    }
    
    try {
        const referredBy = new URLSearchParams(window.location.search).get('ref');
        const data = await API.join(phone, email, referredBy);
        
        AppState.userReferralCode = data.referralCode;
        
        // Switch views
        if (AppState.elements.landingView) {
            AppState.elements.landingView.classList.add('hidden');
        }
        if (AppState.elements.successView) {
            AppState.elements.successView.classList.remove('hidden');
        }
        
        // Refresh and setup
        await initialize();
        setupReferralSection();
        
    } catch (error) {
        if (error.message?.includes('already registered')) {
            alert('This phone number has already joined this drop! Check your SMS for your referral link.');
        } else {
            handleError(error, 'join');
        }
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = originalText;
        }
    }
}

// ============================================
// SETUP FUNCTIONS
// ============================================
function setupReferralSection() {
    if (!AppState.config?.priceTiers?.length) return;
    
    const bestPrice = Math.min(...AppState.config.priceTiers.map(t => t.price));
    
    if (AppState.elements.bestPrice) {
        AppState.elements.bestPrice.textContent = bestPrice;
    }
    if (AppState.elements.unlockedPriceValue) {
        AppState.elements.unlockedPriceValue.textContent = bestPrice;
    }
    if (AppState.elements.shareBestPrice) {
        AppState.elements.shareBestPrice.textContent = bestPrice;
    }
    
    Renderers.referralDots(AppState.referralsNeeded);
    ReferralPoller.start();
}

function setupEventListeners() {
    // Join form
    if (AppState.elements.joinForm) {
        AppState.elements.joinForm.addEventListener('submit', handleJoinSubmit);
    }
}

// ============================================
// PUBLIC API
// ============================================
window.shareReferral = function() {
    const shareUrl = AppState.userReferralCode 
        ? `${window.location.origin}${window.location.pathname}?ref=${AppState.userReferralCode}`
        : window.location.href;
    
    const shareData = {
        title: 'Join the Drop!',
        text: `Join the drop with me so we can all save money💰 on this product - ${shareUrl}`,
        url: shareUrl
    };
    
    if (navigator.share) {
        navigator.share(shareData).catch(e => {
            console.log('[Share] Cancelled:', e);
        });
    } else {
        navigator.clipboard.writeText(shareData.text).then(() => {
            const btn = document.getElementById('share-btn');
            if (btn) {
                const original = btn.innerHTML;
                btn.innerHTML = '<span>✓ Copied!</span>';
                setTimeout(() => btn.innerHTML = original, 2000);
            }
        });
    }
};

window.toggleProductInfo = function() {
    const btn = document.getElementById('info-btn');
    const details = document.getElementById('product-details');
    
    if (!btn || !details) return;
    
    const isExpanded = details.classList.contains('expanded');
    details.classList.toggle('expanded', !isExpanded);
    btn.classList.toggle('active', !isExpanded);
};

// ============================================
// INITIALIZATION
// ============================================
async function initialize() {
    try {
        AppState.config = await API.getConfig();
        AppState.referralsNeeded = AppState.config.referralsNeeded || 2;
        
        Renderers.product();
        Renderers.progressBar();
        Countdown.start();
        
    } catch (error) {
        handleError(error, 'init');
    }
}

// ============================================
// LIFECYCLE
// ============================================
function init() {
    cacheElements();
    setupEventListeners();
    VideoPlayer.init();
    initialize();
}

function cleanup() {
    Countdown.stop();
    ReferralPoller.stop();
    VideoPlayer.destroy();
}

// Start app
document.addEventListener('DOMContentLoaded', init);

// Cleanup on page unload
window.addEventListener('beforeunload', cleanup);
