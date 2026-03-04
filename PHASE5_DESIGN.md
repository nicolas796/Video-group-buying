# Phase 5: Review & Refactor - Design Document

**Execution Model:** OpenAI Codex 5.1 (Tier 2 RPM/TPM)
**Approach:** Small, reviewable chunks with validation between each

---

## Phase 5A: Code Review & Architecture Audit
**Goal:** Review entire implementation for consistency, completeness, and best practices

**Tasks:**
1. Review all modified files (server.js, admin.js, data-store.js, etc.)
2. Check for:
   - Missing brand_id checks on any endpoints
   - Inconsistent error response formats
   - Unused variables/imports
   - Hardcoded values that should be configurable
   - Duplicate code that could be consolidated
3. Verify all API routes have proper auth middleware
4. Check that middleware chains are in correct order (auth → validation → handler)
5. Document findings in PHASE5A_AUDIT.md

**Deliverable:** Audit report + list of issues found (if any)
**Estimated:** 10-15 min

---

## Phase 5B: Security Hardening
**Goal:** Deep security audit and fixes

**Tasks:**
1. **Authentication audit:**
   - Verify token validation on every protected route
   - Check token expiration handling
   - Ensure password hashes use appropriate bcrypt cost
   
2. **Authorization audit:**
   - Verify brand isolation is enforced everywhere
   - Test that super admin checks can't be bypassed
   - Check for IDOR (Insecure Direct Object Reference) vulnerabilities
   
3. **Input validation:**
   - Validate all request bodies (JSON schema or manual checks)
   - Sanitize user inputs before storage
   - Check for path traversal in file operations
   
4. **Output encoding:**
   - Ensure no sensitive data leaks in error messages
   - Verify 404 vs 403 usage (don't leak existence)

**Deliverable:** Security fixes + SECURITY_AUDIT.md report
**Estimated:** 15-20 min

---

## Phase 5C: Error Handling & Logging Standardization
**Goal:** Consistent error responses and comprehensive logging

**Tasks:**
1. Standardize error response format:
   ```json
   { "error": "message", "code": "ERROR_CODE", "details": {} }
   ```
2. Add error codes for common failures (AUTH_REQUIRED, BRAND_ACCESS_DENIED, etc.)
3. Add request logging middleware (method, path, user, timestamp)
4. Add audit logging for sensitive operations:
   - User creation/deletion
   - Brand changes
   - Campaign modifications
5. Ensure all async errors are caught and handled

**Deliverable:** Standardized error handling + logging system
**Estimated:** 10-15 min

---

## Phase 5D: Performance & Data Integrity
**Goal:** Optimize and harden data operations

**Tasks:**
1. **Data validation:**
   - Add schema validation for all JSON files on load
   - Handle corrupted/missing data gracefully
   - Add data migration versioning
   
2. **Performance:**
   - Cache frequently accessed data (brands list, users list)
   - Optimize campaign counting (pre-compute or memoize)
   - Add pagination for large lists (campaigns, participants)
   
3. **Atomicity:**
   - Ensure file writes are atomic (temp file + rename)
   - Add rollback capability for multi-step operations
   
4. **Backup/recovery:**
   - Add automatic JSON backups before writes
   - Add recovery mechanism for corrupted files

**Deliverable:** Performance improvements + data integrity safeguards
**Estimated:** 15-20 min

---

## Phase 5E: End-to-End Integration Testing
**Goal:** Complete test coverage and Coke vs Pepsi validation

**Tasks:**
1. Create comprehensive test suite:
   - `test-e2e-brand-isolation.js` - Full user journey
   - Test file organization:
     - `tests/unit/auth.test.js`
     - `tests/unit/brands.test.js`
     - `tests/unit/users.test.js`
     - `tests/unit/campaigns.test.js`
     - `tests/integration/full-isolation.test.js`

2. **Coke vs Pepsi scenario:**
   - Create brand "Coca Cola"
   - Create brand "Pepsi"
   - Create coke@example.com → assign to Coca Cola
   - Create pepsi@example.com → assign to Pepsi
   - Create campaigns for both
   - Login as Coke user → verify ONLY sees Coca Cola campaigns
   - Attempt to access Pepsi campaign → verify 404
   - Login as Pepsi user → verify ONLY sees Pepsi campaigns
   - Login as Super Admin → verify sees all

3. **Edge cases:**
   - User with no brand (should fail gracefully)
   - Campaign with no brand (migration check)
   - Deleted brand cleanup
   - Concurrent access simulation

**Deliverable:** Full test suite with passing results + TEST_REPORT.md
**Estimated:** 15-20 min

---

## Phase 5F: Documentation & Deployment Prep
**Goal:** Final documentation and deployment readiness

**Tasks:**
1. Update README.md with:
   - Brand isolation feature overview
   - API documentation
   - Admin UI usage guide
   - Testing instructions
   
2. Create DEPLOYMENT_CHECKLIST.md:
   - Pre-deploy verification steps
   - Data backup requirements
   - Rollback plan
   
3. Create LOCAL_TESTING.md:
   - How to run locally
   - How to test brand isolation
   - Default credentials
   - Common issues and solutions

4. Final code cleanup:
   - Remove debug logs
   - Add comments where needed
   - Ensure consistent formatting

**Deliverable:** Complete documentation + deployment-ready codebase
**Estimated:** 10-15 min

---

## Execution Schedule

Each phase runs sequentially via cron. After each phase:
1. Update BRAND_ISOLATION_STATUS.md
2. Report findings to user
3. Pause briefly (next cron cycle) before proceeding
4. Allow user to intervene if needed

**Total estimated time:** 75-105 minutes
**Model:** OpenAI Codex 5.1 (Tier 2)
