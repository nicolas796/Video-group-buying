# Secrets Management Guide

This document explains how to keep Twilio credentials and every other sensitive value safe while working on the group-buying app. Treat it as the single source of truth for handling secrets across development, staging, and production.

## 1. What counts as a secret?

| Secret Type | Examples | Notes |
|-------------|----------|-------|
| SMS provider credentials | `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, messaging service SID, phone numbers | Rotate immediately if leaked. Use sub-accounts for each environment so you can revoke access without touching production.
| Admin access overrides | `ADMIN_USERNAME`, `ADMIN_PASSWORD` (when changed), session tokens, password reset links | Never reuse the default password (`password123`) outside disposable local dev.
| HTTPS + infrastructure values | `FORCE_HTTPS`, `HTTPS_EXEMPT_HOSTS`, webhook URLs, Render service tokens | Some are not inherently sensitive, but treat them as configuration that should match the environment you deploy to.
| Future integrations | Email providers, analytics keys (Sentry DSN, Segment tokens), any API key | Add them to `.env` + hosting secret store as soon as they appear.

## 2. Storage rules

1. **.env files stay local.**
   - Copy `.env.example` → `.env` and fill in the blanks for your machine.
   - `.env` is gitignored by default. Never override that behavior.
   - If you need to share values with another teammate, do it via a secure channel (1Password vault, Bitwarden organization, etc.), not Slack/email.

2. **`data/config.json` is runtime data, not source control.**
   - The admin panel writes Twilio credentials into `data/config.json` so that SMS can work without redeploying.
   - Once that file contains real values, keep it out of commits. Recommended approaches:
     - Use `git update-index --skip-worktree data/config.json` on machines that store secrets.
     - Or maintain a sanitized `data/config.example.json` for reference and keep the real file outside the repo entirely (symlink or deployment volume mount).

3. **Production/staging secrets live in your hosting provider.**
   - Render/Railway/Heroku all support encrypted environment variables. Mirror the names in `.env.example` (`TWILIO_ACCOUNT_SID`, etc.) and set them per environment.
   - Never hardcode secrets inside `render.yaml`, `server.js`, or JSON config files that are committed to Git.

4. **Backups respect least privilege.**
   - If you back up the `data/` folder for auditing, encrypt the archive (`age`, `gpg`, or your preferred tool) before storing it anywhere outside the production filesystem.

## 3. Working locally without leaking secrets

1. **Populate `.env`:**
   ```bash
   cd group-buying
   cp .env.example .env
   # edit .env with your Twilio SID/token and admin overrides
   ```
2. **Export vars when running the server:**
   ```bash
   export $(grep -v '^#' .env | xargs)
   node server.js
   ```
3. **Apply Twilio credentials at runtime:**
   - Use the admin panel (`/admin.html`) to paste in the SID/token/phone number from `.env`.
   - Alternatively, write a local-only helper script that reads `.env` and patches `data/config.json`. Keep that script out of Git or ensure it strips secrets afterward.
4. **Verify cleanliness before committing:**
   ```bash
   git status
   # confirm .env, data/config.json, and other secret-bearing files are NOT staged
   ```

## 4. Twilio-specific safeguards

- **Isolate environments:** Create a Twilio sub-account per environment (local, staging, production). Never reuse the production Auth Token anywhere else.
- **Least privilege:** Lock down phone numbers and messaging services to only the webhooks they need. Disable voice if you only use SMS.
- **Rotation cadence:** Rotate Auth Tokens at least every 90 days or immediately after onboarding/offboarding a collaborator. Update `.env`, hosting secrets, and `data/config.json` (via admin UI) as part of the same change.
- **Audit logs:** Twilio provides a log of API requests. Check for unusual traffic whenever you rotate creds or suspect leakage.

## 5. Git hygiene checklist

- [ ] `git status` shows no `.env`, `data/config.json`, `data/campaigns.json`, or other sensitive files.
- [ ] `.env` never leaves your machine.
- [ ] Sanitized examples (`.env.example`, `config.example.json`) contain placeholders only.
- [ ] Pull requests include screenshots or descriptions instead of real values when demonstrating Twilio settings.
- [ ] Reviewers confirm no secrets appear in diffs before approving.

### Optional automation

Add a pre-commit hook (local-only) to prevent accidents:
```bash
#!/usr/bin/env bash
if git diff --cached --name-only | grep -E '^(\.env|data/config\.json|data/campaigns\.json)$' > /dev/null; then
  echo "\n❌ Secret-bearing file staged. Unstage it before committing." >&2
  exit 1
fi
```

## 6. Incident response & rotation

1. **Suspect a leak?** Immediately rotate the affected credentials (Twilio tokens, admin password) and revoke all active sessions.
2. **Purge history:** If a secret accidentally lands in Git, use `git filter-repo` (preferred) or `BFG Repo-Cleaner` to remove it from history, then force-push *after* user approval.
3. **Notify stakeholders:** Inform Nicolas and anyone else with access so they can update their local `.env` files.
4. **Document the incident:** Add a short note in `memory/YYYY-MM-DD.md` or an incident log so future contributors know what happened and why rotation occurred.

## 7. Checklist before merging any PR

- [ ] README references `.env.example` and the secrets workflow (✅ already done).
- [ ] No Twilio credentials or admin passwords in commit history.
- [ ] Screenshots/logs scrubbed of phone numbers or codes.
- [ ] `SECRETS.md` referenced in PR description when changes touch configuration or deployments.

Following these steps keeps the group-buying app compliant with Twilio's security expectations and prevents accidental exposure of customer data. When in doubt, assume a value is sensitive and store it like a password.
