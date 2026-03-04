/**
 * Campaign Loader Module
 * Handles loading campaign data from campaigns.json based on URL parameter
 */

const CampaignLoader = (function() {
    let campaignsCache = null;
    let cacheTimestamp = 0;
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
    
    async function loadAllCampaigns() {
        const now = Date.now();
        
        // Use cache if it's still fresh (within TTL)
        if (campaignsCache && (now - cacheTimestamp) < CACHE_TTL) {
            return campaignsCache;
        }
        
        try {
            const response = await fetch(`/data/campaigns.json?t=${now}`);
            if (!response.ok) throw new Error(`Failed to load: ${response.status}`);
            campaignsCache = await response.json();
            cacheTimestamp = now;
            return campaignsCache;
        } catch (error) {
            console.error('CampaignLoader: Error loading campaigns:', error);
            // Return stale cache as fallback instead of null
            if (campaignsCache) {
                console.log('CampaignLoader: Using stale cache as fallback');
                return campaignsCache;
            }
            return null;
        }
    }
    
    async function loadCampaign(campaignId) {
        const data = await loadAllCampaigns();
        if (!data) return { success: false, error: 'Failed to load campaigns database' };
        if (!campaignId) return { success: false, error: 'No campaign ID provided' };
        
        // Handle both array format { campaigns: [...] } and object format { id: {...} }
        const campaignsArray = data.campaigns || data;
        const campaigns = Array.isArray(campaignsArray) 
            ? campaignsArray.reduce((acc, c) => { if (c.id) acc[c.id] = c; return acc; }, {})
            : campaignsArray;
        
        const campaign = campaigns[campaignId];
        if (!campaign) return { success: false, error: 'Campaign not found', campaignId };
        currentCampaign = { id: campaignId, ...campaign };
        return { success: true, campaign: currentCampaign };
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
        
        // Calculate current price based on initial buyers count
        let currentPrice = initialPrice;
        for (const tier of priceTiers) {
            if (initialBuyers >= tier.buyers) currentPrice = tier.price;
        }
        
        // Calculate discount percentage: ((initial - current) / initial) * 100
        const discountPercentage = initialPrice > 0 
            ? Math.round(((initialPrice - currentPrice) / initialPrice) * 100) 
            : 0;
        
        return {
            id: campaign.id,
            campaignId: campaign.id,
            initialBuyers: initialBuyers,
            currentBuyers: initialBuyers,
            initialPrice: initialPrice,
            currentPrice: currentPrice,
            discountPercentage: discountPercentage,
            priceTiers: priceTiers,
            countdownEnd: campaign.countdownEnd || new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
            videoSource: campaign.videoUrl || '',
            termsUrl: campaign.termsUrl || '',
            referralsNeeded: campaign.referralsNeeded || campaign.sharesRequired || 2,
            product: {
                image: campaign.productImage || campaign.imageUrl || '',
                name: campaign.productName || '',
                description: campaign.productDescription || campaign.description || ''
            },
            twilio: campaign.twilio || { enabled: false, accountSid: '', authToken: '', phoneNumber: '', domain: '' }
        };
    }
    
    async function getAvailableCampaigns() {
        const data = await loadAllCampaigns();
        if (!data) return [];
        
        // Handle both array format { campaigns: [...] } and object format { id: {...} }
        const campaignsArray = data.campaigns || data;
        const campaigns = Array.isArray(campaignsArray) ? campaignsArray : Object.values(campaignsArray);
        
        return campaigns.filter(c => c && c.id).map((data) => ({
            id: data.id,
            name: data.productName,
            merchant: data.merchantName,
            price: data.pricing?.initialPrice || data.price || data.originalPrice,
            originalPrice: data.pricing?.initialPrice || data.originalPrice
        }));
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
