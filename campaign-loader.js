/**
 * Campaign Loader Module
 * Handles loading campaign data per campaign ID via the public API
 */

const CampaignLoader = (function() {
    const cache = new Map(); // { campaignId: { data, timestamp } }
    let currentCampaign = null;
    const CACHE_TTL = 30000; // 30 seconds cache TTL
    
    function generateCampaignId() {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
        const length = 11;
        let result = '';
        if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
            const randomValues = new Uint8Array(length);
            crypto.getRandomValues(randomValues);
            for (let i = 0; i < length; i++) result += chars[randomValues[i] % chars.length];
        } else {
            for (let i = 0; i < length; i++) result += chars[Math.floor(Math.random() * chars.length)];
        }
        return result;
    }
    
    function getCampaignIdFromUrl() {
        return new URLSearchParams(window.location.search).get('v');
    }
    
    async function fetchCampaignFromServer(campaignId, { bypassCache = false } = {}) {
        if (!campaignId) return null;
        const now = Date.now();
        if (!bypassCache && cache.has(campaignId)) {
            const cached = cache.get(campaignId);
            if ((now - cached.timestamp) < CACHE_TTL) {
                return cached.data;
            }
        }

        const url = `/api/public/campaign/${campaignId}?t=${now}`;
        const response = await fetch(url, { credentials: 'same-origin' });
        if (!response.ok) {
            throw new Error(`Failed to load campaign ${campaignId}: ${response.status}`);
        }
        const payload = await response.json();
        const campaign = payload?.campaign || payload;
        if (!campaign || !campaign.id) {
            throw new Error('Campaign payload missing required fields');
        }
        cache.set(campaignId, { data: campaign, timestamp: now });
        return campaign;
    }

    async function loadCampaign(campaignId) {
        if (!campaignId) return { success: false, error: 'No campaign ID provided' };
        try {
            const campaign = await fetchCampaignFromServer(campaignId);
            currentCampaign = { id: campaign.id, ...campaign };
            return { success: true, campaign: currentCampaign };
        } catch (error) {
            console.error('CampaignLoader: Error loading campaign:', error);
            const cached = cache.get(campaignId);
            if (cached) {
                console.log('CampaignLoader: Using cached campaign data');
                currentCampaign = cached.data;
                return { success: true, campaign: currentCampaign, stale: true };
            }
            return { success: false, error: error.message, campaignId };
        }
    }
    
    async function loadCampaignFromUrl() {
        return await loadCampaign(getCampaignIdFromUrl());
    }
    
    function getCurrentCampaign() {
        return currentCampaign;
    }
    
    function toLegacyConfig(campaign) {
        if (!campaign) return null;
        const pricing = campaign.pricing || {};
        const initialBuyers = pricing.initialBuyers || campaign.initialBuyers || 500;
        const initialPrice = pricing.initialPrice || campaign.originalPrice || 80;
        const priceTiers = pricing.tiers || campaign.priceTiers || [];
        const liveBuyerCount = typeof campaign.currentBuyers === 'number'
            ? campaign.currentBuyers
            : initialBuyers;
        
        // Calculate current price based on live buyer count
        let currentPrice = initialPrice;
        for (const tier of priceTiers) {
            if (liveBuyerCount >= tier.buyers) currentPrice = tier.price;
        }
        
        // Calculate discount percentage: ((initial - current) / initial) * 100
        const discountPercentage = initialPrice > 0 
            ? Math.round(((initialPrice - currentPrice) / initialPrice) * 100) 
            : 0;
        
        return {
            id: campaign.id,
            campaignId: campaign.id,
            initialBuyers,
            currentBuyers: liveBuyerCount,
            initialPrice,
            currentPrice,
            discountPercentage,
            priceTiers,
            countdownEnd: campaign.countdownEnd || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            videoSource: campaign.videoUrl || '',
            termsUrl: campaign.termsUrl || '',
            referralsNeeded: campaign.referralsNeeded || campaign.sharesRequired || 2,
            product: {
                image: campaign.productImage || campaign.imageUrl || '',
                name: campaign.productName || '',
                description: campaign.productDescription || campaign.description || ''
            },
            twilio: { enabled: false, accountSid: '', authToken: '', phoneNumber: '', domain: '' }
        };
    }
    
    async function getAvailableCampaigns() {
        if (currentCampaign) {
            return [{
                id: currentCampaign.id,
                name: currentCampaign.productName,
                merchant: currentCampaign.merchantName,
                price: currentCampaign.pricing?.initialPrice || currentCampaign.price || currentCampaign.originalPrice,
                originalPrice: currentCampaign.pricing?.initialPrice || currentCampaign.originalPrice
            }];
        }
        return [];
    }
    
    function showCampaignError(errorData) {
        const container = document.querySelector('.container') || document.body;
        container.innerHTML = `
            <div class="campaign-error" style="padding: 40px 20px; text-align: center; max-width: 500px; margin: 0 auto;">
                <div style="font-size: 64px; margin-bottom: 20px;">🔍</div>
                <h1 style="font-size: 24px; margin-bottom: 16px; color: #fff;">Campaign Not Found</h1>
                <p style="color: #aaa; margin-bottom: 24px; line-height: 1.6;">We couldn't find the campaign you're looking for.<br>The link may be expired or incorrect.</p>
                <p style="margin-top: 32px; color: #666; font-size: 14px;">Please check your link and try again.</p>
            </div>`;
    }
    
    return {
        generateCampaignId,
        getCampaignIdFromUrl,
        loadCampaign,
        loadCampaignFromUrl,
        getCurrentCampaign,
        toLegacyConfig,
        getAvailableCampaigns,
        showCampaignError
    };
})();

if (typeof module !== 'undefined' && module.exports) {
    module.exports = CampaignLoader;
} else {
    window.CampaignLoader = CampaignLoader;
}
