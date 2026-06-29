// ================= GLOBAL STATE =================
const state = {
  activeModule: 'dashboard',
  customers: [],
  activeCustomerId: null,
  activeCustomer: null,
  transactions: [],
  debounceTimeout: null,
  language: 'en',
  theme: 'system',
  profile: null,
  tempProfilePic: undefined
};
window.state = state;

// ================= AUTH STATE =================
const auth = {
  isAuthenticated: false,
  token: null,
  user: null
};
window.auth = auth;

// Centralized API fetch that adds auth headers and handles 401
async function apiFetch(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (auth.token) {
    headers['Authorization'] = `Bearer ${auth.token}`;
  }
  const response = await fetch(url, { ...options, headers });
  if (response.status === 401) {
    // Session expired, redirect to login
    handleAuthRequired();
    throw new Error('Unauthenticated');
  }
  return response;
}

// ================= INITIALIZATION =================
document.addEventListener('DOMContentLoaded', () => {
  initLanguage();
  initTheme();
  setupAuthEventListeners();
  initGoogleLogin();
  initSessionRestore();
  setupConnectionMonitoring();

  // Create icons initially
  setTimeout(() => lucide.createIcons(), 50);
});

function setupConnectionMonitoring() {
  window.addEventListener('online', () => {
    showToast('Network connection restored. Online mode active.', 'success');
  });
  window.addEventListener('offline', () => {
    showToast('You are offline. Some features may be unavailable.', 'error');
  });
}

// Try to restore session from localStorage on load
async function initSessionRestore() {
  const savedToken = localStorage.getItem('auth_token');
  if (!savedToken) {
    showAuthPage('login');
    return;
  }
  auth.token = savedToken;
  try {
    const res = await fetch('/api/session-check', {
      headers: { 'Authorization': `Bearer ${savedToken}` }
    });
    if (res.ok) {
      const data = await res.json();
      auth.isAuthenticated = true;
      auth.user = data.user;
      auth.token = savedToken;
      onAuthSuccess(data.user);
    } else {
      localStorage.removeItem('auth_token');
      auth.token = null;
      showAuthPage('login');
    }
  } catch {
    showAuthPage('login');
  }
}

// Called after successful login/register to boot the app
function onAuthSuccess(user) {
  auth.isAuthenticated = true;
  auth.user = user;
  
  // Apply user language + theme preferences
  if (user.language) {
    state.language = user.language;
    applyLanguage(user.language);
    localStorage.setItem('lang', user.language);
  }
  if (user.theme) {
    applyTheme(user.theme);
  }

  // Hide auth pages, show app
  document.querySelectorAll('.auth-page-container').forEach(el => el.classList.add('hidden'));
  document.body.classList.remove('unauthenticated');
  document.body.classList.add('authenticated');

  // Boot app
  initRouter();
  initClock();
  initEventListeners();
  fetchModules();
  fetchProfile();
  
  setTimeout(() => lucide.createIcons(), 100);
}

// Show auth page (login | register | forgot)
function showAuthPage(page) {
  document.body.classList.add('unauthenticated');
  document.body.classList.remove('authenticated');
  document.querySelectorAll('.auth-page-container').forEach(el => el.classList.add('hidden'));
  
  const pageMap = {
    login: 'auth-login-page',
    register: 'auth-register-page',
    forgot: 'auth-forgot-page'
  };
  const el = document.getElementById(pageMap[page] || 'auth-login-page');
  if (el) {
    el.classList.remove('hidden');
    setTimeout(() => lucide.createIcons(), 50);
  }
}

// Handle any 401 — force re-login
function handleAuthRequired() {
  auth.isAuthenticated = false;
  auth.token = null;
  auth.user = null;
  localStorage.removeItem('auth_token');
  showAuthPage('login');
}

// Show auth toast message
function showAuthToast(message, isSuccess = false, duration = 4000) {
  const toast = document.getElementById('auth-error-toast');
  const msgEl = document.getElementById('auth-toast-message');
  if (!toast || !msgEl) return;
  msgEl.textContent = message;
  toast.classList.remove('hidden', 'auth-toast-success');
  if (isSuccess) toast.classList.add('auth-toast-success');
  lucide.createIcons();
  clearTimeout(toast._timeout);
  toast._timeout = setTimeout(() => toast.classList.add('hidden'), duration);
}

// ================= AUTH EVENT LISTENERS =================
function setupAuthEventListeners() {
  // --- Login Form ---
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const rememberMe = document.getElementById('login-remember-me').checked;
      const btn = document.getElementById('login-submit-btn');
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i><span>Signing in...</span>';
      lucide.createIcons();
      try {
        const res = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, rememberMe })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Login failed');
        auth.token = data.token;
        localStorage.setItem('auth_token', data.token);
        onAuthSuccess(data.user);
      } catch (err) {
        showAuthToast(err.message || 'Login failed. Please try again.');
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="log-in"></i><span data-i18n="sign_in">Sign In</span>';
        lucide.createIcons();
      }
    });
  }

  // --- Register Form ---
  const registerForm = document.getElementById('register-form');
  if (registerForm) {
    registerForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('reg-name').value.trim();
      const username = document.getElementById('reg-username').value.trim();
      const email = document.getElementById('reg-email').value.trim();
      const mobile = document.getElementById('reg-mobile').value.trim();
      const role = document.getElementById('reg-role').value;
      const password = document.getElementById('reg-password').value;
      const confirmPw = document.getElementById('reg-confirm-password').value;
      if (password !== confirmPw) {
        showAuthToast('Passwords do not match.');
        return;
      }
      const btn = document.getElementById('register-submit-btn');
      btn.disabled = true;
      btn.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i><span>Creating account...</span>';
      lucide.createIcons();
      try {
        const res = await fetch('/api/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, username, email, mobile, role, password })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Registration failed');
        auth.token = data.token;
        localStorage.setItem('auth_token', data.token);
        onAuthSuccess(data.user);
      } catch (err) {
        showAuthToast(err.message || 'Registration failed. Please try again.');
        btn.disabled = false;
        btn.innerHTML = '<i data-lucide="user-plus"></i><span data-i18n="create_account">Create Account</span>';
        lucide.createIcons();
      }
    });
  }

  // --- Forgot Password: Email Step ---
  const forgotEmailForm = document.getElementById('forgot-email-form');
  let forgotEmail = '';
  if (forgotEmailForm) {
    forgotEmailForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      forgotEmail = document.getElementById('forgot-email').value.trim();
      try {
        const res = await fetch('/api/forgot-password/request', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: forgotEmail })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Request failed');
        // Show demo code for development
        const step2 = document.getElementById('forgot-step-2');
        const step1 = document.getElementById('forgot-step-1');
        if (data.demo_code) {
          const banner = document.getElementById('demo-code-banner');
          const codeDisplay = document.getElementById('demo-code-display');
          if (banner) banner.style.display = 'flex';
          if (codeDisplay) codeDisplay.textContent = data.demo_code;
        }
        step1.classList.add('hidden');
        step2.classList.remove('hidden');
        lucide.createIcons();
      } catch (err) {
        showAuthToast(err.message || 'Failed to send reset code.');
      }
    });
  }

  // --- Forgot Password: Reset Step ---
  const forgotResetForm = document.getElementById('forgot-reset-form');
  if (forgotResetForm) {
    forgotResetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const code = document.getElementById('reset-code').value.trim();
      const newPw = document.getElementById('reset-new-password').value;
      const confirmPw = document.getElementById('reset-confirm-password').value;
      if (newPw !== confirmPw) { showAuthToast('Passwords do not match.'); return; }
      try {
        // Step 1: verify code
        const verifyRes = await fetch('/api/forgot-password/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: forgotEmail, code })
        });
        const verifyData = await verifyRes.json();
        if (!verifyRes.ok) throw new Error(verifyData.error || 'Invalid code');
        // Step 2: reset password
        const resetRes = await fetch('/api/forgot-password/reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: forgotEmail, reset_token: verifyData.reset_token, new_password: newPw })
        });
        const resetData = await resetRes.json();
        if (!resetRes.ok) throw new Error(resetData.error || 'Reset failed');
        showAuthToast('Password reset successfully! Please sign in.', true);
        showAuthPage('login');
      } catch (err) {
        showAuthToast(err.message || 'Password reset failed.');
      }
    });
  }

  // --- Navigation between auth pages ---
  document.getElementById('goto-register-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    showAuthPage('register');
  });
  document.getElementById('goto-login-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    showAuthPage('login');
  });
  document.getElementById('goto-forgot-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    showAuthPage('forgot');
    document.getElementById('forgot-step-1')?.classList.remove('hidden');
    document.getElementById('forgot-step-2')?.classList.add('hidden');
  });
  document.getElementById('back-to-login-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    showAuthPage('login');
  });

  // --- Password eye toggle buttons ---
  setupEyeToggle('login-pw-toggle', 'login-password', 'login-pw-icon');
  setupEyeToggle('reg-pw-toggle', 'reg-password', 'reg-pw-icon');
  setupEyeToggle('reg-confirm-pw-toggle', 'reg-confirm-password', 'reg-confirm-pw-icon');
  setupEyeToggle('reset-pw-toggle', 'reset-new-password', 'reset-pw-icon');

  // --- Logout buttons ---
  // NOTE: sheet-logout-btn and profile-logout-btn listeners are set in initProfileDropdown()
  // to avoid duplicate registration. Only the modal confirm/cancel buttons are set here.
  document.getElementById('profile-tab-logout-btn')?.addEventListener('click', showLogoutConfirmModal);
  document.getElementById('logout-cancel-btn')?.addEventListener('click', hideLogoutConfirmModal);
  document.getElementById('logout-confirm-btn')?.addEventListener('click', performLogout);
}

let googleClientId = null;
let googleResizeObserver = null;
let googleSignInProgress = false;

// Overlay functions to dim background during sign-in
function showGoogleAuthOverlay() {
  const overlay = document.getElementById('google-auth-overlay');
  if (overlay) {
    overlay.classList.remove('hidden');
    overlay.offsetHeight; // trigger reflow
    overlay.classList.add('active');
  }
  document.body.style.overflow = 'hidden';
}

function hideGoogleAuthOverlay() {
  const overlay = document.getElementById('google-auth-overlay');
  if (overlay) {
    overlay.classList.remove('active');
    setTimeout(() => {
      overlay.classList.add('hidden');
    }, 300);
  }
  document.body.style.overflow = '';
}

// Displays toast error/success messages on auth screens
function showAuthToast(message, isSuccess = false) {
  const toast = document.getElementById('auth-error-toast');
  const toastMsg = document.getElementById('auth-toast-message');
  if (!toast || !toastMsg) return;

  toastMsg.textContent = message;
  
  if (isSuccess) {
    toast.classList.remove('error');
    toast.classList.add('success');
    const icon = toast.querySelector('i');
    if (icon) {
      icon.setAttribute('data-lucide', 'check-circle');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  } else {
    toast.classList.remove('success');
    toast.classList.add('error');
    const icon = toast.querySelector('i');
    if (icon) {
      icon.setAttribute('data-lucide', 'alert-circle');
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }

  toast.classList.remove('hidden');
  toast.offsetHeight; // trigger reflow
  toast.classList.add('active');

  setTimeout(() => {
    toast.classList.remove('active');
    setTimeout(() => {
      toast.classList.add('hidden');
    }, 300);
  }, 4000);
}

// Renders the official Google button matching the parent width
function renderGoogleButton(container) {
  if (typeof google === 'undefined' || !googleClientId) return;
  const width = container.offsetWidth;
  if (width <= 0) return;

  google.accounts.id.renderButton(container, {
    type: 'standard',
    theme: 'outline',
    size: 'large',
    text: container.id === 'register-google-btn' ? 'signup_with' : 'signin_with',
    shape: 'rectangular',
    logo_alignment: 'center',
    width: width
  });
}

async function initGoogleLogin() {
  // Add click-away listener for the auth overlay
  document.getElementById('google-auth-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      hideGoogleAuthOverlay();
      googleSignInProgress = false;
    }
  });

  // Track window blur and focus to show/hide the dimming overlay when popup opens/closes
  window.addEventListener('blur', () => {
    const activeEl = document.activeElement;
    if (activeEl && activeEl.tagName === 'IFRAME' && activeEl.src && activeEl.src.includes('accounts.google.com')) {
      googleSignInProgress = true;
      showGoogleAuthOverlay();
    }
  });

  window.addEventListener('focus', () => {
    if (googleSignInProgress) {
      setTimeout(() => {
        if (!auth.isAuthenticated) {
          hideGoogleAuthOverlay();
        }
        googleSignInProgress = false;
      }, 1000);
    }
  });

  try {
    const res = await fetch('/api/config');
    if (!res.ok) return;
    const config = await res.json();
    googleClientId = config.googleClientId;

    if (googleClientId) {
      // Dynamic loading of Google GIS Script
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        setupGoogleSignInLive();
      };
      document.head.appendChild(script);
    } else {
      // Hide Google Sign-in containers and dividers if Client ID is not configured in env
      document.querySelectorAll('.google-btn-container').forEach(el => el.classList.add('hidden'));
      document.querySelectorAll('.auth-divider').forEach(el => el.classList.add('hidden'));
    }
  } catch (err) {
    console.error('Failed to load login config:', err);
  }
}

function setupGoogleSignInLive() {
  if (typeof google === 'undefined' || !googleClientId) return;

  const loginGoogleBtn = document.getElementById('login-google-btn');
  const registerGoogleBtn = document.getElementById('register-google-btn');

  // Initialize official GIS Client
  google.accounts.id.initialize({
    client_id: googleClientId,
    callback: handleGoogleCredentialResponse,
    auto_select: false
  });

  // Render official buttons
  if (loginGoogleBtn) renderGoogleButton(loginGoogleBtn);
  if (registerGoogleBtn) renderGoogleButton(registerGoogleBtn);

  // Set up ResizeObserver to automatically resize Google buttons on container width changes
  if (googleResizeObserver) {
    googleResizeObserver.disconnect();
  }

  let resizeTimeout;
  googleResizeObserver = new ResizeObserver((entries) => {
    for (let entry of entries) {
      clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        renderGoogleButton(entry.target);
      }, 150);
    }
  });

  if (loginGoogleBtn) googleResizeObserver.observe(loginGoogleBtn);
  if (registerGoogleBtn) googleResizeObserver.observe(registerGoogleBtn);
}

async function handleGoogleCredentialResponse(response) {
  const loginGoogleBtn = document.getElementById('login-google-btn');
  const registerGoogleBtn = document.getElementById('register-google-btn');
  
  // Safely set loading states (moved INSIDE the try block so errors are caught)
  try {
    // Set loading states
    if (loginGoogleBtn && !googleClientId) {
      loginGoogleBtn.disabled = true;
      loginGoogleBtn.innerHTML = '<i data-lucide="loader-2" class="spin-icon"></i><span>Verifying...</span>';
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
    
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        credential: response.credential,
        clientId: googleClientId 
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Authentication failed');
    
    auth.token = data.token;
    localStorage.setItem('auth_token', data.token);
    onAuthSuccess(data.user);
  } catch (err) {
    console.error('Google Auth Error:', err);
    showAuthToast(err.message || 'Google authentication failed.');
    
    // Restore button states
    if (loginGoogleBtn && !googleClientId) {
      loginGoogleBtn.disabled = false;
      loginGoogleBtn.innerHTML = `
        <svg class="google-icon" viewBox="0 0 24 24" width="18" height="18" xmlns="http://www.w3.org/2000/svg">
          <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
          <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.537 23 12 23z" fill="#34A853"/>
          <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
          <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" fill="#EA4335"/>
        </svg>
        <span data-i18n="google_sign_in">Sign in with Google</span>
      `;
      if (typeof lucide !== 'undefined') lucide.createIcons();
    }
  }
}

function setupEyeToggle(btnId, inputId, iconId) {
  const btn = document.getElementById(btnId);
  const input = document.getElementById(inputId);
  if (!btn || !input) return;
  btn.addEventListener('click', () => {
    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';
    const iconEl = document.getElementById(iconId);
    if (iconEl) {
      iconEl.setAttribute('data-lucide', isPassword ? 'eye-off' : 'eye');
      lucide.createIcons();
    }
  });
}

function showLogoutConfirmModal() {
  const modal = document.getElementById('logout-confirm-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('active');
    lucide.createIcons();
  }
}

function hideLogoutConfirmModal() {
  const modal = document.getElementById('logout-confirm-modal');
  if (modal) {
    modal.classList.remove('active');
    modal.classList.add('hidden');
  }
}

async function performLogout() {
  hideLogoutConfirmModal();
  try {
    await fetch('/api/logout', {
      method: 'POST',
      headers: auth.token ? { 'Authorization': `Bearer ${auth.token}` } : {}
    });
  } catch (err) {
    console.error('Logout API error:', err);
  }
  auth.isAuthenticated = false;
  auth.token = null;
  auth.user = null;
  localStorage.removeItem('auth_token');
  showAuthPage('login');
}


function initLanguage() {
  const storedLang = localStorage.getItem('lang') || 'en';
  state.language = storedLang;
  applyLanguage(storedLang);
}

// ================= THEME CONTROLLER =================
function initTheme() {
  const storedTheme = localStorage.getItem('theme');
  const initialTheme = storedTheme || 'system';
  
  state.theme = initialTheme;
  applyTheme(initialTheme);
  
  const themeToggle = document.getElementById('theme-toggle-btn');
  if (themeToggle) {
    themeToggle.addEventListener('click', () => {
      const currentTheme = state.theme || 'system';
      const themeCycle = { light: 'dark', dark: 'system', system: 'light' };
      const newTheme = themeCycle[currentTheme] || 'system';

      applyTheme(newTheme);

      if (state.profile) {
        state.profile.theme = newTheme;
        apiFetch('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(state.profile)
        }).catch(err => console.error('Failed to sync theme:', err));

        const prefThemeSelect = document.getElementById('pref-theme');
        if (prefThemeSelect) prefThemeSelect.value = newTheme;

        updateProfileUI();
        updateProfileSubViews();
      }
    });
  }

  // Listen for system theme changes
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.theme === 'system') {
      applyTheme('system');
    }
  });
}

function applyTheme(theme) {
  state.theme = theme;
  let resolvedTheme = theme;
  if (theme === 'system') {
    resolvedTheme = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', resolvedTheme);
  localStorage.setItem('theme', theme);
  
  const iconEl = document.getElementById('theme-toggle-icon');
  if (iconEl) {
    if (resolvedTheme === 'dark') {
      iconEl.setAttribute('data-lucide', 'sun');
    } else {
      iconEl.setAttribute('data-lucide', 'moon');
    }
    setTimeout(() => lucide.createIcons(), 0);
  }
}

function setTheme(theme) {
  applyTheme(theme);
}

// ================= CLOCK =================
function initClock() {
  const clockEl = document.getElementById('sidebar-clock');
  
  function updateTime() {
    const now = new Date();
    const tz = (state.profile && state.profile.timezone) ? state.profile.timezone : 'Asia/Kolkata';
    
    let tzCode = 'IST';
    if (tz === 'UTC') tzCode = 'UTC';
    else if (tz === 'America/New_York') tzCode = 'EST';
    else if (tz === 'Europe/London') tzCode = 'GMT/BST';
    else if (tz === 'Asia/Singapore') tzCode = 'SGT';
    else if (tz === 'Australia/Sydney') tzCode = 'AEST';
    else tzCode = tz.split('/').pop().replace('_', ' ');

    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
      hour12: true
    });
    try {
      const timeParts = formatter.formatToParts(now);
      const hour = timeParts.find(p => p.type === 'hour').value.padStart(2, '0');
      const minute = timeParts.find(p => p.type === 'minute').value;
      const second = timeParts.find(p => p.type === 'second').value;
      const dayPeriod = timeParts.find(p => p.type === 'dayPeriod').value;
      clockEl.textContent = `${hour}:${minute}:${second} ${dayPeriod} ${tzCode}`;
    } catch (e) {
      clockEl.textContent = now.toLocaleTimeString();
    }
  }
  
  updateTime();
  setInterval(updateTime, 1000);
}

// ================= ROUTING =================
function initRouter() {
  window.addEventListener('hashchange', handleRoute);
  handleRoute();
}

function handleRoute() {
  let hash = window.location.hash || '#dashboard';
  // Normalize underscore to hyphen for routing compatibility
  hash = hash.replace(/_/g, '-');

  // Track scroll position of the module we are leaving
  const previousHash = state.currentActiveHash || '#dashboard';
  const viewContent = document.querySelector('.view-content');
  if (viewContent && state.activeModule) {
    state.scrollPositions = state.scrollPositions || {};
    state.scrollPositions[previousHash] = viewContent.scrollTop;
  }
  state.currentActiveHash = hash;

  // Track route history to handle Back navigation correctly
  state.routeHistory = state.routeHistory || [];
  const historyLength = state.routeHistory.length;
  if (state.replacingRoute) {
    state.routeHistory[state.routeHistory.length - 1] = hash;
    state.replacingRoute = false;
  } else if (historyLength > 1 && state.routeHistory[historyLength - 2] === hash) {
    state.routeHistory.pop(); // User went back
  } else if (state.routeHistory[historyLength - 1] !== hash) {
    state.routeHistory.push(hash); // User went forward
  }
  
  const views = ['dashboard', 'khata-book', 'aadhaar-cards', 'bank-accounts', 'profile-settings'];
  // Profile sub-routes
  const profileSubRoutes = ['profile', 'profile/edit', 'profile/preferences', 'profile/security', 'profile/activity', 'profile/backup'];
  const profileSubViews = ['profile-my', 'profile-edit', 'profile-preferences', 'profile-security', 'profile-activity', 'profile-backup'];
  
  let targetView = 'dashboard';
  let customerId = null;
  let isProfileSub = false;
  let currentProfileSub = null;

  if (hash.startsWith('#customer/')) {
    targetView = 'khata-book';
    customerId = hash.split('/')[1];
    document.body.classList.add('customer-selected');
  } else if (hash.startsWith('#profile/') || hash === '#profile') {
    const sub = hash.substring(1); // 'profile' or 'profile/edit' etc.
    if (profileSubRoutes.includes(sub)) {
      isProfileSub = true;
      currentProfileSub = sub === 'profile' ? 'profile-my' : sub.replace('/', '-');
      targetView = 'profile-settings'; // Highlights the sidebar nav
      document.body.classList.remove('customer-selected');
    } else {
      document.body.classList.remove('customer-selected');
      targetView = 'profile-settings';
    }
  } else {
    document.body.classList.remove('customer-selected');
    const matchedView = hash.substring(1);
    if (views.includes(matchedView)) {
      targetView = matchedView;
    }
  }

  // Toggle route class on body
  if (targetView === 'dashboard') {
    document.body.classList.add('route-dashboard');
  } else {
    document.body.classList.remove('route-dashboard');
  }

  // Update desktop menu item states
  document.querySelectorAll('.menu-item').forEach(item => {
    item.classList.remove('active');
  });
  const activeNav = document.getElementById(`nav-${targetView}`);
  if (activeNav) activeNav.classList.add('active');

  // Update mobile bottom nav items states
  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.classList.remove('active');
  });
  const activeMobileNav = document.getElementById(`mobile-nav-${targetView}`);
  if (activeMobileNav) activeMobileNav.classList.add('active');

  // Back to Dashboard / Customer List button in Header
  const backBtn = document.getElementById('header-back-btn');
  if (isProfileSub) {
    backBtn.classList.remove('hidden');
    backBtn.setAttribute('href', '#profile-settings');
    backBtn.querySelector('span').textContent = t('back');
  } else if (targetView === 'dashboard') {
    backBtn.classList.add('hidden');
  } else {
    backBtn.classList.remove('hidden');
    if (customerId) {
      backBtn.setAttribute('href', '#khata-book');
      backBtn.querySelector('span').textContent = t('khata_book');
    } else {
      backBtn.setAttribute('href', '#dashboard');
      backBtn.querySelector('span').textContent = t('back');
    }
  }

  // Update Page Title in header
  if (isProfileSub && currentProfileSub) {
    const titleKeyMap = {
      'profile-my': 'my_profile',
      'profile-edit': 'edit_profile',
      'profile-preferences': 'preferences',
      'profile-security': 'security',
      'profile-activity': 'activity_log',
      'profile-backup': 'backup_export'
    };
    const titleKey = titleKeyMap[currentProfileSub] || 'profile_settings';
    document.getElementById('page-title').textContent = t(titleKey);
  } else {
    const titleKey = targetView.replace(/-/g, '_');
    document.getElementById('page-title').textContent = t(titleKey);
  }

  // Show/Hide views
  if (isProfileSub && currentProfileSub) {
    // Hide all main views
    views.forEach(v => {
      const viewEl = document.getElementById(`view-${v}`);
      if (viewEl) viewEl.classList.remove('active-view');
    });
    // Show/hide profile sub-views
    profileSubViews.forEach(pv => {
      const viewEl = document.getElementById(`view-${pv}`);
      if (viewEl) {
        if (pv === currentProfileSub) {
          viewEl.classList.add('active-view');
        } else {
          viewEl.classList.remove('active-view');
        }
      }
    });
  } else {
    // Show/hide main views
    views.forEach(v => {
      const viewEl = document.getElementById(`view-${v}`);
      if (viewEl) {
        if (v === targetView) {
          viewEl.classList.add('active-view');
        } else {
          viewEl.classList.remove('active-view');
        }
      }
    });
    // Hide all profile sub-views
    profileSubViews.forEach(pv => {
      const viewEl = document.getElementById(`view-${pv}`);
      if (viewEl) viewEl.classList.remove('active-view');
    });
  }

  state.activeModule = targetView;

  // Handle specific module routing actions
  if (targetView === 'dashboard') {
    fetchDashboardStats();
  } else if (targetView === 'khata-book') {
    fetchCustomers().then(() => {
      if (customerId) {
        selectCustomer(customerId);
      } else {
        deselectCustomer();
      }
    });
  } else if (targetView === 'profile-settings') {
    if (!isProfileSub) {
      // Main profile-settings view: show the menu grid (handled by CSS)
    } else if (currentProfileSub === 'profile-activity') {
      // Activity sub-page: fetch activity logs
      fetchActivityLogs();
    } else if (currentProfileSub === 'profile-backup') {
      // Backup sub-page: fetch backup history
      fetchBackupHistory();
    }
    // My Profile, Edit, Preferences, Security sub-pages will populate via updateProfileUI
    updateProfileSubViews();
  }
  
  translatePage();
  
  // Restore scroll position
  if (viewContent) {
    setTimeout(() => {
      const savedScroll = state.scrollPositions && state.scrollPositions[hash];
      viewContent.scrollTop = savedScroll !== undefined ? savedScroll : 0;
    }, 50);
  }
  
  // Close mobile menu if open
  const sidebar = document.querySelector('.app-sidebar');
  if (sidebar) sidebar.classList.remove('mobile-open');
}

// ================= EVENT LISTENERS =================
function initEventListeners() {
  // Global Back Navigation Handler to preserve page states and avoid duplicate history entries
  document.addEventListener('click', (e) => {
    const backBtn = e.target.closest('.profile-back-btn, #header-back-btn');
    if (backBtn) {
      const href = backBtn.getAttribute('href');
      if (href) {
        e.preventDefault();
        state.routeHistory = state.routeHistory || [];
        const historyLength = state.routeHistory.length;
        const prevRoute = historyLength > 1 ? state.routeHistory[historyLength - 2] : null;
        
        if (prevRoute === href) {
          window.history.back();
        } else {
          state.replacingRoute = true;
          window.location.replace(href);
        }
      }
    }
  });

  // Mobile menu toggle
  document.getElementById('mobile-menu-btn').addEventListener('click', () => {
    document.querySelector('.app-sidebar').classList.toggle('mobile-open');
  });

  // Customer List Search, Filters, and Sorting
  const searchInput = document.getElementById('customer-search-input');
  const sortSelect = document.getElementById('customer-sort-select');
  const filterBalance = document.getElementById('customer-filter-balance');
  const filterActivity = document.getElementById('customer-filter-activity');

  const triggerSearch = () => {
    clearTimeout(state.debounceTimeout);
    state.debounceTimeout = setTimeout(() => {
      fetchCustomers();
    }, 300);
  };

  searchInput.addEventListener('input', triggerSearch);
  sortSelect.addEventListener('change', fetchCustomers);
  filterBalance.addEventListener('change', fetchCustomers);
  filterActivity.addEventListener('change', fetchCustomers);

  // Customer Modal actions
  document.getElementById('open-add-customer-modal-btn').addEventListener('click', () => {
    openCustomerModal();
  });
  document.getElementById('customer-modal-close-btn').addEventListener('click', closeCustomerModal);
  document.getElementById('customer-modal-cancel-btn').addEventListener('click', closeCustomerModal);
  document.getElementById('customer-form').addEventListener('submit', handleCustomerFormSubmit);

  // Edit/Delete customer actions
  document.getElementById('edit-customer-btn').addEventListener('click', () => {
    if (state.activeCustomer) {
      openCustomerModal(state.activeCustomer);
    }
  });

  document.getElementById('delete-customer-btn').addEventListener('click', () => {
    if (state.activeCustomer) {
      openConfirmModal(
        'Delete Customer Account',
        `Are you sure you want to delete the ledger account for <strong>${state.activeCustomer.name}</strong>? This will permanently delete all associated transaction history.`,
        async () => {
          try {
            const res = await fetch(`/api/customers/${state.activeCustomerId}`, { method: 'DELETE' });
            if (!res.ok) {
              const err = await res.json();
              throw new Error(err.error || 'Failed to delete customer');
            }
            showToast('Customer ledger deleted successfully', 'success');
            window.location.hash = '#khata-book';
          } catch (error) {
            showToast(error.message, 'error');
          }
        },
        'Yes, Delete'
      );
    }
  });

  // Transactions Filter actions
  const filterNotesSearch = document.getElementById('filter-notes-search');
  if (filterNotesSearch) {
    filterNotesSearch.addEventListener('input', () => {
      clearTimeout(state.debounceTimeout);
      state.debounceTimeout = setTimeout(() => fetchTransactions(state.activeCustomerId), 300);
    });
  }

  const filterTxnType = document.getElementById('filter-txn-type');
  if (filterTxnType) {
    filterTxnType.addEventListener('change', () => fetchTransactions(state.activeCustomerId));
  }

  const filterTxnSort = document.getElementById('filter-txn-sort');
  if (filterTxnSort) {
    filterTxnSort.addEventListener('change', () => fetchTransactions(state.activeCustomerId));
  }

  // Transaction Modal actions
  document.getElementById('open-add-txn-modal-btn').addEventListener('click', () => {
    openTxnModal();
  });
  document.getElementById('txn-modal-close-btn').addEventListener('click', closeTxnModal);
  document.getElementById('txn-modal-cancel-btn').addEventListener('click', closeTxnModal);
  document.getElementById('txn-form').addEventListener('submit', handleTxnFormSubmit);

  // Statement Actions (Download, Print, Share, Export)
  document.getElementById('download-statement-btn').addEventListener('click', () => {
    if (!state.activeCustomerId) return;
    const start = document.getElementById('stmt-start-date').value;
    const end = document.getElementById('stmt-end-date').value;
    
    let url = `/api/customers/${state.activeCustomerId}/statement`;
    const params = [];
    if (start) params.push(`start_date=${start}`);
    if (end) params.push(`end_date=${end}`);
    if (params.length > 0) {
      url += `?${params.join('&')}`;
    }

    showToast(t('preparing_pdf') || 'Preparing PDF statement...', 'info');

    apiFetch(url)
      .then(async (res) => {
        if (!res.ok) throw new Error('Failed to download PDF');
        const blob = await res.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        
        const disposition = res.headers.get('content-disposition');
        let filename = `${state.activeCustomer ? state.activeCustomer.name.replace(/\s+/g, '_') : 'customer'}_statement.pdf`;
        if (disposition && disposition.indexOf('attachment') !== -1) {
          const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
          const matches = filenameRegex.exec(disposition);
          if (matches != null && matches[1]) {
            filename = matches[1].replace(/['"]/g, '');
          }
        }
        
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(blobUrl);
        showToast('PDF downloaded successfully!', 'success');
      })
      .catch(err => {
        console.error('PDF download error:', err);
        showToast('Failed to download PDF. Please try again.', 'error');
      });
  });

  document.getElementById('print-statement-btn').addEventListener('click', () => {
    window.print();
  });

  document.getElementById('share-statement-btn').addEventListener('click', () => {
    if (!state.activeCustomer) return;
    const text = `Hello ${state.activeCustomer.name}, your Khata Book balance is Rs. ${Math.abs(state.activeCustomer.current_balance).toFixed(2)} (${state.activeCustomer.current_balance < 0 ? 'You owe' : 'Advance Paid'}).`;
    const shareUrl = `https://api.whatsapp.com/send?phone=${state.activeCustomer.mobile || ''}&text=${encodeURIComponent(text)}`;
    
    openConfirmModal(
      'Share Statement',
      `Would you like to share this statement summary via WhatsApp to <strong>${state.activeCustomer.name}</strong>?`,
      () => {
        window.open(shareUrl, '_blank');
        showToast('Redirecting to WhatsApp...', 'success');
      }
    );
  });

  document.getElementById('export-statement-btn').addEventListener('click', exportToCSV);

  // Global overlay click to close modals
  document.querySelectorAll('.modal-overlay').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) {
        closeCustomerModal();
        closeTxnModal();
        closeConfirmModal();
      }
    });
  });

  // Customer Add Transaction button (action section)
  const customerAddBtn = document.getElementById('customer-add-txn-btn');
  if (customerAddBtn) {
    customerAddBtn.addEventListener('click', () => openTxnModal());
  }

  // Mobile Download Statement button (action section)
  const mobileDownloadBtn = document.getElementById('download-statement-btn-mobile');
  if (mobileDownloadBtn) {
    mobileDownloadBtn.addEventListener('click', () => {
      const mainDownload = document.getElementById('download-statement-btn');
      if (mainDownload) mainDownload.click();
    });
  }

  // Profile Dropdown Toggle & Links
  initProfileDropdown();

  // Edit Profile Picture Upload and Remove events
  initProfilePhotoEvents();

  // Settings Form Submissions
  initSettingsFormEvents();

  // Backup & Export buttons
  initBackupButtons();
}

// ================= DASHBOARD STATISTICS LOGIC =================
async function fetchDashboardStats() {
  try {
    const res = await apiFetch('/api/dashboard/stats');
    if (!res.ok) throw new Error('Failed to fetch dashboard stats');
    const data = await res.json();
    
    const welcomeEl = document.getElementById('dashboard-welcome-heading');
    if (welcomeEl) welcomeEl.textContent = t('welcome_title');

    // Set statistical figures
    document.getElementById('dash-receivables').textContent = `Rs. ${data.totalReceivable.toFixed(2)}`;
    document.getElementById('dash-payables').textContent = `Rs. ${data.totalPayable.toFixed(2)}`;
    
    const netValEl = document.getElementById('dash-net-balance');
    const netStatusEl = document.getElementById('dash-net-status');
    const netCardEl = document.getElementById('dash-net-card');
    
    const absNet = Math.abs(data.netBalance);
    netValEl.textContent = `Rs. ${absNet.toFixed(2)}`;
    
    if (data.netBalance < 0) { // Net receivable (totalReceivable > totalPayable)
      netValEl.className = 'dash-stat-value text-red';
      netStatusEl.textContent = t('net_receivable');
      netStatusEl.className = 'dash-stat-sub text-red';
      netCardEl.style.borderColor = 'rgba(244, 63, 94, 0.2)';
    } else if (data.netBalance > 0) { // Net payable
      netValEl.className = 'dash-stat-value text-green';
      netStatusEl.textContent = t('net_payable');
      netStatusEl.className = 'dash-stat-sub text-green';
      netCardEl.style.borderColor = 'rgba(16, 185, 129, 0.2)';
    } else {
      netValEl.className = 'dash-stat-value';
      netStatusEl.textContent = t('ledger_balanced');
      netStatusEl.className = 'dash-stat-sub';
      netCardEl.style.borderColor = 'var(--border-color)';
    }

    document.getElementById('dash-customers-count').textContent = data.totalCustomers;
    document.getElementById('dash-customers-active').textContent = `${data.activeCustomers} ${t('active_ledgers')}`;

    // Render Recent Timeline
    const timelineContainer = document.getElementById('dash-recent-timeline');
    timelineContainer.innerHTML = '';

    if (data.recentTransactions.length === 0) {
      timelineContainer.innerHTML = '<div class="timeline-empty"><i data-lucide="info"></i> ' + t('no_entries_found') + '</div>';
      lucide.createIcons();
      return;
    }

    data.recentTransactions.forEach(txn => {
      const isCredit = txn.type === 'credit';
      const typeClass = isCredit ? 'credit' : 'debit';
      const typeLabel = isCredit ? t('credit_received') : t('debit_given');
      const amountSign = isCredit ? '+' : '-';
      const textClass = isCredit ? 'text-green' : 'text-red';
      
      const fmt = formatDateDisplay(txn.timestamp);

      const item = document.createElement('div');
      item.className = `timeline-item ${typeClass}`;
      item.innerHTML = `
        <div class="timeline-badge-indicator"></div>
        <div class="timeline-item-body">
          <div class="timeline-item-header">
            <span class="timeline-customer-name">${txn.customer_name}</span>
            <span class="timeline-amount ${textClass}">${amountSign} Rs. ${txn.amount.toFixed(2)}</span>
          </div>
          <p class="timeline-note">${txn.note || '<span class="timeline-no-note">' + t('no_description') + '</span>'}</p>
          <div class="timeline-meta">
            <span>${fmt.dateStr} at ${fmt.timeStr}</span>
            <span class="timeline-type-lbl ${typeClass}">${typeLabel}</span>
          </div>
        </div>
      `;
      timelineContainer.appendChild(item);
    });

    lucide.createIcons();
  } catch (error) {
    if (error.message !== 'Unauthenticated') {
      showToast(error.message, 'error');
    }
  }
}

// ================= TOAST ALERTS =================
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  
  const icon = type === 'success' ? 'check-circle' : 'alert-triangle';
  toast.innerHTML = `
    <i data-lucide="${icon}"></i>
    <span class="toast-message">${message}</span>
    <button class="toast-close" aria-label="Close">&times;</button>
  `;
  
  toast.querySelector('.toast-close').addEventListener('click', () => toast.remove());
  
  container.appendChild(toast);
  lucide.createIcons();

  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 4000);
}

// ================= MODULE LOADING =================
async function fetchModules() {
  try {
    const res = await apiFetch('/api/modules');
    const modules = await res.json();
    
    const container = document.getElementById('modules-container');
    container.innerHTML = '';
    
    modules.forEach(mod => {
      const card = document.createElement('div');
      const isComing = mod.status === 'coming_soon';
      card.className = `module-card ${isComing ? 'coming-soon' : ''}`;
      
      const badgeHtml = isComing ? `<span class="badge-coming-soon">COMING SOON</span>` : '';
      const actionHtml = isComing 
        ? `<span class="card-action-btn">Preview Details</span>`
        : `<span class="card-action-btn">Open Ledger <i data-lucide="arrow-right"></i></span>`;

      card.innerHTML = `
        <div class="module-icon-container">
          <i data-lucide="${mod.icon}"></i>
        </div>
        <div class="module-card-footer">
          <h3>${mod.name}</h3>
          ${badgeHtml}
        </div>
        <p>${mod.description}</p>
        ${actionHtml}
      `;

      card.addEventListener('click', () => {
        window.location.hash = `#${mod.id}`;
      });

      container.appendChild(card);
    });
    
    lucide.createIcons();
  } catch (error) {
    showToast('Failed to fetch dashboard modules', 'error');
  }
}

// ================= CUSTOMERS LOGIC =================
async function fetchCustomers() {
  const searchVal = document.getElementById('customer-search-input').value;
  const sortVal = document.getElementById('customer-sort-select').value;
  const balanceVal = document.getElementById('customer-filter-balance').value;
  const activityVal = document.getElementById('customer-filter-activity').value;

  try {
    let url = `/api/customers?sortBy=${sortVal}&balanceFilter=${balanceVal}&activityFilter=${activityVal}`;
    if (searchVal) url += `&search=${encodeURIComponent(searchVal)}`;
    
    const res = await apiFetch(url);
    state.customers = await res.json();
    
    renderCustomersList();
  } catch (error) {
    if (error.message !== 'Unauthenticated') {
      showToast('Failed to load customers list', 'error');
    }
  }
}

function renderCustomersList() {
  const ul = document.getElementById('customers-list-ul');
  ul.innerHTML = '';

  if (state.customers.length === 0) {
    ul.innerHTML = '<li style="padding:24px; text-align:center; color:var(--text-muted); font-size:13px;">' + t('no_customers') + '</li>';
    return;
  }

  state.customers.forEach(cust => {
    const li = document.createElement('li');
    li.className = `customer-list-item ${state.activeCustomerId === cust.id ? 'active' : ''}`;
    
    const absBal = Math.abs(cust.current_balance);
    let balColor = 'var(--text-muted)';
    let balLabel = t('settled');
    if (cust.current_balance > 0) {
      balColor = 'var(--color-credit)';
      balLabel = t('positive_balance');
    } else if (cust.current_balance < 0) {
      balColor = 'var(--color-debit)';
      balLabel = t('negative_balance');
    }

    const createdText = cust.created_at ? cust.created_at.substring(0, 10) : '-';
    const lastActiveText = cust.latest_activity ? cust.latest_activity.substring(0, 10) : t('no_description');

    const nameInitials = cust.name ? cust.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2) : 'KB';
    let nameHash = 0;
    for (let i = 0; i < cust.name.length; i++) {
      nameHash += cust.name.charCodeAt(i);
    }
    const colorIndex = (nameHash % 6) + 1;

    li.innerHTML = `
      <div class="cust-avatar-wrapper avatar-color-${colorIndex}">
        <span>${nameInitials}</span>
      </div>
      <div class="cust-item-main">
        <span class="cust-item-name">${cust.name}</span>
        <span class="cust-item-phone">${cust.mobile || t('no_phone')}</span>
        <span class="cust-item-phone" style="font-size:10px; opacity:0.8; margin-top:4px;">
          Opened: ${createdText} | Active: ${lastActiveText}
        </span>
      </div>
      <div class="cust-item-balance">
        <span class="cust-balance-amt" style="color: ${balColor}">Rs. ${absBal.toFixed(2)}</span>
        <span class="cust-balance-lbl" style="color: ${balColor}">${balLabel}</span>
      </div>
    `;

    li.addEventListener('click', () => {
      window.location.hash = `#customer/${cust.id}`;
    });

    ul.appendChild(li);
  });
}

function selectCustomer(id) {
  state.activeCustomerId = id;
  const customer = state.customers.find(c => c.id === id);
  
  if (!customer) {
    deselectCustomer();
    return;
  }
  
  state.activeCustomer = customer;
  
  // Highlight active sidebar item
  document.querySelectorAll('.customer-list-item').forEach(item => item.classList.remove('active'));
  renderCustomersList(); // Refresh sidebar active state

  // Show ledger details container
  document.getElementById('ledger-placeholder-view').classList.add('hidden');
  document.getElementById('ledger-active-view').classList.remove('hidden');

  // Update header title to customer name
  const titleEl = document.getElementById('page-title');
  if (titleEl) {
    titleEl.textContent = customer.name;
  }

  // Load ledger details
  loadLedger(id);
}

function deselectCustomer() {
  state.activeCustomerId = null;
  state.activeCustomer = null;
  
  // Revert header title
  const titleEl = document.getElementById('page-title');
  if (titleEl) {
    titleEl.textContent = '📒 ' + t('khata_book');
  }
  
  document.getElementById('ledger-placeholder-view').classList.remove('hidden');
  document.getElementById('ledger-active-view').classList.add('hidden');
}

async function loadLedger(customerId) {
  try {
    const res = await apiFetch(`/api/customers/${customerId}`);
    if (!res.ok) throw new Error('Failed to load customer profile');
    const customer = await res.json();
    
    state.activeCustomer = customer;

    // Render Header details
    document.getElementById('ledger-cust-name').textContent = customer.name;
    document.getElementById('ledger-cust-phone').textContent = customer.mobile || t('no_phone');
    document.getElementById('ledger-cust-created').textContent = customer.created_at.substring(0, 10);
    document.getElementById('ledger-cust-last-active').textContent = customer.last_transaction_date 
      ? customer.last_transaction_date.substring(0, 10) 
      : t('no_description');

    // Populate the new Profile Banner details
    document.getElementById('ledger-profile-name').textContent = customer.name;
    document.getElementById('ledger-profile-mobile-sub').textContent = customer.mobile ? `${t('mobile')}: ${customer.mobile}` : t('no_phone');
    
    // Initials for large avatar
    const largeInitials = customer.name ? customer.name.split(' ').map(n => n[0]).join('').toUpperCase().substring(0, 2) : 'KB';
    const avatarEl = document.getElementById('ledger-cust-avatar');
    avatarEl.textContent = largeInitials;
    
    // Consistent color class for details page avatar
    let detailHash = 0;
    for (let i = 0; i < customer.name.length; i++) {
      detailHash += customer.name.charCodeAt(i);
    }
    const detailColorIndex = (detailHash % 6) + 1;
    avatarEl.className = `cust-large-avatar detail-avatar-color-${detailColorIndex}`;

    // Account status badge styling
    const statusBadge = document.getElementById('ledger-profile-status');
    if (customer.total_transactions > 0) {
      statusBadge.textContent = t('active_ledger');
      statusBadge.className = 'status-badge active';
    } else {
      statusBadge.textContent = t('inactive_account');
      statusBadge.className = 'status-badge inactive';
    }

    // Render Balance Cards
    const absBal = Math.abs(customer.current_balance);
    const balanceValEl = document.getElementById('summary-balance-val');
    const balanceStatusEl = document.getElementById('summary-balance-status');
    const balanceCard = document.getElementById('summary-card-balance');

    balanceValEl.textContent = `Rs. ${absBal.toFixed(2)}`;
    balanceValEl.className = 'summary-card-value';
    balanceCard.style.borderColor = 'var(--border-color)';
    
    if (customer.current_balance > 0) {
      balanceValEl.classList.add('text-green');
      balanceStatusEl.textContent = t('advance_repayable');
      balanceStatusEl.className = 'summary-card-status text-green';
      balanceCard.style.borderColor = 'rgba(16, 185, 129, 0.3)';
    } else if (customer.current_balance < 0) {
      balanceValEl.classList.add('text-red');
      balanceStatusEl.textContent = t('pending_dues');
      balanceStatusEl.className = 'summary-card-status text-red';
      balanceCard.style.borderColor = 'rgba(244, 63, 94, 0.3)';
    } else {
      balanceStatusEl.textContent = t('account_settled');
      balanceStatusEl.className = 'summary-card-status';
    }

    document.getElementById('summary-credit-val').textContent = `Rs. ${customer.total_credit.toFixed(2)}`;
    document.getElementById('summary-debit-val').textContent = `Rs. ${customer.total_debit.toFixed(2)}`;
    document.getElementById('summary-count-val').textContent = customer.total_transactions || 0;
    
    document.getElementById('summary-activity-val').textContent = customer.last_transaction_date 
      ? customer.last_transaction_date.substring(0, 16) 
      : t('no_description');

    // Set dates in statement download filters to match creation
    document.getElementById('stmt-start-date').min = customer.created_at.substring(0, 10);
    document.getElementById('stmt-end-date').value = new Date().toISOString().substring(0, 10);

    // Fetch and display Transactions
    fetchTransactions(customerId);
    
    lucide.createIcons();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

function updateDisplayOptions() {
  const showSummary = document.getElementById('toggle-opt-summary').checked;
  const showBalance = document.getElementById('toggle-opt-balance').checked;
  const showCredits = document.getElementById('toggle-opt-credits').checked;
  const showDebits = document.getElementById('toggle-opt-debits').checked;

  const panel = document.getElementById('ledger-summary-panel');
  const balanceCard = document.getElementById('summary-card-balance');
  const creditCard = document.getElementById('summary-card-credits');
  const debitCard = document.getElementById('summary-card-debits');
  const countCard = document.getElementById('summary-card-count');
  const activityCard = document.getElementById('summary-card-activity');

  if (!showSummary) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');

  if (showBalance) balanceCard.classList.remove('hidden');
  else balanceCard.classList.add('hidden');

  if (showCredits) creditCard.classList.remove('hidden');
  else creditCard.classList.add('hidden');

  if (showDebits) debitCard.classList.remove('hidden');
  else debitCard.classList.add('hidden');
}

async function fetchTransactions(customerId) {
  if (!customerId) return;
  
  const startDate = document.getElementById('filter-start-date')?.value || '';
  const endDate = document.getElementById('filter-end-date')?.value || '';
  const type = document.getElementById('filter-txn-type')?.value || '';
  const sortBy = document.getElementById('filter-txn-sort')?.value || 'date_desc';
  const minAmt = document.getElementById('filter-min-amount')?.value || '';
  const maxAmt = document.getElementById('filter-max-amount')?.value || '';
  const notes = document.getElementById('filter-notes-search')?.value || '';

  try {
    let url = `/api/customers/${customerId}/transactions?sortBy=${sortBy}`;
    const params = [];
    if (startDate) params.push(`start_date=${startDate}`);
    if (endDate) params.push(`end_date=${endDate}`);
    if (type) params.push(`type=${type}`);
    if (minAmt) params.push(`min_amount=${minAmt}`);
    if (maxAmt) params.push(`max_amount=${maxAmt}`);
    if (notes) params.push(`note_search=${encodeURIComponent(notes)}`);

    if (params.length > 0) {
      url += '&' + params.join('&');
    }

    const res = await apiFetch(url);
    state.transactions = await res.json();

    renderTransactionsList();
  } catch (error) {
    if (error.message !== 'Unauthenticated') {
      showToast('Failed to load transaction ledger', 'error');
    }
  }
}

function formatDateDisplay(timestamp) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [datePart, timePart] = timestamp.split(' ');
  const [y, m, d] = datePart.split('-');
  const monthName = months[parseInt(m) - 1];
  const day = parseInt(d);
  const [h, min] = timePart.split(':');
  const hour = parseInt(h);
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const hour12 = hour % 12 || 12;
  return {
    dateStr: `${day} ${monthName} ${y}`,
    dateShort: datePart,
    timeStr: `${hour12}:${min} ${ampm}`,
    timeShort: `${h}:${min}`
  };
}

function renderTransactionsList() {
  const tbody = document.getElementById('transactions-list-tbody');
  const emptyView = document.getElementById('empty-transactions-view');
  const cardsContainer = document.getElementById('transactions-list-cards');
  
  tbody.innerHTML = '';
  if (cardsContainer) cardsContainer.innerHTML = '';

  if (state.transactions.length === 0) {
    emptyView.classList.remove('hidden');
    document.querySelector('.transactions-table-wrapper').classList.add('hidden');
    if (cardsContainer) cardsContainer.classList.add('hidden');
    return;
  }

  emptyView.classList.add('hidden');
  document.querySelector('.transactions-table-wrapper').classList.remove('hidden');
  if (cardsContainer) cardsContainer.classList.remove('hidden');

  state.transactions.forEach(txn => {
    const tr = document.createElement('tr');
    
    const isCredit = txn.type === 'credit';
    const typeLabel = isCredit ? t('credit') : t('debit');
    const typeIcon = isCredit ? 'plus' : 'minus';
    
    // Split Date and Time
    const fmt = formatDateDisplay(txn.timestamp);
    const dateStr = fmt.dateShort;
    const timeStr = fmt.timeShort;

    const absBal = Math.abs(txn.running_balance);
    const balanceColorClass = txn.running_balance > 0 ? 'text-green' : (txn.running_balance < 0 ? 'text-red' : '');
    const balanceSign = txn.running_balance < 0 ? '-' : '';

    // Merge Date & Time and Credit & Debit columns
    const dateTimeDisplay = `
      <div class="txn-datetime-cell">
        <span class="txn-date-val">${fmt.dateStr}</span>
        <span class="txn-time-val" style="font-size: 10px; color: var(--text-dim); display: block; margin-top: 2px;">${fmt.timeStr}</span>
      </div>
    `;

    const amountDisplay = isCredit 
      ? `<span class="text-green font-mono" style="font-weight:700;">+ Rs. ${txn.amount.toFixed(2)}</span>`
      : `<span class="text-red font-mono" style="font-weight:700;">- Rs. ${txn.amount.toFixed(2)}</span>`;

    tr.innerHTML = `
      <td>${dateTimeDisplay}</td>
      <td>
        <span class="txn-type-badge ${txn.type}">
          <i data-lucide="${typeIcon}"></i>
          <span>${typeLabel}</span>
        </span>
      </td>
      <td class="txn-note-cell">${txn.note || `<span style="color:var(--text-muted); font-style:italic;">${t("no_description")}</span>`}</td>
      <td style="text-align: right;">${amountDisplay}</td>
      <td class="txn-balance-col ${balanceColorClass}" style="text-align: right;">
        ${balanceSign}Rs. ${absBal.toFixed(2)}
      </td>
      <td class="no-print" style="text-align: center;">
        <div class="txn-actions-col">
          <button class="btn-row-action edit" onclick="editTransaction('${txn.id}')" title="Edit Transaction">
            <i data-lucide="edit-2"></i>
          </button>
          <button class="btn-row-action delete" onclick="deleteTransaction('${txn.id}')" title="Delete Transaction">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      </td>
    `;

    tbody.appendChild(tr);

    // Build mobile transaction card
    if (cardsContainer) {
      const card = document.createElement('div');
      card.className = `txn-card ${txn.type}`;
      
      const formattedAmount = `Rs. ${txn.amount.toFixed(2)}`;
      const formattedBalance = `${balanceSign}Rs. ${absBal.toFixed(2)}`;
      
      card.innerHTML = `
        <div class="txn-card-header">
          <span class="txn-card-type-label">
            <i data-lucide="${typeIcon}"></i>
            <span>${typeLabel}</span>
          </span>
          <span class="txn-card-amount ${isCredit ? 'text-green' : 'text-red'}">
            * ${formattedAmount}
          </span>
        </div>
        <div class="txn-card-body">
          <div class="txn-card-meta">
            <div class="txn-meta-item">
              <span class="txn-meta-label">${t('date_time').split(' & ')[0]}:</span>
              <span class="txn-meta-value">${fmt.dateStr}</span>
            </div>
            <div class="txn-meta-item">
              <span class="txn-meta-label">${t('date_time').split(' & ')[1] || 'Time'}:</span>
              <span class="txn-meta-value">${fmt.timeStr}</span>
            </div>
          </div>
          <div class="txn-card-note">
            <span class="txn-meta-label">${t('description_note')}:</span>
            <p class="txn-note-text">${txn.note || '<span class="no-note">' + t('no_description') + '</span>'}</p>
          </div>
          <div class="txn-card-balance">
            <span class="txn-meta-label">${t('running_balance')}:</span>
            <span class="txn-balance-val ${balanceColorClass}">${formattedBalance}</span>
          </div>
        </div>
        <div class="txn-card-actions no-print">
          <button class="btn-secondary" onclick="editTransaction('${txn.id}')">
            <i data-lucide="edit-2"></i>
            <span>${t('edit')}</span>
          </button>
          <button class="btn-danger-outline" onclick="deleteTransaction('${txn.id}')">
            <i data-lucide="trash-2"></i>
            <span>${t('delete')}</span>
          </button>
        </div>
      `;
      cardsContainer.appendChild(card);
    }
  });

  lucide.createIcons();
}

// Client-side CSV Exporter
function exportToCSV() {
  if (!state.activeCustomer || state.transactions.length === 0) {
    showToast('No transaction data to export', 'error');
    return;
  }
  
  let csvContent = "data:text/csv;charset=utf-8,";
  csvContent += "Date,Time,Type,Description,Credit (In),Debit (Out),Running Balance\r\n";
  
  state.transactions.forEach(t => {
    const date = t.timestamp.substring(0, 10);
    const time = t.timestamp.substring(11, 16);
    const type = t.type === 'credit' ? 'Credit' : 'Debit';
    const note = (t.note || '').replace(/"/g, '""');
    const credit = t.type === 'credit' ? t.amount.toFixed(2) : '-';
    const debit = t.type === 'debit' ? t.amount.toFixed(2) : '-';
    
    const balSign = t.running_balance < 0 ? '-' : '';
    const balance = `${balSign}Rs. ${Math.abs(t.running_balance).toFixed(2)}`;
    
    csvContent += `"${date}","${time}","${type}","${note}","${credit}","${debit}","${balance}"\r\n`;
  });
  
  const encodedUri = encodeURI(csvContent);
  const link = document.createElement("a");
  link.setAttribute("href", encodedUri);
  link.setAttribute("download", `${state.activeCustomer.name.replace(/\s+/g, '_')}_ledger.csv`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  
  showToast('Ledger exported to CSV successfully', 'success');
}

// ================= MODAL CONTROLLERS =================

// Customer Modal
function openCustomerModal(customer = null) {
  const modal = document.getElementById('customer-modal');
  const title = document.getElementById('customer-modal-title');
  const submitBtn = document.getElementById('customer-modal-submit-btn');

  document.getElementById('customer-form').reset();
  document.getElementById('cust-modal-id').value = '';

  if (customer) {
    title.textContent = 'Edit Customer Profile';
    submitBtn.textContent = 'Update Profile';
    document.getElementById('cust-modal-id').value = customer.id;
    document.getElementById('cust-modal-name').value = customer.name;
    document.getElementById('cust-modal-phone').value = customer.mobile || '';
  } else {
    title.textContent = 'Create New Customer';
    submitBtn.textContent = 'Save Customer';
  }

  modal.classList.add('active');
  document.getElementById('cust-modal-name').focus();
}

function closeCustomerModal() {
  document.getElementById('customer-modal').classList.remove('active');
}

async function handleCustomerFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('cust-modal-id').value;
  const name = document.getElementById('cust-modal-name').value.trim();
  const mobile = document.getElementById('cust-modal-phone').value.trim();

  const isEdit = !!id;
  const url = isEdit ? `/api/customers/${id}` : '/api/customers';
  const method = isEdit ? 'PUT' : 'POST';

  try {
    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mobile })
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save customer');
    }

    const saved = await res.json();
    showToast(isEdit ? 'Customer profile updated' : 'Customer ledger created successfully', 'success');
    closeCustomerModal();

    await fetchCustomers();

    if (!isEdit) {
      window.location.hash = `#customer/${saved.id}`;
    } else {
      loadLedger(state.activeCustomerId);
    }
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Transaction Modal
function openTxnModal(txn = null) {
  const modal = document.getElementById('txn-modal');
  const title = document.getElementById('txn-modal-title');

  document.getElementById('txn-form').reset();
  document.getElementById('txn-modal-id').value = '';

  const dateInput = document.getElementById('txn-modal-date');
  
  if (txn) {
    title.textContent = 'Edit Transaction Entry';
    document.getElementById('txn-modal-id').value = txn.id;
    
    if (txn.type === 'credit') {
      document.getElementById('txn-type-credit').checked = true;
    } else {
      document.getElementById('txn-type-debit').checked = true;
    }
    
    document.getElementById('txn-modal-amount').value = txn.amount;
    document.getElementById('txn-modal-note').value = txn.note || '';
    
    const formattedDate = txn.timestamp.replace(' ', 'T').substring(0, 16);
    dateInput.value = formattedDate;
  } else {
    title.textContent = 'Add Transaction Entry';
    document.getElementById('txn-type-credit').checked = true;
    
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    dateInput.value = `${year}-${month}-${day}T${hours}:${minutes}`;
  }

  modal.classList.add('active');
  document.getElementById('txn-modal-amount').focus();
}

function closeTxnModal() {
  document.getElementById('txn-modal').classList.remove('active');
}

async function handleTxnFormSubmit(e) {
  e.preventDefault();
  
  const id = document.getElementById('txn-modal-id').value;
  const customer_id = state.activeCustomerId;
  const type = document.querySelector('input[name="txn_type"]:checked').value;
  const amount = parseFloat(document.getElementById('txn-modal-amount').value);
  const note = document.getElementById('txn-modal-note').value.trim();
  const dateVal = document.getElementById('txn-modal-date').value;

  if (amount <= 0 || isNaN(amount)) {
    showToast('Please enter a positive transaction amount', 'error');
    return;
  }

  const isEdit = !!id;
  const url = isEdit ? `/api/transactions/${id}` : '/api/transactions';
  const method = isEdit ? 'PUT' : 'POST';

  let timestamp = dateVal.replace('T', ' ');
  if (timestamp.length === 16) {
    timestamp += ':00';
  }

  const bodyData = { type, amount, note, timestamp };
  if (!isEdit) {
    bodyData.customer_id = customer_id;
  }

  try {
    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bodyData)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save transaction');
    }

    showToast(isEdit ? 'Transaction entry updated' : 'Transaction entry added', 'success');
    closeTxnModal();
    
    loadLedger(customer_id);
    fetchCustomers();

  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Global scope bindings for inline action buttons
window.editTransaction = function(id) {
  const txn = state.transactions.find(t => t.id === id);
  if (txn) {
    openTxnModal(txn);
  }
};

window.deleteTransaction = function(id) {
  openConfirmModal(
    'Delete Transaction Entry',
    'Are you sure you want to delete this transaction record? This will instantly recalculate all subsequent running balances for this customer.',
    async () => {
      try {
        const res = await apiFetch(`/api/transactions/${id}`, { method: 'DELETE' });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to delete transaction');
        }
        showToast('Transaction deleted successfully', 'success');
        
        loadLedger(state.activeCustomerId);
        fetchCustomers();
      } catch (error) {
        showToast(error.message, 'error');
      }
    },
    'Yes, Delete'
  );
};

// Confirmation Modal (Generic Dialog)
let confirmCallback = null;

function openConfirmModal(title, message, callback, confirmText) {
  document.getElementById('confirm-modal-title').textContent = title;
  const msgEl = document.getElementById('confirm-modal-message');
  msgEl.innerHTML = message;
  msgEl.removeAttribute('data-i18n');
  confirmCallback = callback;
  
  const submitBtn = document.getElementById('confirm-modal-submit-btn');
  submitBtn.textContent = confirmText || 'Confirm';
  submitBtn.className = confirmText && confirmText.toLowerCase().includes('delete') ? 'btn-danger' : 'btn-primary';
  
  document.getElementById('confirm-modal').classList.add('active');
  submitBtn.focus();
}

function closeConfirmModal() {
  document.getElementById('confirm-modal').classList.remove('active');
  confirmCallback = null;
}

// ================= AADHAAR CARDS MODULE =================

let aadhaarCardsCache = [];

async function fetchAadhaarCards() {
  const searchVal = document.getElementById('aadhaar-search-input').value;
  try {
    let url = '/api/aadhaar-cards';
    if (searchVal) url += `?search=${encodeURIComponent(searchVal)}`;
    
    const res = await apiFetch(url);
    aadhaarCardsCache = await res.json();
    renderAadhaarCards();
  } catch (error) {
    if (error.message !== 'Unauthenticated') {
      showToast('Failed to load Aadhaar cards', 'error');
    }
  }
}

function renderAadhaarCards() {
  const container = document.getElementById('aadhaar-cards-container');
  const emptyEl = document.getElementById('aadhaar-cards-empty');
  
  container.innerHTML = '';
  
  if (aadhaarCardsCache.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  
  emptyEl.classList.add('hidden');
  
  aadhaarCardsCache.forEach(card => {
    const div = document.createElement('div');
    div.className = 'id-card';
    
    const imageHtml = card.image
      ? `<div class="id-card-image-wrapper"><img src="${card.image}" class="id-card-image" alt="Aadhaar photo"></div>`
      : `<div class="id-card-no-image"><i data-lucide="id-card"></i><span>${t('no_photo')}</span></div>`;
    
    div.innerHTML = `
      ${imageHtml}
      <div class="id-card-body">
        <div class="id-card-details-grid">
          <div class="id-card-detail-item">
            <div class="id-card-detail-content">
              <div class="id-card-label">${t('holder_name')}</div>
              <div class="id-card-value">${escapeHtml(card.holder_name)}</div>
            </div>
            <button class="btn-copy" data-copy="${escapeAttr(card.holder_name)}" data-copy-label="Name" title="Copy Name">
              <i data-lucide="copy"></i>
            </button>
          </div>
          <div class="id-card-detail-item">
            <div class="id-card-detail-content">
              <div class="id-card-label">${t('aadhaar_number')}</div>
              <div class="id-card-value val-monospace">${escapeHtml(card.aadhaar_number)}</div>
            </div>
            <button class="btn-copy" data-copy="${escapeAttr(card.aadhaar_number)}" data-copy-label="Number" title="Copy Number">
              <i data-lucide="copy"></i>
            </button>
          </div>
        </div>
      </div>
      <div class="id-card-actions">
        <button class="action-view" onclick="viewAadhaarCard('${card.id}')">
          <i data-lucide="eye"></i>
          <span>View</span>
        </button>
        <button class="action-edit" onclick="openAadhaarModal('${card.id}')">
          <i data-lucide="pencil"></i>
          <span>Edit</span>
        </button>
        <button class="action-delete" onclick="deleteAadhaarCard('${card.id}')">
          <i data-lucide="trash-2"></i>
          <span>Delete</span>
        </button>
      </div>
    `;
    
    container.appendChild(div);
  });
  
  lucide.createIcons();
}

function viewAadhaarCard(id) {
  const card = aadhaarCardsCache.find(c => c.id === id);
  if (!card) return;
  
  const modalBody = `
    <div class="detail-view-content">
      ${card.image 
        ? `<img src="${card.image}" class="detail-view-image" alt="Aadhaar photo">` 
        : '<div class="id-card-no-image" style="height:160px;max-width:320px;border-radius:8px;"><i data-lucide="id-card"></i><span>' + t('no_photo') + '</span></div>'
      }
      <div class="detail-view-fields">
        <div class="detail-field">
          <span class="detail-field-label">${t('aadhaar_number')}</span>
          <span class="detail-field-value">${escapeHtml(card.aadhaar_number)}</span>
        </div>
        <div class="detail-field">
          <span class="detail-field-label">${t('holder_name')}</span>
          <span class="detail-field-value">${escapeHtml(card.holder_name)}</span>
        </div>
        <div class="detail-field">
          <span class="detail-field-label">Created On</span>
          <span class="detail-field-value">${escapeHtml(card.created_at)}</span>
        </div>
      </div>
      <div class="detail-view-actions">
        <button class="btn-secondary" onclick="closeDetailView()">Close</button>
        <button class="btn-primary" onclick="closeDetailView(); openAadhaarModal('${card.id}')">
          <i data-lucide="pencil"></i> Edit
        </button>
      </div>
    </div>
  `;
  
  openDetailModal('View Aadhaar Card', modalBody);
}

function deleteAadhaarCard(id) {
  const card = aadhaarCardsCache.find(c => c.id === id);
  if (!card) return;
  
  openConfirmModal(
    'Delete Aadhaar Card',
    `Are you sure you want to delete the Aadhaar card for <strong>${escapeHtml(card.holder_name)}</strong>?`,
    async () => {
      try {
        const res = await apiFetch(`/api/aadhaar-cards/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete Aadhaar card');
        showToast('Aadhaar card deleted successfully', 'success');
        fetchAadhaarCards();
      } catch (error) {
        showToast(error.message, 'error');
      }
    }
  );
}

// Aadhaar Modal
function openAadhaarModal(id) {
  const modal = document.getElementById('aadhaar-modal');
  const title = document.getElementById('aadhaar-modal-title');
  const submitBtn = document.getElementById('aadhaar-modal-submit-btn');
  
  // Reset form
  document.getElementById('aadhaar-form').reset();
  document.getElementById('aadhaar-modal-id').value = '';
  resetAadhaarImageUpload();
  
  if (id) {
    const card = aadhaarCardsCache.find(c => c.id === id);
    if (!card) return;
    
    title.textContent = 'Edit Aadhaar Card';
    submitBtn.textContent = 'Update Card';
    document.getElementById('aadhaar-modal-id').value = id;
    document.getElementById('aadhaar-modal-name').value = card.holder_name;
    document.getElementById('aadhaar-modal-number').value = card.aadhaar_number;
    
    if (card.image) {
      setAadhaarImagePreview(card.image);
    }
  } else {
    title.textContent = 'Add Aadhaar Card';
    submitBtn.textContent = 'Save Card';
  }
  
  modal.classList.add('active');
}

function closeAadhaarModal() {
  document.getElementById('aadhaar-modal').classList.remove('active');
}

function resetAadhaarImageUpload() {
  const preview = document.getElementById('aadhaar-image-preview');
  const placeholder = document.getElementById('aadhaar-image-placeholder');
  const removeBtn = document.getElementById('aadhaar-image-remove-btn');
  const input = document.getElementById('aadhaar-image-input');
  
  preview.classList.add('hidden');
  preview.src = '';
  placeholder.classList.remove('hidden');
  removeBtn.classList.add('hidden');
  input.value = '';
}

function setAadhaarImagePreview(src) {
  const preview = document.getElementById('aadhaar-image-preview');
  const placeholder = document.getElementById('aadhaar-image-placeholder');
  const removeBtn = document.getElementById('aadhaar-image-remove-btn');
  
  preview.src = src;
  preview.classList.remove('hidden');
  placeholder.classList.add('hidden');
  removeBtn.classList.remove('hidden');
}

async function handleAadhaarFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('aadhaar-modal-id').value;
  const holder_name = document.getElementById('aadhaar-modal-name').value.trim().replace(/[0-9]/g, '');
  const aadhaar_number = document.getElementById('aadhaar-modal-number').value.trim().replace(/[^0-9]/g, '');
  const preview = document.getElementById('aadhaar-image-preview');
  const image = preview.classList.contains('hidden') ? null : preview.src;
  
  const isEdit = !!id;
  const url = isEdit ? `/api/aadhaar-cards/${id}` : '/api/aadhaar-cards';
  const method = isEdit ? 'PUT' : 'POST';
  
  try {
    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holder_name, aadhaar_number, image })
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save Aadhaar card');
    }
    
    showToast(isEdit ? 'Aadhaar card updated' : 'Aadhaar card saved', 'success');
    closeAadhaarModal();
    fetchAadhaarCards();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ================= BANK ACCOUNTS MODULE =================

let bankAccountsCache = [];

async function fetchBankAccounts() {
  const searchVal = document.getElementById('bank-search-input').value;
  try {
    let url = '/api/bank-accounts';
    if (searchVal) url += `?search=${encodeURIComponent(searchVal)}`;
    
    const res = await apiFetch(url);
    bankAccountsCache = await res.json();
    renderBankAccounts();
  } catch (error) {
    if (error.message !== 'Unauthenticated') {
      showToast('Failed to load Bank accounts', 'error');
    }
  }
}

function renderBankAccounts() {
  const container = document.getElementById('bank-cards-container');
  const emptyEl = document.getElementById('bank-cards-empty');
  
  container.innerHTML = '';
  
  if (bankAccountsCache.length === 0) {
    emptyEl.classList.remove('hidden');
    return;
  }
  
  emptyEl.classList.add('hidden');
  
  bankAccountsCache.forEach(acct => {
    const div = document.createElement('div');
    div.className = 'id-card';
    
    const imageHtml = acct.image
      ? `<div class="id-card-image-wrapper"><img src="${acct.image}" class="id-card-image" alt="Bank photo"></div>`
      : `<div class="id-card-no-image"><i data-lucide="landmark"></i><span>No Photo</span></div>`;
    
    div.innerHTML = `
      ${imageHtml}
      <div class="id-card-body">
        <div class="id-card-details-grid">
          <div class="id-card-detail-item">
            <div class="id-card-detail-content">
              <div class="id-card-label">${t('account_holder')}</div>
              <div class="id-card-value">${escapeHtml(acct.account_holder)}</div>
            </div>
            <button class="btn-copy" data-copy="${escapeAttr(acct.account_holder)}" data-copy-label="Name" title="Copy Name">
              <i data-lucide="copy"></i>
            </button>
          </div>
          <div class="id-card-detail-item">
            <div class="id-card-detail-content">
              <div class="id-card-label">${t('account_number')}</div>
              <div class="id-card-value val-monospace">${escapeHtml(acct.account_number)}</div>
            </div>
            <button class="btn-copy" data-copy="${escapeAttr(acct.account_number)}" data-copy-label="Number" title="Copy Number">
              <i data-lucide="copy"></i>
            </button>
          </div>
        </div>
      </div>
      <div class="id-card-actions">
        <button class="action-view" onclick="viewBankAccount('${acct.id}')">
          <i data-lucide="eye"></i>
          <span>View</span>
        </button>
        <button class="action-edit" onclick="openBankModal('${acct.id}')">
          <i data-lucide="pencil"></i>
          <span>Edit</span>
        </button>
        <button class="action-delete" onclick="deleteBankAccount('${acct.id}')">
          <i data-lucide="trash-2"></i>
          <span>Delete</span>
        </button>
      </div>
    `;
    
    container.appendChild(div);
  });
  
  lucide.createIcons();
}

function viewBankAccount(id) {
  const acct = bankAccountsCache.find(c => c.id === id);
  if (!acct) return;
  
  const modalBody = `
    <div class="detail-view-content">
      ${acct.image 
        ? `<img src="${acct.image}" class="detail-view-image" alt="Bank photo">` 
        : '<div class="id-card-no-image" style="height:160px;max-width:320px;border-radius:8px;"><i data-lucide="landmark"></i><span>' + t('no_photo') + '</span></div>'
      }
      <div class="detail-view-fields">
        <div class="detail-field">
          <span class="detail-field-label">${t('account_number')}</span>
          <span class="detail-field-value">${escapeHtml(acct.account_number)}</span>
        </div>
        <div class="detail-field">
          <span class="detail-field-label">${t('account_holder')}</span>
          <span class="detail-field-value">${escapeHtml(acct.account_holder)}</span>
        </div>
        <div class="detail-field">
          <span class="detail-field-label">Created On</span>
          <span class="detail-field-value">${escapeHtml(acct.created_at)}</span>
        </div>
      </div>
      <div class="detail-view-actions">
        <button class="btn-secondary" onclick="closeDetailView()">Close</button>
        <button class="btn-primary" onclick="closeDetailView(); openBankModal('${acct.id}')">
          <i data-lucide="pencil"></i> Edit
        </button>
      </div>
    </div>
  `;
  
  openDetailModal('View Bank Account', modalBody);
}

function deleteBankAccount(id) {
  const acct = bankAccountsCache.find(c => c.id === id);
  if (!acct) return;
  
  openConfirmModal(
    'Delete Bank Account',
    `Are you sure you want to delete the bank account for <strong>${escapeHtml(acct.account_holder)}</strong>?`,
    async () => {
      try {
        const res = await apiFetch(`/api/bank-accounts/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete bank account');
        showToast('Bank account deleted successfully', 'success');
        fetchBankAccounts();
      } catch (error) {
        showToast(error.message, 'error');
      }
    },
    'Yes, Delete'
  );
}

// Bank Modal
function openBankModal(id) {
  const modal = document.getElementById('bank-modal');
  const title = document.getElementById('bank-modal-title');
  const submitBtn = document.getElementById('bank-modal-submit-btn');
  
  // Reset form
  document.getElementById('bank-form').reset();
  document.getElementById('bank-modal-id').value = '';
  resetBankImageUpload();
  
  if (id) {
    const acct = bankAccountsCache.find(c => c.id === id);
    if (!acct) return;
    
    title.textContent = 'Edit Bank Account';
    submitBtn.textContent = 'Update Account';
    document.getElementById('bank-modal-id').value = id;
    document.getElementById('bank-modal-name').value = acct.account_holder;
    document.getElementById('bank-modal-number').value = acct.account_number;
    
    if (acct.image) {
      setBankImagePreview(acct.image);
    }
  } else {
    title.textContent = 'Add Bank Account';
    submitBtn.textContent = 'Save Account';
  }
  
  modal.classList.add('active');
}

function closeBankModal() {
  document.getElementById('bank-modal').classList.remove('active');
}

function resetBankImageUpload() {
  const preview = document.getElementById('bank-image-preview');
  const placeholder = document.getElementById('bank-image-placeholder');
  const removeBtn = document.getElementById('bank-image-remove-btn');
  const input = document.getElementById('bank-image-input');
  
  preview.classList.add('hidden');
  preview.src = '';
  placeholder.classList.remove('hidden');
  removeBtn.classList.add('hidden');
  input.value = '';
}

function setBankImagePreview(src) {
  const preview = document.getElementById('bank-image-preview');
  const placeholder = document.getElementById('bank-image-placeholder');
  const removeBtn = document.getElementById('bank-image-remove-btn');
  
  preview.src = src;
  preview.classList.remove('hidden');
  placeholder.classList.add('hidden');
  removeBtn.classList.remove('hidden');
}

async function handleBankFormSubmit(e) {
  e.preventDefault();
  const id = document.getElementById('bank-modal-id').value;
  const account_holder = document.getElementById('bank-modal-name').value.trim().replace(/[0-9]/g, '');
  const account_number = document.getElementById('bank-modal-number').value.trim().replace(/[^0-9]/g, '');
  const preview = document.getElementById('bank-image-preview');
  const image = preview.classList.contains('hidden') ? null : preview.src;
  
  const isEdit = !!id;
  const url = isEdit ? `/api/bank-accounts/${id}` : '/api/bank-accounts';
  const method = isEdit ? 'PUT' : 'POST';
  
  try {
    const res = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account_holder, account_number, image })
    });
    
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to save bank account');
    }
    
    showToast(isEdit ? 'Bank account updated' : 'Bank account saved', 'success');
    closeBankModal();
    fetchBankAccounts();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// ================= SHARED HELPERS =================

function copyToClipboard(text, btn, label) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      showCopyFeedback(btn, label);
    }).catch(() => {
      fallbackCopy(text, btn, label);
    });
  } else {
    fallbackCopy(text, btn, label);
  }
}

function fallbackCopy(text, btn, label) {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    document.execCommand('copy');
    showCopyFeedback(btn, label);
  } catch (e) {
    showToast('Failed to copy', 'error');
  }
  document.body.removeChild(textarea);
}

function showCopyFeedback(btn, label) {
  const originalHtml = btn.innerHTML;
  btn.innerHTML = '<i data-lucide="check"></i><span>Copied!</span>';
  btn.classList.add('copied');
  lucide.createIcons();
  setTimeout(() => {
    btn.innerHTML = originalHtml;
    btn.classList.remove('copied');
    lucide.createIcons();
  }, 2000);
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeAttr(str) {
  if (!str) return '';
  return str.replace(/'/g, "&#39;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Detail View Modal (generic read-only view)
let detailViewOriginalContent = '';

function openDetailModal(title, bodyHtml) {
  // Create a lightweight modal overlay for viewing details
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay active';
  overlay.id = 'detail-view-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="max-width: 480px;">
      <div class="modal-header">
        <h3>${title}</h3>
        <button class="modal-close" onclick="closeDetailView()">&times;</button>
      </div>
      ${bodyHtml}
    </div>
  `;
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeDetailView();
  });
  document.body.appendChild(overlay);
  lucide.createIcons();
}

function closeDetailView() {
  const overlay = document.getElementById('detail-view-overlay');
  if (overlay) overlay.remove();
}

// ================= IMAGE UPLOAD HANDLERS =================
function initImageUpload(inputId, previewId, placeholderId, removeBtnId, setPreviewFn, resetFn) {
  const input = document.getElementById(inputId);
  const uploadArea = input.closest('.image-upload-area') || input.parentElement;
  
  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    
    if (!file.type.startsWith('image/')) {
      showToast('Please select an image file', 'error');
      return;
    }
    
    const reader = new FileReader();
    reader.onload = (ev) => {
      setPreviewFn(ev.target.result);
    };
    reader.readAsDataURL(file);
  });
  
  // Click on upload area triggers file input (except on the remove button)
  if (uploadArea) {
    uploadArea.addEventListener('click', (e) => {
      const removeBtn = document.getElementById(removeBtnId);
      if (removeBtn && removeBtn.contains(e.target)) return;
      input.click();
    });
  }
}

// ================= MODULE ROUTING HOOKS =================
// These are called from handleRoute when navigating to these views

// ================= EVENT BINDINGS FOR NEW MODULES =================
function initNewModuleEvents() {
  // Aadhaar Module Events
  document.getElementById('open-add-aadhaar-modal-btn').addEventListener('click', () => openAadhaarModal());
  document.getElementById('aadhaar-empty-add-btn').addEventListener('click', () => openAadhaarModal());
  document.getElementById('aadhaar-modal-close-btn').addEventListener('click', closeAadhaarModal);
  document.getElementById('aadhaar-modal-cancel-btn').addEventListener('click', closeAadhaarModal);
  document.getElementById('aadhaar-form').addEventListener('submit', handleAadhaarFormSubmit);
  
  // Aadhaar search
  document.getElementById('aadhaar-search-input').addEventListener('input', () => {
    clearTimeout(state.debounceTimeout);
    state.debounceTimeout = setTimeout(() => fetchAadhaarCards(), 300);
  });
  
  // Aadhaar image upload
  initImageUpload(
    'aadhaar-image-input',
    'aadhaar-image-preview',
    'aadhaar-image-placeholder',
    'aadhaar-image-remove-btn',
    setAadhaarImagePreview,
    resetAadhaarImageUpload
  );
  
  document.getElementById('aadhaar-image-remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    resetAadhaarImageUpload();
  });
  
  // Bank Module Events
  document.getElementById('open-add-bank-modal-btn').addEventListener('click', () => openBankModal());
  document.getElementById('bank-empty-add-btn').addEventListener('click', () => openBankModal());
  document.getElementById('bank-modal-close-btn').addEventListener('click', closeBankModal);
  document.getElementById('bank-modal-cancel-btn').addEventListener('click', closeBankModal);
  document.getElementById('bank-form').addEventListener('submit', handleBankFormSubmit);
  
  // Bank search
  document.getElementById('bank-search-input').addEventListener('input', () => {
    clearTimeout(state.debounceTimeout);
    state.debounceTimeout = setTimeout(() => fetchBankAccounts(), 300);
  });
  
  // Bank image upload
  initImageUpload(
    'bank-image-input',
    'bank-image-preview',
    'bank-image-placeholder',
    'bank-image-remove-btn',
    setBankImagePreview,
    resetBankImageUpload
  );
  
  document.getElementById('bank-image-remove-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    resetBankImageUpload();
  });
  
  // Global overlay click for new modals
  document.getElementById('aadhaar-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('aadhaar-modal')) closeAadhaarModal();
  });
  document.getElementById('bank-modal').addEventListener('click', (e) => {
    if (e.target === document.getElementById('bank-modal')) closeBankModal();
  });
  
  // Event delegation for copy buttons (uses data-copy attribute)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-copy[data-copy]');
    if (btn) {
      const text = btn.getAttribute('data-copy');
      const label = btn.getAttribute('data-copy-label') || '';
      copyToClipboard(text, btn, label);
    }
  });
  
  // ================= INPUT VALIDATION =================
  // Aadhaar Number: digits only
  const aadhaarNumberInput = document.getElementById('aadhaar-modal-number');
  if (aadhaarNumberInput) {
    aadhaarNumberInput.addEventListener('input', function() {
      this.value = this.value.replace(/[^0-9]/g, '');
    });
  }
  
  // Bank Account Number: digits only
  const bankNumberInput = document.getElementById('bank-modal-number');
  if (bankNumberInput) {
    bankNumberInput.addEventListener('input', function() {
      this.value = this.value.replace(/[^0-9]/g, '');
    });
  }
  
  // Aadhaar Name: letters, spaces, dots only (no digits)
  const aadhaarNameInput = document.getElementById('aadhaar-modal-name');
  if (aadhaarNameInput) {
    aadhaarNameInput.addEventListener('input', function() {
      this.value = this.value.replace(/[0-9]/g, '');
    });
  }
  
  // Bank Account Name: letters, spaces, dots only (no digits)
  const bankNameInput = document.getElementById('bank-modal-name');
  if (bankNameInput) {
    bankNameInput.addEventListener('input', function() {
      this.value = this.value.replace(/[0-9]/g, '');
    });
  }

  // Backup & Restore Events
  initBackupRestoreEvents();
}

// Call initNewModuleEvents after DOM ready (in addition to the main init)
document.addEventListener('DOMContentLoaded', () => {
  initNewModuleEvents();
});

// Extend routing to fetch data when navigating to modules
const _origRouteHandler = handleRoute;
handleRoute = function() {
  // Call existing route handler
  _origRouteHandler.apply(this, arguments);
  
  const hash = window.location.hash || '#dashboard';
  const cleanHash = hash.replace(/^#/, '').replace(/_/g, '-').split('/')[0];
  
  if (cleanHash === 'aadhaar-cards') {
    fetchAadhaarCards();
  } else if (cleanHash === 'bank-accounts') {
    fetchBankAccounts();
  }
};

// Confirm modal button listeners - registered after DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const confirmCloseBtn = document.getElementById('confirm-modal-close-btn');
  const confirmCancelBtn = document.getElementById('confirm-modal-cancel-btn');
  const confirmSubmitBtn = document.getElementById('confirm-modal-submit-btn');
  if (confirmCloseBtn) confirmCloseBtn.addEventListener('click', closeConfirmModal);
  if (confirmCancelBtn) confirmCancelBtn.addEventListener('click', closeConfirmModal);
  if (confirmSubmitBtn) {
    confirmSubmitBtn.addEventListener('click', () => {
      if (confirmCallback) {
        confirmCallback();
      }
      closeConfirmModal();
    });
  }
});

// ================= PROFILE & SETTINGS MODULE =================
// ================= PROFILE & SETTINGS MODULE =================
function openMobileSettingsSheet() {
  const overlay = document.getElementById('mobile-settings-overlay');
  const sheet = document.getElementById('mobile-settings-sheet');
  if (overlay && sheet) {
    overlay.classList.remove('hidden');
    setTimeout(() => {
      sheet.classList.add('open');
    }, 10);
  }
}

function closeMobileSettingsSheet() {
  const overlay = document.getElementById('mobile-settings-overlay');
  const sheet = document.getElementById('mobile-settings-sheet');
  if (overlay && sheet) {
    sheet.classList.remove('open');
    setTimeout(() => {
      overlay.classList.add('hidden');
    }, 300);
  }
}

function positionProfileDropdown() {
  const dropdown = document.getElementById('profile-dropdown');
  if (!dropdown || dropdown.classList.contains('hidden')) return;

  dropdown.style.right = '0';
  dropdown.style.left = 'auto';
  dropdown.style.top = 'calc(100% + 10px)';
  dropdown.style.bottom = 'auto';

  const rect = dropdown.getBoundingClientRect();
  const viewportWidth = window.innerWidth;

  if (rect.right > viewportWidth) {
    const overflowRight = rect.right - viewportWidth;
    dropdown.style.right = `${overflowRight + 12}px`;
  }
  if (rect.left < 0) {
    dropdown.style.left = '12px';
    dropdown.style.right = 'auto';
  }
}

function initMobileSettingsDrag() {
  const sheet = document.getElementById('mobile-settings-sheet');
  const handle = sheet ? sheet.querySelector('.sheet-drag-handle') : null;
  if (!sheet || !handle) return;

  let startY = 0;
  let currentY = 0;
  let isDragging = false;

  const onStart = (e) => {
    startY = e.touches ? e.touches[0].clientY : e.clientY;
    isDragging = true;
    sheet.style.transition = 'none';
  };

  const onMove = (e) => {
    if (!isDragging) return;
    currentY = e.touches ? e.touches[0].clientY : e.clientY;
    const deltaY = currentY - startY;
    if (deltaY > 0) {
      sheet.style.transform = `translateY(${deltaY}px)`;
    }
  };

  const onEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    sheet.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
    const deltaY = currentY - startY;
    if (deltaY > 100) {
      closeMobileSettingsSheet();
    }
    sheet.style.transform = '';
  };

  handle.addEventListener('touchstart', onStart);
  handle.addEventListener('touchmove', onMove);
  handle.addEventListener('touchend', onEnd);

  handle.addEventListener('mousedown', onStart);
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onEnd);
}

function initProfileDropdown() {
  const profileBtn = document.getElementById('header-profile-btn');
  const dropdown = document.getElementById('profile-dropdown');
  const mobileCloseBtn = document.getElementById('mobile-settings-close-btn');
  const mobileOverlay = document.getElementById('mobile-settings-overlay');
  
  if (profileBtn && dropdown) {
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (window.innerWidth <= 820) {
        openMobileSettingsSheet();
      } else {
        dropdown.classList.toggle('hidden');
        if (!dropdown.classList.contains('hidden')) {
          positionProfileDropdown();
        }
      }
    });
    
    document.addEventListener('click', (e) => {
      if (!profileBtn.contains(e.target) && !dropdown.contains(e.target)) {
        dropdown.classList.add('hidden');
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth <= 820) {
        dropdown.classList.add('hidden');
      } else {
        closeMobileSettingsSheet();
        positionProfileDropdown();
      }
    });

    window.addEventListener('scroll', () => {
      if (!dropdown.classList.contains('hidden')) {
        positionProfileDropdown();
      }
    });

    const ddMappings = {
      'dropdown-language': '#profile/preferences',
      'dropdown-theme': '#profile/preferences',
      'dropdown-preferences': '#profile/preferences',
      'dropdown-security': '#profile/security',
      'dropdown-activity': '#profile/activity',
      'dropdown-backup': '#profile/backup',
      'dropdown-timezone': '#profile/preferences',
      
      'sheet-my-profile': '#profile',
      'sheet-language': '#profile/preferences',
      'sheet-theme': '#profile/preferences',
      'sheet-preferences': '#profile/preferences',
      'sheet-security': '#profile/security',
      'sheet-activity': '#profile/activity',
      'sheet-backup': '#profile/backup',
      'sheet-timezone': '#profile/preferences'
    };
    
    Object.keys(ddMappings).forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('click', (e) => {
          e.preventDefault();
          window.location.hash = ddMappings[id];
          dropdown.classList.add('hidden');
          closeMobileSettingsSheet();
        });
      }
    });

    if (mobileCloseBtn) {
      mobileCloseBtn.addEventListener('click', closeMobileSettingsSheet);
    }
    if (mobileOverlay) {
      mobileOverlay.addEventListener('click', (e) => {
        if (e.target === mobileOverlay) {
          closeMobileSettingsSheet();
        }
      });
    }

    initMobileSettingsDrag();

    const triggerConfirmLogout = (e) => {
      if (e) e.preventDefault();
      dropdown.classList.add('hidden');
      closeMobileSettingsSheet();
      showLogoutConfirmModal();
    };

    const logoutBtn = document.getElementById('profile-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', triggerConfirmLogout);
    }

    const sheetLogoutBtn = document.getElementById('sheet-logout-btn');
    if (sheetLogoutBtn) {
      sheetLogoutBtn.addEventListener('click', triggerConfirmLogout);
    }
  }
}

function initSettingsTabSwitching() {
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab');
      switchSettingsTab(tabId);
    });
  });
  // Handle "Edit Profile" button on the hero card
  document.querySelectorAll('[data-tab-switch]').forEach(btn => {
    btn.addEventListener('click', () => {
      const tabId = btn.getAttribute('data-tab-switch');
      switchSettingsTab(tabId);
    });
  });
}

function switchSettingsTab(tabId) {
  document.querySelectorAll('.settings-nav-item').forEach(btn => {
    if (btn.getAttribute('data-tab') === tabId) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  
  document.querySelectorAll('.settings-tab-panel').forEach(panel => {
    if (panel.id === tabId) {
      panel.classList.add('active');
    } else {
      panel.classList.remove('active');
    }
  });

  if (tabId === 'tab-activity-log') {
    fetchActivityLogs();
  } else if (tabId === 'tab-backup-export') {
    fetchBackupHistory();
  }
}

function initProfilePhotoEvents() {
  const photoInput = document.getElementById('profile-photo-file');
  const removePicBtn = document.getElementById('remove-profile-pic-btn');

  if (photoInput) {
    photoInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = function(evt) {
          const base64String = evt.target.result;
          state.tempProfilePic = base64String;
          
          const preview = document.getElementById('edit-profile-pic-preview');
          const initials = document.getElementById('edit-profile-initials-preview');
          if (preview && initials) {
            preview.src = base64String;
            preview.style.display = 'block';
            initials.style.display = 'none';
          }
        };
        reader.readAsDataURL(file);
      }
    });
  }

  if (removePicBtn) {
    removePicBtn.addEventListener('click', () => {
      state.tempProfilePic = null;
      const preview = document.getElementById('edit-profile-pic-preview');
      const initials = document.getElementById('edit-profile-initials-preview');
      if (preview && initials) {
        preview.src = '';
        preview.style.display = 'none';
        initials.style.display = 'flex';
        initials.textContent = (state.profile && state.profile.name || 'Owner').charAt(0).toUpperCase();
      }
      if (photoInput) photoInput.value = '';
    });
  }
}

function initSettingsFormEvents() {
  const editForm = document.getElementById('edit-profile-form');
  if (editForm) {
    editForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('profile-edit-name').value;
      const email = document.getElementById('profile-edit-email').value;
      const mobile = document.getElementById('profile-edit-mobile').value;
      
      const payload = {
        ...state.profile,
        name,
        email,
        mobile,
        profile_picture: state.tempProfilePic !== undefined ? state.tempProfilePic : state.profile.profile_picture
      };
      
      try {
        const res = await apiFetch('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to update profile');
        }
        const updatedProfile = await res.json();
        state.profile = updatedProfile;
        state.tempProfilePic = undefined;
        updateProfileUI();
        updateProfileSubViews();
        showToast(t('update_success'), 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const prefForm = document.getElementById('preferences-form');
  if (prefForm) {
    prefForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const language = document.getElementById('pref-language').value;
      const theme = document.getElementById('pref-theme').value;
      const timezone = document.getElementById('pref-timezone').value;
      
      const notification_transactions = document.getElementById('pref-notify-txn').checked ? 1 : 0;
      const notification_backup = document.getElementById('pref-notify-backup').checked ? 1 : 0;
      const notification_system = document.getElementById('pref-notify-system').checked ? 1 : 0;
      const notification_reminder = document.getElementById('pref-notify-reminder').checked ? 1 : 0;
      
      const payload = {
        ...state.profile,
        language,
        theme,
        timezone,
        notification_transactions,
        notification_backup,
        notification_system,
        notification_reminder
      };
      
      try {
        const res = await apiFetch('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to update preferences');
        }
        const updatedProfile = await res.json();
        state.profile = updatedProfile;
        
        applyLanguage(updatedProfile.language);
        applyTheme(updatedProfile.theme);
        updateProfileUI();
        updateProfileSubViews();
        
        showToast(t('update_success'), 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }

  const tzAutoCheck = document.getElementById('pref-timezone-auto');
  const tzSelect = document.getElementById('pref-timezone');
  if (tzAutoCheck && tzSelect) {
    tzAutoCheck.addEventListener('change', () => {
      if (tzAutoCheck.checked) {
        const autoTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
        
        let tzExists = false;
        for (let i = 0; i < tzSelect.options.length; i++) {
          if (tzSelect.options[i].value === autoTz) {
            tzExists = true;
            break;
          }
        }
        if (!tzExists) {
          const opt = document.createElement('option');
          opt.value = autoTz;
          opt.textContent = autoTz;
          tzSelect.appendChild(opt);
        }
        tzSelect.value = autoTz;
        tzSelect.disabled = true;
      } else {
        tzSelect.disabled = false;
      }
    });
  }

  const securityForm = document.getElementById('security-form');
  if (securityForm) {
    const visibilityCheck = document.getElementById('security-toggle-visibility');
    if (visibilityCheck) {
      visibilityCheck.addEventListener('change', () => {
        const type = visibilityCheck.checked ? 'text' : 'password';
        document.getElementById('security-current-password').type = type;
        document.getElementById('security-new-password').type = type;
        document.getElementById('security-confirm-password').type = type;
      });
    }

    securityForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const currentPassword = document.getElementById('security-current-password').value;
      const newPassword = document.getElementById('security-new-password').value;
      const confirmPassword = document.getElementById('security-confirm-password').value;
      
      if (newPassword !== confirmPassword) {
        showToast(t('password_mismatch'), 'error');
        return;
      }
      
      try {
        const res = await apiFetch('/api/profile/password', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword, newPassword })
        });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to update password');
        }
        
        document.getElementById('security-current-password').value = '';
        document.getElementById('security-new-password').value = '';
        document.getElementById('security-confirm-password').value = '';
        if (visibilityCheck) {
          visibilityCheck.checked = false;
          document.getElementById('security-current-password').type = 'password';
          document.getElementById('security-new-password').type = 'password';
          document.getElementById('security-confirm-password').type = 'password';
        }
        
        showToast(t('update_success'), 'success');
      } catch (err) {
        showToast(err.message, 'error');
      }
    });
  }
}

function initBackupButtons() {
  const btnConfigs = [
    { id: 'export-customers-btn', path: 'customers' },
    { id: 'export-transactions-btn', path: 'transactions' },
    { id: 'export-aadhaar-btn', path: 'aadhaar' },
    { id: 'export-bank-btn', path: 'bank' },
    { id: 'export-complete-btn', path: 'complete' }
  ];
  btnConfigs.forEach(cfg => {
    const el = document.getElementById(cfg.id);
    if (el) {
      el.addEventListener('click', () => {
        window.location.href = `/api/backup/export/${cfg.path}`;
        showToast('Backup download initiated', 'success');
      });
    }
  });
}

async function fetchProfile() {
  try {
    const res = await apiFetch('/api/profile');
    if (!res.ok) throw new Error('Failed to fetch profile settings');
    const profile = await res.json();
    state.profile = profile;
    
    state.language = profile.language || 'en';
    state.theme = profile.theme || 'system';
    
    applyLanguage(state.language);
    applyTheme(state.theme);
    updateProfileUI();
        updateProfileSubViews();
  } catch (error) {
    if (error.message !== 'Unauthenticated') {
      console.error('Failed to load profile:', error);
    }
  }
}

function applyLanguage(lang) {
  state.language = lang;
  localStorage.setItem('lang', lang);
  translatePage();
  document.documentElement.lang = lang;
  
  const select = document.getElementById('pref-language');
  if (select) select.value = lang;
}

function populateLanguageDropdown() {
  const select = document.getElementById('pref-language');
  if (!select || select.children.length > 0) return;
  Object.keys(window.languageFlags).forEach(code => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = window.languageFlags[code];
    select.appendChild(opt);
  });
}

function updateTimezoneBadge(timezone) {
  const badge = document.querySelector('.timezone-badge span');
  if (badge) {
    let name = 'IST';
    let offset = '+5:30';
    
    if (timezone === 'UTC') {
      name = 'UTC';
      offset = '+0:00';
    } else if (timezone === 'America/New_York') {
      name = 'EST';
      offset = '-5:00';
    } else if (timezone === 'Europe/London') {
      name = 'GMT/BST';
      offset = '+1:00';
    } else if (timezone === 'Asia/Singapore') {
      name = 'SGT';
      offset = '+8:00';
    } else if (timezone === 'Australia/Sydney') {
      name = 'AEST';
      offset = '+10:00';
    } else {
      name = timezone.split('/').pop().replace('_', ' ');
      try {
        const parts = new Intl.DateTimeFormat('en-US', {
          timeZone: timezone,
          timeZoneName: 'shortOffset'
        }).formatToParts(new Date());
        const tzPart = parts.find(p => p.type === 'timeZoneName');
        offset = tzPart ? tzPart.value : '';
      } catch (e) {
        offset = '';
      }
    }
    badge.textContent = `${name} (${offset})`;
  }
}

async function fetchActivityLogs() {
  const list = document.getElementById('activity-log-list-ul');
  if (!list) return;
  list.innerHTML = '<div style="padding: 20px; text-align: center; color: var(--text-muted);">Loading logs...</div>';
  
  try {
    const res = await apiFetch('/api/profile/activity');
    if (!res.ok) throw new Error('Failed to fetch activity logs');
    const logs = await res.json();
    
    list.innerHTML = '';
    if (logs.length === 0) {
      list.innerHTML = '<div style="padding: 30px; text-align: center; color: var(--text-muted);">No activity logs recorded.</div>';
      return;
    }
    
    logs.forEach(log => {
      const item = document.createElement('div');
      item.className = 'activity-log-item';
      
      let timeStr = log.timestamp;
      try {
        const date = new Date(log.timestamp.replace(' ', 'T'));
        timeStr = date.toLocaleString();
      } catch (e) {
        console.warn('Failed to parse activity log timestamp:', e);
      }
      
      const typeLabel = t('log_' + log.event_type) || log.event_type;
      
      item.innerHTML = `
        <div class="activity-log-meta">
          <span class="act-type ${log.event_type}">${typeLabel}</span>
          <span>${timeStr}</span>
        </div>
        <div class="activity-log-desc">${log.description}</div>
      `;
      list.appendChild(item);
    });
  } catch (err) {
    if (err.message !== 'Unauthenticated') {
      list.innerHTML = `<div style="padding: 20px; text-align: center; color: var(--color-danger);">${err.message}</div>`;
    }
  }
}

function updateProfileUI() {
  const profile = state.profile;
  if (!profile) return;

  populateLanguageDropdown();

  const headerAvatar = document.getElementById('header-profile-avatar');
  const dropdownAvatar = document.getElementById('dropdown-profile-avatar');
  const settingsAvatar = document.getElementById('settings-profile-avatar');
  const myPic = document.getElementById('my-profile-pic');
  const myInitials = document.getElementById('my-profile-initials');
  const editPic = document.getElementById('edit-profile-pic-preview');
  const editInitials = document.getElementById('edit-profile-initials-preview');

  const nameInitial = (profile.name || 'Owner').charAt(0).toUpperCase();

  if (headerAvatar) {
    if (profile.profile_picture) {
      headerAvatar.innerHTML = `<img src="${profile.profile_picture}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
    } else {
      headerAvatar.innerHTML = nameInitial;
    }
  }

  if (dropdownAvatar) {
    if (profile.profile_picture) {
      dropdownAvatar.innerHTML = `<img src="${profile.profile_picture}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
    } else {
      dropdownAvatar.innerHTML = nameInitial;
    }
  }

  if (settingsAvatar) {
    if (profile.profile_picture) {
      settingsAvatar.innerHTML = `<img src="${profile.profile_picture}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
    } else {
      settingsAvatar.innerHTML = nameInitial;
    }
  }

  // Update main profile menu header avatar, name and role
  const mainAvatar = document.getElementById("settings-main-avatar");
  const mainName = document.getElementById("settings-main-name");
  const mainRole = document.getElementById("settings-main-role");
  if (mainAvatar) {
    if (profile.profile_picture) {
      mainAvatar.innerHTML = `<img src="${profile.profile_picture}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
    } else {
      mainAvatar.innerHTML = nameInitial;
    }
  }
  if (mainName) mainName.textContent = profile.name || "";
  if (mainRole) mainRole.textContent = profile.role || "Owner";

  if (myPic && myInitials) {
    if (profile.profile_picture) {
      myPic.src = profile.profile_picture;
      myPic.style.display = 'block';
      myInitials.style.display = 'none';
    } else {
      myPic.src = '';
      myPic.style.display = 'none';
      myInitials.style.display = 'flex';
      myInitials.textContent = nameInitial;
    }
  }

  if (editPic && editInitials && state.tempProfilePic === undefined) {
    if (profile.profile_picture) {
      editPic.src = profile.profile_picture;
      editPic.style.display = 'block';
      editInitials.style.display = 'none';
    } else {
      editPic.src = '';
      editPic.style.display = 'none';
      editInitials.style.display = 'flex';
      editInitials.textContent = nameInitial;
    }
  }

  const ddName = document.getElementById('dropdown-user-name');
  const ddEmail = document.getElementById('dropdown-user-email');
  const sideName = document.getElementById('settings-sidebar-name');
  const sideRole = document.getElementById('settings-sidebar-role');

  if (ddName) ddName.textContent = profile.name;
  if (ddEmail) ddEmail.textContent = profile.email;
  if (sideName) sideName.textContent = profile.name;
  if (sideRole) sideRole.textContent = profile.role || 'Owner';

  // Populate Mobile Settings Sheet user profile card details
  const sheetAvatar = document.getElementById('sheet-profile-avatar');
  const sheetName = document.getElementById('sheet-user-name');
  const sheetEmail = document.getElementById('sheet-user-email');

  if (sheetAvatar) {
    if (profile.profile_picture) {
      sheetAvatar.innerHTML = `<img src="${profile.profile_picture}" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">`;
    } else {
      sheetAvatar.innerHTML = nameInitial;
    }
  }
  if (sheetName) sheetName.textContent = profile.name;
  if (sheetEmail) sheetEmail.textContent = profile.email;

  const infoUsername = document.getElementById('info-username');
  const infoRole = document.getElementById('info-role');
  const infoEmail = document.getElementById('info-email');
  const infoMobile = document.getElementById('info-mobile');
  const infoCreated = document.getElementById('info-created');
  const infoLastLogin = document.getElementById('info-lastlogin');
  const infoTimezone = document.getElementById('info-timezone');
  const infoLanguage = document.getElementById('info-language');
  const infoTheme = document.getElementById('info-theme');

  // Hero card shows name in info-username element
  if (infoUsername) infoUsername.textContent = profile.name;
  if (infoRole) infoRole.textContent = profile.role || 'Owner';
  if (infoEmail) infoEmail.textContent = profile.email;
  if (infoMobile) infoMobile.textContent = profile.mobile || '-';
  if (infoCreated) infoCreated.textContent = profile.created_at;
  if (infoLastLogin) infoLastLogin.textContent = profile.last_login || '-';
  if (infoTimezone) infoTimezone.textContent = profile.timezone;
  if (infoLanguage) infoLanguage.textContent = window.languageFlags[profile.language] || profile.language;
  if (infoTheme) infoTheme.textContent = t(profile.theme + '_mode') || profile.theme;

  // Update role badge
  const roleBadge = document.getElementById('info-role-badge');
  if (roleBadge) roleBadge.textContent = profile.role || 'Owner';


  const sessionDevice = document.getElementById('session-device');
  const sessionBrowser = document.getElementById('session-browser');
  const sessionLogin = document.getElementById('session-logintime');

  if (sessionDevice) {
    const platform = navigator.userAgentData ? navigator.userAgentData.platform : navigator.platform;
    sessionDevice.textContent = platform || 'Unknown Device';
  }
  if (sessionBrowser) {
    const ua = navigator.userAgent;
    let browser = 'Unknown Browser';
    if (ua.indexOf('Chrome') > -1) browser = 'Google Chrome';
    else if (ua.indexOf('Firefox') > -1) browser = 'Mozilla Firefox';
    else if (ua.indexOf('Safari') > -1) browser = 'Apple Safari';
    else if (ua.indexOf('Edge') > -1) browser = 'Microsoft Edge';
    sessionBrowser.textContent = browser;
  }
  if (sessionLogin) {
    if (!state.sessionLoginTime) {
      state.sessionLoginTime = new Date().toLocaleString();
    }
    sessionLogin.textContent = state.sessionLoginTime;
  }

  const editName = document.getElementById('profile-edit-name');
  const editEmail = document.getElementById('profile-edit-email');
  const editMobile = document.getElementById('profile-edit-mobile');

  if (editName) editName.value = profile.name;
  if (editEmail) editEmail.value = profile.email;
  if (editMobile) editMobile.value = profile.mobile || '';

  const prefTheme = document.getElementById('pref-theme');
  const prefTimezone = document.getElementById('pref-timezone');
  
  const prefNotifyTxn = document.getElementById('pref-notify-txn');
  const prefNotifyBackup = document.getElementById('pref-notify-backup');
  const prefNotifySystem = document.getElementById('pref-notify-system');
  const prefNotifyReminder = document.getElementById('pref-notify-reminder');

  if (prefTheme) prefTheme.value = profile.theme;
  if (prefTimezone) {
    const detectedTz = profile.timezone || 'Asia/Kolkata';
    let tzExists = false;
    for (let i = 0; i < prefTimezone.options.length; i++) {
      if (prefTimezone.options[i].value === detectedTz) {
        tzExists = true;
        break;
      }
    }
    if (!tzExists) {
      const opt = document.createElement('option');
      opt.value = detectedTz;
      opt.textContent = detectedTz;
      prefTimezone.appendChild(opt);
    }
    prefTimezone.value = detectedTz;
  }

  if (prefNotifyTxn) prefNotifyTxn.checked = profile.notification_transactions === 1;
  if (prefNotifyBackup) prefNotifyBackup.checked = profile.notification_backup === 1;
  if (prefNotifySystem) prefNotifySystem.checked = profile.notification_system === 1;
  if (prefNotifyReminder) prefNotifyReminder.checked = profile.notification_reminder === 1;

  const backupEmail = document.getElementById('backup-email-dest');
  const backupSchedule = document.getElementById('backup-schedule-select');
  const backupTime = document.getElementById('backup-time-input');

  if (backupEmail) backupEmail.value = profile.email;
  if (backupSchedule) backupSchedule.value = profile.backup_schedule || 'manual';
  if (backupTime) backupTime.value = profile.backup_time || '00:00';

  updateTimezoneBadge(profile.timezone);
}

// ================= BACKUP & RESTORE MODULE =================

async function fetchBackupHistory() {
  const tbody = document.getElementById('backup-history-list');
  if (!tbody) return;

  try {
    const res = await apiFetch('/api/backup/history');
    if (!res.ok) throw new Error('Failed to fetch backup history');
    const history = await res.json();

    if (history.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 30px;" data-i18n="no_backup_history">
            No backups found. Click "Backup Now" to create your first backup.
          </td>
        </tr>
      `;
      translatePage();
      return;
    }

    tbody.innerHTML = '';
    history.forEach(item => {
      const tr = document.createElement('tr');

      // Date & Time formatting
      const dateText = item.timestamp;

      // Type
      const typeText = item.type === 'manual' ? t('backup_manual') || 'Manual' : t('backup_automatic') || 'Automatic';

      // Status Badge
      let statusHtml = '';
      if (item.status === 'success') {
        statusHtml = `<span class="status-badge success"><i data-lucide="check-circle" style="width:12px; height:12px;"></i> ${t('status_success') || 'Success'}</span>`;
      } else {
        const errorTip = item.error_message ? escapeAttr(item.error_message) : 'Unknown error';
        statusHtml = `<span class="status-badge failed" title="${errorTip}"><i data-lucide="alert-circle" style="width:12px; height:12px;"></i> ${t('status_failed') || 'Failed'}</span>`;
      }

      // Size formatting
      let sizeText = '-';
      if (item.size > 0) {
        if (item.size < 1024) sizeText = `${item.size} B`;
        else if (item.size < 1024 * 1024) sizeText = `${(item.size / 1024).toFixed(1)} KB`;
        else sizeText = `${(item.size / (1024 * 1024)).toFixed(1)} MB`;
      }

      // Actions
      const actionsHtml = `
        <div class="history-actions-cell">
          <button class="btn-icon" onclick="downloadBackup('${item.id}')" title="${t('tooltip_download') || 'Download Backup'}">
            <i data-lucide="download"></i>
          </button>
          <button class="btn-icon" onclick="resendBackupEmail('${item.id}')" title="${t('tooltip_resend') || 'Resend Email'}">
            <i data-lucide="mail"></i>
          </button>
          <button class="btn-icon delete" onclick="deleteBackup('${item.id}')" title="${t('tooltip_delete') || 'Delete Backup'}">
            <i data-lucide="trash-2"></i>
          </button>
        </div>
      `;

      tr.innerHTML = `
        <td>${escapeHtml(dateText)}</td>
        <td>${escapeHtml(typeText)}</td>
        <td>${statusHtml}</td>
        <td>${sizeText}</td>
        <td>${actionsHtml}</td>
      `;

      tbody.appendChild(tr);
    });

    lucide.createIcons();
  } catch (error) {
    showToast(error.message, 'error');
  }
}

// Global actions bound to backup table buttons
window.downloadBackup = function(id) {
  apiFetch(`/api/backup/download/${id}`)
    .then(async (res) => {
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('content-disposition');
      let filename = `backup_${id}.zip`;
      if (disposition && disposition.indexOf('attachment') !== -1) {
        const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
        const matches = filenameRegex.exec(disposition);
        if (matches != null && matches[1]) {
          filename = matches[1].replace(/['"]/g, '');
        }
      }
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    })
    .catch(err => showToast(err.message, 'error'));
};

window.resendBackupEmail = async function(id) {
  showToast(t('resending_email') || 'Sending backup email...', 'info');
  try {
    const res = await apiFetch(`/api/backup/resend/${id}`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed to resend email');
    }
    showToast(t('email_sent_success') || 'Backup email resent successfully!', 'success');
    fetchBackupHistory();
  } catch (err) {
    showToast(err.message, 'error');
    fetchBackupHistory();
  }
};

window.deleteBackup = function(id) {
  openConfirmModal(
    t('delete_backup_title') || 'Delete Backup',
    t('delete_backup_confirm') || 'Are you sure you want to permanently delete this backup file from the server?',
    async () => {
      try {
        const res = await apiFetch(`/api/backup/${id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error('Failed to delete backup');
        showToast(t('backup_deleted') || 'Backup deleted successfully', 'success');
        fetchBackupHistory();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },
    'Yes, Delete'
  );
};

function initBackupRestoreEvents() {
  // Settings Form submit
  const form = document.getElementById('backup-settings-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const backup_schedule = document.getElementById('backup-schedule-select').value;
      const backup_time = document.getElementById('backup-time-input').value;

      try {
        const res = await apiFetch('/api/profile', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...state.profile,
            backup_schedule,
            backup_time
          })
        });

        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Failed to save settings');
        }

        const updatedProfile = await res.json();
        state.profile = updatedProfile;
        updateProfileUI();
        updateProfileSubViews();
        showToast(t('update_success') || 'Settings updated successfully', 'success');
      } catch (error) {
showToast(error.message, 'error');
      }
    },
    'Yes, Delete'
  );
}

  // Backup Now button
  const backupBtn = document.getElementById('backup-now-btn');
  if (backupBtn) {
    backupBtn.addEventListener('click', async () => {
      backupBtn.disabled = true;
      const origHtml = backupBtn.innerHTML;
      backupBtn.innerHTML = `<i data-lucide="loader" class="spin-icon" style="width:14px; height:14px; animation: spin 1s linear infinite;"></i> Processing...`;
      lucide.createIcons();

      showToast(t('backup_started') || 'Creating backup zip and sending email...', 'info');

      try {
        const res = await apiFetch('/api/backup/run', { method: 'POST' });
        if (!res.ok) {
          const err = await res.json();
          throw new Error(err.error || 'Backup failed');
        }
        showToast(t('backup_success_msg') || 'Backup created and sent successfully!', 'success');
        fetchBackupHistory();
        fetchProfile();
      } catch (error) {
        showToast(error.message, 'error');
        fetchBackupHistory();
      } finally {
        backupBtn.disabled = false;
        backupBtn.innerHTML = origHtml;
        lucide.createIcons();
      }
    });
  }

  // Restore Backup Drag and Drop
  const dropzone = document.getElementById('restore-dropzone');
  const fileInput = document.getElementById('restore-file-input');
  const selectBtn = document.getElementById('restore-select-btn');

  if (dropzone && fileInput) {
    const handleRestoreFile = async (file) => {
      if (!file || file.name.split('.').pop().toLowerCase() !== 'zip') {
        showToast('Please select a valid backup ZIP file.', 'error');
        return;
      }

      openConfirmModal(
        t('restore_confirm_title') || 'Restore Database',
        t('restore_confirm_msg') || 'WARNING: Restoring will overwrite all existing ledgers, transactions, and settings. Are you absolutely sure you want to proceed?',
        () => {
          const reader = new FileReader();
          
          const progressContainer = document.getElementById('restore-progress-container');
          const progressBar = document.getElementById('restore-progress-bar');
          if (progressContainer && progressBar) {
            progressContainer.classList.remove('hidden');
            progressBar.style.width = '20%';
          }

          reader.onload = async (evt) => {
            if (progressBar) progressBar.style.width = '60%';
            
            const dataUrl = evt.target.result;
            const base64Content = dataUrl.split(',')[1];

            try {
              if (progressBar) progressBar.style.width = '80%';
              const res = await apiFetch('/api/backup/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileContent: base64Content })
              });

              if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || 'Failed to restore database');
              }

              if (progressBar) progressBar.style.width = '100%';
              showToast(t('restore_success_msg') || 'Database restored successfully! Reloading KhataBook...', 'success');
              
              setTimeout(() => {
                window.location.reload();
              }, 2000);

            } catch (err) {
              showToast(err.message, 'error');
              if (progressContainer) progressContainer.classList.add('hidden');
            }
          };

          reader.onerror = () => {
            showToast('Failed to read backup file.', 'error');
            if (progressContainer) progressContainer.classList.add('hidden');
          };

          reader.readAsDataURL(file);
        },
        'Yes, Restore'
      );
    };

    selectBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });

    dropzone.addEventListener('click', () => {
      fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) handleRestoreFile(file);
      fileInput.value = '';
    });

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragenter', (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('dragover');
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      const file = e.dataTransfer.files[0];
      if (file) handleRestoreFile(file);
    });
  }
}

// ================= PROFILE SUB-VIEW POPULATION =================
function updateProfileSubViews() {
  const profile = state.profile;
  if (!profile) return;
  const nameInitial = (profile.name || 'Owner').charAt(0).toUpperCase();

  // Populate sidebar in all 6 sub-views
  ['my', 'edit', 'pref', 'sec', 'act', 'bak'].forEach(function(suffix) {
    var subAvatar = document.getElementById('settings-profile-avatar-sub-' + suffix);
    var subName = document.getElementById('settings-sidebar-name-sub-' + suffix);
    var subRole = document.getElementById('settings-sidebar-role-sub-' + suffix);
    if (subAvatar) {
      if (profile.profile_picture) {
        subAvatar.innerHTML = '<img src="' + profile.profile_picture + '" style="width:100%; height:100%; border-radius:50%; object-fit:cover;">';
      } else {
        subAvatar.innerHTML = nameInitial;
      }
    }
    if (subName) subName.textContent = profile.name;
    if (subRole) subRole.textContent = profile.role || 'Owner';
  });

  // My Profile sub-view hero
  var myPicSub = document.getElementById('my-profile-pic-sub');
  var myInitialsSub = document.getElementById('my-profile-initials-sub');
  if (myPicSub && myInitialsSub) {
    if (profile.profile_picture) {
      myPicSub.src = profile.profile_picture;
      myPicSub.style.display = 'block';
      myInitialsSub.style.display = 'none';
    } else {
      myPicSub.src = '';
      myPicSub.style.display = 'none';
      myInitialsSub.style.display = 'flex';
      myInitialsSub.textContent = nameInitial;
    }
  }

  // My Profile sub-view info cards
  var infoUsernameSub = document.getElementById('info-username-sub');
  var infoRoleBadgeSub = document.getElementById('info-role-badge-sub');
  var infoRoleSub = document.getElementById('info-role-sub');
  var infoEmailSub = document.getElementById('info-email-sub');
  var infoMobileSub = document.getElementById('info-mobile-sub');
  var infoCreatedSub = document.getElementById('info-created-sub');
  var infoLastLoginSub = document.getElementById('info-lastlogin-sub');
  var infoTimezoneSub = document.getElementById('info-timezone-sub');
  var infoLanguageSub = document.getElementById('info-language-sub');
  var infoThemeSub = document.getElementById('info-theme-sub');

  if (infoUsernameSub) infoUsernameSub.textContent = profile.name;
  if (infoRoleBadgeSub) infoRoleBadgeSub.textContent = profile.role || 'Owner';
  if (infoRoleSub) infoRoleSub.textContent = profile.role || 'Owner';
  if (infoEmailSub) infoEmailSub.textContent = profile.email;
  if (infoMobileSub) infoMobileSub.textContent = profile.mobile || '-';
  if (infoCreatedSub) infoCreatedSub.textContent = profile.created_at;
  if (infoLastLoginSub) infoLastLoginSub.textContent = profile.last_login || '-';
  if (infoTimezoneSub) infoTimezoneSub.textContent = profile.timezone;
  if (infoLanguageSub) infoLanguageSub.textContent = (window.languageFlags && window.languageFlags[profile.language]) || profile.language;
  if (infoThemeSub) infoThemeSub.textContent = (typeof t === 'function' ? t(profile.theme + '_mode') : profile.theme) || profile.theme;

  // Session info in My Profile sub-view
  var sessionDeviceSub = document.getElementById('session-device-sub');
  var sessionBrowserSub = document.getElementById('session-browser-sub');
  var sessionLoginSub = document.getElementById('session-logintime-sub');
  if (sessionDeviceSub) {
    sessionDeviceSub.textContent = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || 'Unknown Device';
  }
  if (sessionBrowserSub) {
    var ua = navigator.userAgent;
    if (ua.indexOf('Chrome') > -1) sessionBrowserSub.textContent = 'Google Chrome';
    else if (ua.indexOf('Firefox') > -1) sessionBrowserSub.textContent = 'Mozilla Firefox';
    else if (ua.indexOf('Safari') > -1) sessionBrowserSub.textContent = 'Apple Safari';
    else if (ua.indexOf('Edge') > -1) sessionBrowserSub.textContent = 'Microsoft Edge';
    else sessionBrowserSub.textContent = 'Unknown Browser';
  }
  if (sessionLoginSub) {
    if (!state.sessionLoginTime) state.sessionLoginTime = new Date().toLocaleString();
    sessionLoginSub.textContent = state.sessionLoginTime;
  }

  // Logout button in My Profile sub-view
  var logoutSub = document.getElementById('profile-tab-logout-btn-sub');
  if (logoutSub) {
    // Remove previous listener to avoid duplicates
    var newLogoutBtn = logoutSub.cloneNode(true);
    logoutSub.parentNode.replaceChild(newLogoutBtn, logoutSub);
    newLogoutBtn.addEventListener('click', function(e) {
      e.preventDefault();
      showLogoutConfirmModal();
    });
  }
}
