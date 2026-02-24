const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

const dom = new JSDOM(`<!doctype html><html><body>
<div id="landing-view"></div>
<div id="success-view" class="hidden">
  <div class="share-section">
    <p class="referral-hint">
      <span id="share-referrals-label">2 friends</span> join = instant $<span id="share-best-price">20</span> price
    </p>
  </div>
</div>
<form id="join-form"></form>
</body></html>`, {
  url: 'http://127.0.0.1:8080/?v=TEST',
  pretendToBeVisual: true,
  runScripts: 'outside-only'
});

const sandbox = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  fetch: async () => ({ ok: true, json: async () => ({}) }),
  DOMPurify: { sanitize: (html) => html },
  CampaignLoader: {
    loadCampaignFromUrl: async () => ({ success: true, campaign: { id: 'TEST', productName: 'Test Campaign', referralsNeeded: 2 } }),
    showCampaignError: () => {},
    toLegacyConfig: () => ({ priceTiers: [{ price: 20 }], referralsNeeded: 2, initialBuyers: 0 }),
    getCurrentCampaign: () => ({ id: 'TEST', productName: 'Test Campaign' })
  },
  Hls: {
    isSupported: () => false,
    Events: {},
    on: () => {}
  },
  confetti: () => {},
  alert: () => {},
  performance: dom.window.performance,
  URLSearchParams: dom.window.URLSearchParams,
};

sandbox.window.window = sandbox.window;
sandbox.window.document = sandbox.document;
sandbox.window.navigator = sandbox.navigator;
sandbox.window.fetch = sandbox.fetch;
sandbox.window.DOMPurify = sandbox.DOMPurify;
sandbox.window.CampaignLoader = sandbox.CampaignLoader;
sandbox.window.Hls = sandbox.Hls;
sandbox.window.confetti = sandbox.confetti;
sandbox.window.alert = sandbox.alert;

const context = vm.createContext(sandbox);

const appCode = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
vm.runInContext(appCode, context, { filename: 'app.js' });

const counts = [2, 3, 5];
const results = counts.map((count) => {
  vm.runInContext(`referralsNeeded = ${count}; updateShareHintCopy();`, context);
  const label = sandbox.document.getElementById('share-referrals-label').textContent.trim();
  return { count, label };
});

for (const { count, label } of results) {
  console.log(`referralsNeeded=${count} -> label='${label}'`);
}
