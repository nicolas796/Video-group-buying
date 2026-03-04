# Deployment Checklist

## Pre-Deploy
- [ ] Set JWT_SECRET environment variable (strong random string)
- [ ] Set NODE_ENV=production
- [ ] Verify data/ directory is writable
- [ ] Run all tests: npm test (or node test-*.js)
- [ ] Backup existing data files

## Deploy
- [ ] Deploy code to server
- [ ] Run data migration if needed: node migrate-campaigns-brand.js
- [ ] Verify server starts without errors
- [ ] Test login with super admin
- [ ] Create production brands/users via admin UI

## Post-Deploy
- [ ] Verify brand isolation works (Coke can't see Pepsi)
- [ ] Check audit.log is being written
- [ ] Monitor error logs
- [ ] Set up log rotation for data/audit.log
