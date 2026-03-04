// Login functionality
(function() {
    const TOKEN_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours
    const STORAGE_KEYS = {
        token: 'adminToken',
        brand: 'adminBrandId',
        superAdmin: 'adminIsSuperAdmin'
    };

    function normalizeBase64(token) {
        if (!token || typeof token !== 'string') return '';
        let normalized = token.replace(/-/g, '+').replace(/_/g, '/');
        while (normalized.length % 4) {
            normalized += '=';
        }
        return normalized;
    }

    function decodeAuthToken(token) {
        try {
            const decoded = atob(normalizeBase64(token));
            return JSON.parse(decoded);
        } catch (error) {
            return null;
        }
    }

    function isTokenFresh(payload) {
        if (!payload || typeof payload.timestamp !== 'number') return false;
        return (Date.now() - payload.timestamp) < TOKEN_MAX_AGE_MS;
    }

    function clearStoredAuth() {
        localStorage.removeItem(STORAGE_KEYS.token);
        localStorage.removeItem(STORAGE_KEYS.brand);
        localStorage.removeItem(STORAGE_KEYS.superAdmin);
        sessionStorage.removeItem(STORAGE_KEYS.brand);
        sessionStorage.removeItem(STORAGE_KEYS.superAdmin);
    }

    function persistUserContext(source) {
        if (!source || typeof source !== 'object') return false;
        const brandId = source.brand_id ?? source.brandId ?? null;
        const isSuperAdmin = Boolean(source.is_super_admin ?? source.isSuperAdmin);

        const brandValue = brandId || '';
        localStorage.setItem(STORAGE_KEYS.brand, brandValue);
        sessionStorage.setItem(STORAGE_KEYS.brand, brandValue);
        localStorage.setItem(STORAGE_KEYS.superAdmin, isSuperAdmin ? 'true' : 'false');
        sessionStorage.setItem(STORAGE_KEYS.superAdmin, isSuperAdmin ? 'true' : 'false');
        return true;
    }

    function bootstrapFromToken(token) {
        const payload = decodeAuthToken(token);
        if (!isTokenFresh(payload)) return false;
        persistUserContext(payload);
        return true;
    }

    const existingToken = localStorage.getItem(STORAGE_KEYS.token);
    if (existingToken) {
        if (bootstrapFromToken(existingToken)) {
            window.location.href = 'admin.html';
            return;
        }
        clearStoredAuth();
    }

    const loginForm = document.getElementById('login-form');
    const errorMessage = document.getElementById('error-message');
    const loginBtn = document.getElementById('login-btn');

    function showError(message) {
        errorMessage.textContent = message;
        errorMessage.classList.add('show');
        setTimeout(() => {
            errorMessage.classList.remove('show');
        }, 5000);
    }

    function setLoading(loading) {
        loginBtn.disabled = loading;
        loginBtn.textContent = loading ? 'Signing in...' : 'Sign In';
    }

    loginForm.addEventListener('submit', async function(e) {
        e.preventDefault();
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value;

        if (!username || !password) {
            showError('Please enter both email and password');
            return;
        }

        setLoading(true);

        try {
            let csrfToken = null;
            try {
                const csrfResponse = await fetch('/api/csrf-token', { credentials: 'same-origin' });
                if (csrfResponse.ok) {
                    const csrfData = await csrfResponse.json();
                    csrfToken = csrfData.token;
                }
            } catch (csrfError) {
                console.warn('Failed to fetch CSRF token:', csrfError);
            }

            const response = await fetch('/api/login', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken || ''
                },
                credentials: 'same-origin',
                body: JSON.stringify({ username, password, csrfToken })
            });

            const data = await response.json();

            if (response.ok && data.token) {
                localStorage.setItem(STORAGE_KEYS.token, data.token);
                if (!persistUserContext(data.user)) {
                    const payload = decodeAuthToken(data.token);
                    if (payload) persistUserContext(payload);
                }
                window.location.href = 'admin.html';
            } else {
                clearStoredAuth();
                showError(data.error || 'Invalid username or password');
            }
        } catch (error) {
            console.error('Login error:', error);
            clearStoredAuth();
            showError('Network error. Please try again.');
        } finally {
            setLoading(false);
        }
    });

    document.getElementById('username').addEventListener('input', function() {
        errorMessage.classList.remove('show');
    });
    document.getElementById('password').addEventListener('input', function() {
        errorMessage.classList.remove('show');
    });
})();
