/**
 * Campaign Loader Module
 * Handles loading campaign data from campaigns.json based on URL parameter
 */

const CampaignLoader = (function() {
    let campaignsCache = null;
    let currentCampaign = null;
    
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
        if (campaignsCache) return campaignsCache;
        try {
            const response = await fetch(`/data/campaigns.json?t=${Date.now()}`);
            if (!response.ok) throw new Error(`Failed to load: ${response.status}`);
            campaignsCache = await response.json();
            return campaignsCache;
        } catch (error) {
            console.error('CampaignLoader: Error loading campaigns:', error);
            return null;
        }
    }
    
    async function loadCampaign(campaignId) {
        const campaigns = await loadAllCampaigns();
        if (!campaigns) return { success: false, error: 'Failed to load campaigns database' };
        if (!campaignId) return { success: false, error: 'No campaign ID provided' };
        const campaign = campaigns[campaignId];
        if (!campaign) return { success: false, error: 'Campaign not found', campaignId, availableCampaigns: Object.keys(campaigns) };
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
        const campaigns = await loadAllCampaigns();
        if (!campaigns) return [];
        return Object.entries(campaigns).map(([id, data]) => ({
            id,
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
                ${errorData.availableCampaigns ? `
                <div style="margin-top: 32px; padding: 20px; background: rgba(255,255,255,0.05); border-radius: 12px;">
                    <p style="color: #888; margin-bottom: 16px;">Available campaigns:</p>
                    <div style="display: flex; flex-wrap: wrap; gap: 10px; justify-content: center;">
                        ${errorData.availableCampaigns.map(id => `
                            <a href="?v=${id}" style="display: inline-block; padding: 10px 20px; background: linear-gradient(135deg, #FF4D8F, #FF8F4D); color: white; text-decoration: none; border-radius: 8px; font-weight: 600;">${id}</a>
                        `).join('')}
                    </div>
                </div>` : ''}
                <p style="margin-top: 32px; color: #666; font-size: 14px;">Campaign ID: <code style="background: rgba(255,255,255,0.1); padding: 4px 8px; border-radius: 4px;">${errorData.campaignId || 'none'}</code></p>
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
