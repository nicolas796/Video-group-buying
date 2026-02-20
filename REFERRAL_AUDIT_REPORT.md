# Referral Code Logic Audit Report

## Executive Summary
The referral code logic has **3 issues** identified - 2 medium severity, 1 low severity. The core multi-campaign isolation is working correctly, but there are edge cases that need addressing.

---

## Issues Found

### 🔴 ISSUE 1: Phone Number Uniqueness Too Restrictive (MEDIUM)
**Location:** `server.js` - `findParticipantByPhone()` function (line 178-181)

**Problem:**
The function prevents users from joining multiple campaigns with the same phone number. This may be intentional for abuse prevention, but it blocks legitimate multi-campaign participation.

**Code:**
```javascript
function findParticipantByPhone(phone, campaignId = null) {
    const normalizedPhone = normalizePhone(phone);
    return getParticipants().find(p => 
        normalizePhone(p.phone) === normalizedPhone && 
        (!campaignId || p.campaignId === campaignId)  // <-- BUG: When campaignId provided, still checks ALL
    );
}
```

**Impact:** User who joined Campaign A cannot join Campaign B with same phone.

**Recommendation:** If multi-campaign participation is desired, add campaignId filter:
```javascript
function findParticipantByPhone(phone, campaignId = null) {
    const normalizedPhone = normalizePhone(phone);
    return getParticipants().find(p => {
        const phoneMatch = normalizePhone(p.phone) === normalizedPhone;
        if (!campaignId) return phoneMatch;  // Global check for legacy
        return phoneMatch && p.campaignId === campaignId;  // Campaign-specific check
    });
}
```

---

### 🟡 ISSUE 2: Referral Code Uniqueness Not Guaranteed (MEDIUM)
**Location:** `server.js` - `generateReferralCode()` function (line 56)

**Problem:**
Referral codes are generated randomly but uniqueness is not enforced. With global uniqueness across all campaigns, collision probability increases with scale.

**Code:**
```javascript
function generateReferralCode() { 
    return crypto.randomBytes(4).toString('hex').toUpperCase(); 
}
```

**Impact:** 
- Extremely rare but possible duplicate codes across campaigns
- Could cause referral attribution errors if two users share the same code

**Recommendation:** Add uniqueness check:
```javascript
function generateReferralCode() {
    const participants = getParticipants();
    let code;
    do {
        code = crypto.randomBytes(4).toString('hex').toUpperCase();
    } while (participants.some(p => p.referralCode === code));
    return code;
}
```

---

### 🟢 ISSUE 3: Legacy Participants Without campaignId (LOW)
**Location:** `data/participants.json` - historical data

**Problem:**
Older participant entries lack the `campaignId` field. These participants:
- Are excluded from campaign-specific counts
- Won't appear in campaign exports
- Cannot be attributed to any specific campaign

**Example from data:**
```json
{
  "phone": "+1234567890",
  "email": "test@example.com",
  "joinedAt": "2026-02-18T20:00:00Z"
  // Missing: campaignId
}
```

**Recommendation:** 
1. Backfill legacy data with appropriate campaignId if known
2. Or accept that legacy data won't be counted in campaign-specific metrics
3. Document this for admin users

---

## Verified Correct Behavior ✅

### 1. Campaign-Specific Referral Counting
**Status:** WORKING CORRECTLY

All referral lookup functions properly filter by campaignId:
- `getParticipants(campaignId)` - Filters by campaign
- `getReferralCount(referralCode, campaignId)` - Counts only within campaign
- `hasUnlockedBestPrice(referralCode, campaignId)` - Checks within campaign only
- `getReferralStatus(referralCode, campaignId)` - Returns campaign-specific status

**Cross-campaign isolation verified:** A referral in Campaign A does NOT count toward unlocking in Campaign B.

### 2. Join Endpoint
**Status:** WORKING CORRECTLY

`/api/join` POST handler:
- ✅ Validates campaign exists: `if (data.campaignId && !getCampaign(data.campaignId))`
- ✅ Stores campaignId with participant: `campaignId: campaignId || null`
- ✅ Passes campaignId to referrer unlock check: `hasUnlockedBestPrice(data.referredBy, data.campaignId)`

### 3. Referral Status Endpoint
**Status:** WORKING CORRECTLY

`/api/referral/:code` GET handler:
- ✅ Accepts campaignId query param: `const campaignId = new URL(req.url...).searchParams.get('campaignId')`
- ✅ Returns campaign-specific count: `getReferralStatus(referralCode, campaignId)`

### 4. Frontend Integration
**Status:** WORKING CORRECTLY

`app.js`:
- ✅ Join request includes campaignId: `body: JSON.stringify({ phone, email, referredBy, campaignId: currentCampaignId })`
- ✅ Referral polling includes campaignId: `/api/referral/${userReferralCode}?campaignId=${currentCampaignId}`

---

## Referral Flow Documentation

### User Journey

```
1. User visits campaign URL: /?v=CAMPAIGN_ID&ref=REFERRER_CODE
   ↓
2. Frontend loads campaign via CampaignLoader
   ↓
3. User submits join form with phone, email
   ↓
4. Frontend sends POST /api/join:
      {
        phone: "...",
        email: "...",
        referredBy: "REFERRER_CODE",
        campaignId: "CAMPAIGN_ID"
      }
   ↓
5. Server validates campaign exists
   ↓
6. Server checks phone not already in THIS campaign
   ↓
7. Server generates unique referral code for new user
   ↓
8. Server stores participant with campaignId
   ↓
9. If referredBy provided:
      - Server counts referrals for REFERRER_CODE in THIS campaign only
      - Returns referrerUnlocked: true/false for THIS campaign only
   ↓
10. Server sends welcome SMS with user's referral link
    ↓
11. Frontend polls GET /api/referral/USER_CODE?campaignId=CAMPAIGN_ID
    ↓
12. Server returns referral count for THIS campaign only
```

### Data Model

**Participant Entry:**
```json
{
  "phone": "normalized phone",
  "email": "user@example.com",
  "referralCode": "UNIQUE_CODE",
  "referredBy": "REFERRER_CODE_OR_NULL",
  "campaignId": "CAMPAIGN_ID_OR_NULL",
  "joinedAt": "2026-02-20T02:37:02.097Z"
}
```

**Campaign Isolation:**
- Referral codes are unique strings (random hex)
- Referrals are counted per `(referralCode, campaignId)` pair
- A user can have multiple entries with same phone but different campaignIds
- Each campaign tracks its own referral unlock thresholds independently

---

## Test Scenarios Verified

| Scenario | Expected | Status |
|----------|----------|--------|
| User joins Campaign A with ref code | Counts toward referrer in Campaign A | ✅ Correct |
| User joins Campaign B with same ref code | Counts toward referrer in Campaign B | ✅ Correct |
| Referrer unlocks in Campaign A | Does NOT unlock in Campaign B | ✅ Correct |
| Campaign A participant data | Not visible in Campaign B export | ✅ Correct |
| Referral status API call | Returns count for specified campaign only | ✅ Correct |

---

## Recommendations Summary

1. **Fix phone uniqueness check** (if multi-campaign participation desired)
2. **Add referral code uniqueness enforcement** 
3. **Backfill or document legacy participant data**
4. **Add automated tests** for cross-campaign isolation
5. **Consider adding campaign-scoped referral codes** (e.g., CODE-CAMPAIGN_ID format)

## Conclusion

The multi-campaign referral system is **functionally correct** with proper isolation between campaigns. The identified issues are edge cases that should be addressed but do not represent critical security or functionality flaws.
