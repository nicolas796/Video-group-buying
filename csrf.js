(function(window, document) {
    const HEADER_NAME = 'X-CSRF-Token';
    let cachedToken = null;
    let pendingRequest = null;

    async function fetchToken() {
        if (cachedToken) {
            return cachedToken;
        }
        if (!pendingRequest) {
            pendingRequest = window.fetch('/api/csrf-token', { credentials: 'same-origin' })
                .then(response => {
                    if (!response.ok) {
                        throw new Error('Failed to obtain CSRF token');
                    }
                    return response.json();
                })
                .then(data => {
                    if (!data || !data.token) {
                        throw new Error('Response missing CSRF token');
                    }
                    cachedToken = data.token;
                    return cachedToken;
                })
                .catch(error => {
                    console.error('[CSRF] Token fetch failed:', error);
                    throw error;
                })
                .finally(() => {
                    pendingRequest = null;
                });
        }
        return pendingRequest;
    }

    async function getToken() {
        return fetchToken();
    }

    async function ensureTokenFields() {
        try {
            const token = await fetchToken();
            document.querySelectorAll('input[name="csrfToken"]').forEach(input => {
                input.value = token;
            });
        } catch (error) {
            console.error('[CSRF] Unable to populate hidden token fields:', error);
        }
    }

    async function withTokenHeaders(baseHeaders = {}) {
        const headers = { ...baseHeaders };
        try {
            const token = await fetchToken();
            headers[HEADER_NAME] = token;
        } catch (error) {
            console.error('[CSRF] Unable to attach token to headers:', error);
        }
        return headers;
    }

    document.addEventListener('DOMContentLoaded', ensureTokenFields);

    window.CSRF = {
        getToken,
        headerName: HEADER_NAME,
        ensureTokenFields,
        withTokenHeaders
    };
})(window, document);
