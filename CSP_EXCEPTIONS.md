# CSP Exceptions

The CSP now defaults every resource type to `'self'` and only opens specific escape hatches where the current app needs them. These are the intentional exceptions:

## Inline Scripts (script-src hashes)
We still ship three inline `<script>` blocks that must execute before the rest of the bundle loads:
- `sha256-2bGHMrl77eVSsuQU10LbbN1Qrqb73iE3YP1+L9igUJI=` → Safari viewport fix that stabilizes the mobile keyboard height.
- `sha256-rr65mWwZJnb5bUhQe/lNU42AdlfN1rEFOtlIf3NGatw=` → Brave-specific video repaint fix when `ref=` is present.
- `sha256-KSRRsZ+kzH2uXHwYEr4gQoONH5uXlxvjQwjGtsu+ORA=` → Admin auth guard that redirects unauthenticated users off the dashboard ASAP.

Replacing these with external modules would remove the need for hashes, but until then the hashes guarantee integrity without broad `'unsafe-inline'` for scripts.

## Inline Styles (`'unsafe-inline'` in style-src)
The admin dashboard and landing page inject dynamic styles (e.g., runtime layout adjustments, transient progress styles). Browsers still require `'unsafe-inline'` for these style mutations. Long-term we can migrate to CSS custom properties or move the inline `<style>` blocks to static files.

## External CDNs
We explicitly allow `https://cdn.jsdelivr.net` for script and style assets so we can keep using HLS.js, DOMPurify, Canvas Confetti, and any CSS libraries we load from jsDelivr.

## Twilio SMS API (`connect-src`)
Outbound API calls from the server-side Twilio webhooks are proxied through `https://api.twilio.com`. The frontend never calls Twilio directly, but the Twilio SDK inside the Express server does, so we list it to prevent the browser from flagging fetch/XHR calls that originate from the admin tools (e.g., health checks).

## Media + Data URIs
- `media-src 'self' https: blob:` enables HLS.js to attach blob URLs for the video element while still allowing https-hosted video streams.
- `img-src 'self' data: https:` and `font-src 'self' data:` support base64-encoded logos and fonts that ship with campaigns.

## Reporting Endpoint
The policy adds `report-uri /csp-report`, which points to the new server endpoint that stores violation reports in `data/csp-reports.log` for monitoring.

If/when we remove the inline helpers or dynamic styles, we can drop the related allowances and tighten the CSP even further.
