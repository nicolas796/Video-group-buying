// Login functionality
(function() {
    // Check if already logged in
    const token = localStorage.getItem('adminToken');
    if (token) {
        // Verify token is still valid by checking format
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            if (payload.exp && payload.exp > Date.now() / 1000) {
                // Token is valid, redirect to admin
                window.location.href = 'admin.html';
                return;
            }
        } catch (e) {
            // Invalid token, clear it
            localStorage.removeItem('adminToken');
        }
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
            showError('Please enter both username and password');
            return;
        }

        setLoading(true);

        try {
            // Fetch CSRF token first
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
                // Store token in localStorage
                localStorage.setItem('adminToken', data.token);
                // Redirect to admin dashboard
                window.location.href = 'admin.html';
            } else {
                showError(data.error || 'Invalid username or password');
            }
        } catch (error) {
            console.error('Login error:', error);
            showError('Network error. Please try again.');
        } finally {
            setLoading(false);
        }
    });

    // Clear any existing error on input
    document.getElementById('username').addEventListener('input', function() {
        errorMessage.classList.remove('show');
    });
    document.getElementById('password').addEventListener('input', function() {
        errorMessage.classList.remove('show');
    });
})();