#!/usr/bin/env node
/**
 * Marketing Collateral Generator for Group Buying App
 * Captures screenshots and screen recordings for Product Hunt launch
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUTPUT_DIR = process.argv[2] || '/home/baill/.openclaw/workspace/marketing-collateral';
const BASE_URL = 'http://localhost:8080';

// Ensure output directory exists
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

async function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function captureLandingPage(page, isMobile = false) {
    console.log(`📸 Capturing landing page (${isMobile ? 'mobile' : 'desktop'})...`);
    
    await page.goto(`${BASE_URL}/?campaign=005EZsfHkpI`, { waitUntil: 'networkidle' });
    await delay(3000); // Wait for video to load
    
    const suffix = isMobile ? 'mobile' : 'desktop';
    await page.screenshot({ 
        path: path.join(OUTPUT_DIR, `01-landing-page-${suffix}.png`),
        fullPage: true 
    });
    
    console.log(`  ✓ Landing page ${suffix} screenshot saved`);
}

async function captureJoinFlow(page, isMobile = false) {
    console.log(`📸 Capturing join flow (${isMobile ? 'mobile' : 'desktop'})...`);
    
    await page.goto(`${BASE_URL}/?campaign=005EZsfHkpI`, { waitUntil: 'networkidle' });
    await delay(2000);
    
    // Scroll to join form or click to reveal it
    const joinForm = await page.$('#join-form');
    if (joinForm) {
        await joinForm.scrollIntoViewIfNeeded();
        await delay(500);
    }
    
    const suffix = isMobile ? 'mobile' : 'desktop';
    await page.screenshot({ 
        path: path.join(OUTPUT_DIR, `02-join-form-${suffix}.png`),
        fullPage: false 
    });
    
    // Fill in form (without submitting)
    const phoneInput = await page.$('#join-phone');
    const emailInput = await page.$('#join-email');
    
    if (phoneInput) await phoneInput.fill('(555) 123-4567');
    if (emailInput) await emailInput.fill('demo@example.com');
    
    await delay(500);
    
    await page.screenshot({ 
        path: path.join(OUTPUT_DIR, `02-join-form-filled-${suffix}.png`),
        fullPage: false 
    });
    
    console.log(`  ✓ Join flow ${suffix} screenshots saved`);
}

async function captureReferralFlow(page, isMobile = false) {
    console.log(`📸 Capturing referral flow (${isMobile ? 'mobile' : 'desktop'})...`);
    
    // First join to get to referral screen
    await page.goto(`${BASE_URL}/?campaign=005EZsfHkpI`, { waitUntil: 'networkidle' });
    await delay(2000);
    
    const phoneInput = await page.$('#join-phone');
    const emailInput = await page.$('#join-email');
    
    if (phoneInput) await phoneInput.fill('(555) 999-8888');
    if (emailInput) await emailInput.fill('referral-demo@example.com');
    
    const joinBtn = await page.$('.join-btn');
    if (joinBtn) {
        await joinBtn.click();
        await delay(3000); // Wait for success screen
    }
    
    const suffix = isMobile ? 'mobile' : 'desktop';
    await page.screenshot({ 
        path: path.join(OUTPUT_DIR, `03-referral-success-${suffix}.png`),
        fullPage: true 
    });
    
    console.log(`  ✓ Referral success ${suffix} screenshot saved`);
}

async function captureAdminDashboard(page) {
    console.log('📸 Capturing admin dashboard...');
    
    await page.goto(`${BASE_URL}/login.html`, { waitUntil: 'networkidle' });
    await delay(1000);
    
    // Login with default credentials
    const usernameInput = await page.$('#username');
    const passwordInput = await page.$('#password');
    
    if (usernameInput) await usernameInput.fill('admin');
    if (passwordInput) await passwordInput.fill('changeme');
    
    const loginBtn = await page.$('.btn-login');
    if (loginBtn) {
        await loginBtn.click();
        await delay(3000);
    }
    
    await page.screenshot({ 
        path: path.join(OUTPUT_DIR, '04-admin-dashboard.png'),
        fullPage: true 
    });
    
    // Capture stats section specifically
    const statsSection = await page.$('.stats');
    if (statsSection) {
        await statsSection.scrollIntoViewIfNeeded();
        await delay(500);
        await statsSection.screenshot({ 
            path: path.join(OUTPUT_DIR, '04-admin-stats.png')
        });
    }
    
    console.log('  ✓ Admin dashboard screenshots saved');
}

async function captureCampaignCreation(page) {
    console.log('📸 Capturing campaign creation flow...');
    
    // Should already be logged in from previous step
    const newCampaignBtn = await page.$('button[onclick="createNewCampaign()"]');
    if (newCampaignBtn) {
        await newCampaignBtn.click();
        await delay(1000);
        
        await page.screenshot({ 
            path: path.join(OUTPUT_DIR, '05-campaign-creation.png'),
            fullPage: true 
        });
    }
    
    console.log('  ✓ Campaign creation screenshot saved');
}

async function recordDemoVideo(browser, isMobile = false) {
    console.log(`🎥 Recording demo video (${isMobile ? 'mobile' : 'desktop'})...`);
    
    const context = await browser.newContext({
        viewport: isMobile ? { width: 375, height: 812 } : { width: 1280, height: 720 },
        recordVideo: {
            dir: OUTPUT_DIR,
            size: isMobile ? { width: 375, height: 812 } : { width: 1280, height: 720 }
        }
    });
    
    const page = await context.newPage();
    
    // Landing page with video
    console.log('  - Landing page...');
    await page.goto(`${BASE_URL}/?campaign=005EZsfHkpI`, { waitUntil: 'networkidle' });
    await delay(4000);
    
    // Scroll through content
    await page.evaluate(() => window.scrollBy(0, 300));
    await delay(2000);
    
    // Join form interaction
    console.log('  - Join form...');
    const joinForm = await page.$('#join-form');
    if (joinForm) await joinForm.scrollIntoViewIfNeeded();
    await delay(1000);
    
    const phoneInput = await page.$('#join-phone');
    const emailInput = await page.$('#join-email');
    
    if (phoneInput) await phoneInput.fill('(555) 123-4567');
    await delay(500);
    if (emailInput) await emailInput.fill('demo@example.com');
    await delay(1000);
    
    // Submit form
    const joinBtn = await page.$('.join-btn');
    if (joinBtn) {
        await joinBtn.click();
        await delay(4000); // Wait for success/referral screen
    }
    
    // Referral screen
    console.log('  - Referral sharing...');
    await delay(3000);
    
    // Scroll to see more
    await page.evaluate(() => window.scrollBy(0, 200));
    await delay(2000);
    
    await context.close();
    
    // Rename video file
    const videoDir = OUTPUT_DIR;
    const files = fs.readdirSync(videoDir);
    const videoFile = files.find(f => f.endsWith('.webm'));
    if (videoFile) {
        const suffix = isMobile ? 'mobile' : 'desktop';
        const newName = `demo-video-${suffix}.webm`;
        fs.renameSync(
            path.join(videoDir, videoFile),
            path.join(videoDir, newName)
        );
        console.log(`  ✓ Demo video saved: ${newName}`);
    }
}

async function main() {
    console.log('🎯 Marketing Collateral Generator');
    console.log('=================================\n');
    
    const browser = await chromium.launch({ headless: true });
    
    try {
        // Desktop screenshots
        const desktopContext = await browser.newContext({ viewport: { width: 1280, height: 720 } });
        const desktopPage = await desktopContext.newPage();
        
        await captureLandingPage(desktopPage, false);
        await captureJoinFlow(desktopPage, false);
        await captureReferralFlow(desktopPage, false);
        await captureAdminDashboard(desktopPage);
        await captureCampaignCreation(desktopPage);
        
        await desktopContext.close();
        
        // Mobile screenshots
        const mobileContext = await browser.newContext({ viewport: { width: 375, height: 812 } });
        const mobilePage = await mobileContext.newPage();
        
        await captureLandingPage(mobilePage, true);
        await captureJoinFlow(mobilePage, true);
        await captureReferralFlow(mobilePage, true);
        
        await mobileContext.close();
        
        // Record demo videos
        await recordDemoVideo(browser, false);
        await recordDemoVideo(browser, true);
        
        console.log('\n✅ All marketing collateral captured!');
        console.log(`\nOutput directory: ${OUTPUT_DIR}`);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    } finally {
        await browser.close();
    }
}

main();
