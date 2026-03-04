#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const CAMPAIGNS_PATH = path.join(DATA_DIR, 'campaigns.json');
const PARTICIPANTS_PATH = path.join(DATA_DIR, 'participants.json');

function readJson(filePath, fallback = null) {
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        if (fallback !== null) return fallback;
        throw error;
    }
}

function normalizePhone(phone) {
    if (!phone || typeof phone !== 'string') return null;
    return phone.replace(/[^0-9]/g, '');
}

function parseArgs(argv) {
    const campaigns = [];
    for (let i = 2; i < argv.length; i += 1) {
        if ((argv[i] === '--campaign' || argv[i] === '-c') && argv[i + 1]) {
            campaigns.push(argv[i + 1]);
            i += 1;
        }
    }
    return campaigns;
}

function analyzeCampaign(campaign, participants) {
    const phoneMap = new Map();
    const duplicates = [];
    const normalizedParticipants = participants.map((participant) => {
        const normalizedPhone = normalizePhone(participant.phone);
        if (normalizedPhone) {
            if (phoneMap.has(normalizedPhone)) {
                duplicates.push({
                    phone: participant.phone,
                    firstJoinedAt: phoneMap.get(normalizedPhone).joinedAt,
                    duplicateJoinedAt: participant.joinedAt
                });
            } else {
                phoneMap.set(normalizedPhone, participant);
            }
        }
        return { ...participant, normalizedPhone };
    });

    const referralCodes = new Set(normalizedParticipants.map(p => p.referralCode).filter(Boolean));
    const missingReferrers = normalizedParticipants
        .filter(p => p.referredBy)
        .filter(p => !referralCodes.has(p.referredBy));

    const initialBuyers = campaign?.pricing?.initialBuyers || campaign?.initialBuyers || 0;
    const participantCount = participants.length;
    const currentBuyers = initialBuyers + participantCount;

    return {
        campaignId: campaign.id,
        campaignName: campaign.productName,
        initialBuyers,
        participantCount,
        uniqueParticipants: phoneMap.size || participantCount,
        currentBuyers,
        duplicates,
        missingReferrers,
        ok: duplicates.length === 0 && missingReferrers.length === 0 && currentBuyers >= 0
    };
}

function verifyCampaigns(targetCampaignIds = []) {
    const campaignData = readJson(CAMPAIGNS_PATH, { campaigns: [] });
    const campaigns = Array.isArray(campaignData.campaigns) ? campaignData.campaigns : Object.values(campaignData);
    const participants = readJson(PARTICIPANTS_PATH, []);

    const campaignMap = new Map();
    campaigns.forEach(c => campaignMap.set(c.id, c));

    const selectedIds = targetCampaignIds.length > 0
        ? targetCampaignIds
        : (process.env.LOAD_TEST_CAMPAIGN_ID ? [process.env.LOAD_TEST_CAMPAIGN_ID] : campaigns.map(c => c.id));

    const results = selectedIds
        .filter(id => campaignMap.has(id))
        .map(id => {
            const campaignParticipants = participants.filter(p => (p.campaignId || null) === id);
            return analyzeCampaign(campaignMap.get(id), campaignParticipants);
        });

    const ok = results.every(r => r.ok);
    return { ok, campaigns: results };
}

if (require.main === module) {
    const targetCampaigns = parseArgs(process.argv);
    const report = verifyCampaigns(targetCampaigns);
    process.stdout.write(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
}

module.exports = verifyCampaigns;
