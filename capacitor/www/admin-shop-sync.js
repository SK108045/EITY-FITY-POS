(() => {
  if (!window.OraforgeShops || typeof LocalAdmin === 'undefined') return;

  const originalKey = LocalAdmin.key.bind(LocalAdmin);
  const originalProfile = LocalAdmin.profile.bind(LocalAdmin);

  LocalAdmin.key = function(name) {
    if (window.OraforgeShops.activeShopId()) return window.OraforgeShops.key(name);
    return originalKey(name);
  };

  LocalAdmin.profile = function() {
    const base = originalProfile();
    const active = window.OraforgeShops.activeMeta();
    if (!active) return base;
    const categoryName = active.category_name || base.name;
    return {
      ...base,
      id: active.business_type || base.id,
      name: categoryName,
      tagline: `${categoryName} POS`,
      icon: window.OraforgeShops.PROFILE_META?.[active.business_type]?.icon || base.icon || '🏪',
    };
  };

  async function enhanceRegisteredOwnerLogin() {
    let shopId = window.OraforgeShops.activeShopId();
    if (!shopId) {
      const shops = await window.OraforgeShops.list();
      if (shops && shops.length > 0) {
        await window.OraforgeShops.activate(shops[0]);
        shopId = shops[0].id;
      }
    }
    if (!shopId) return;
    const shop = await window.OraforgeShops.find(shopId);
    if (!shop) return;
    const owner = (await window.OraforgeShops.usersForShop(shopId)).find(u => u.id === 2);
    if (owner) shop.owner_username = owner.username;

    const overlay = document.querySelector('#adminLoginOverlay');
    if (!overlay) return;
    const card = overlay.firstElementChild;
    if (!card || card.dataset.registeredOwnerLogin === '1') return;
    card.dataset.registeredOwnerLogin = '1';

    const profile = LocalAdmin.profile();
    const title = card.querySelector('h2');
    const subtitle = title?.nextElementSibling;
    const icon = card.querySelector('div > div[style*="width:48px"]');
    if (title) title.textContent = `${shop.name} Admin`;
    if (subtitle) subtitle.textContent = `${shop.category_name || profile.name} · Owner / manager sign in`;
    if (icon) icon.textContent = profile.icon || '🏪';

    const oldInput = card.querySelector('#adminPinInput');
    const oldButton = card.querySelector('#adminLoginBtn');
    const oldLabel = card.querySelector('label[for="adminPinInput"]');
    const error = card.querySelector('#adminLoginError');
    const demoText = [...card.querySelectorAll('div')].find(el => el.textContent?.includes('Demo manager PIN'));
    if (oldInput) oldInput.style.display = 'none';
    if (oldLabel) oldLabel.style.display = 'none';
    if (oldButton) oldButton.style.display = 'none';
    if (demoText) demoText.style.display = 'none';

    const form = document.createElement('div');
    form.style.cssText = 'display:grid;gap:12px;';
    form.innerHTML = `
      <label class="form-label" for="registeredOwnerUsername">Owner username</label>
      <input id="registeredOwnerUsername" class="form-input" autocomplete="username" placeholder="Owner username" value="${String(shop.owner_username || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">
      <label class="form-label" for="registeredOwnerPassword">Owner password</label>
      <input id="registeredOwnerPassword" class="form-input" type="password" autocomplete="current-password" placeholder="Owner password">
      <button id="registeredOwnerLoginBtn" class="btn btn-primary" style="width:100%;padding:12px;">Login to Admin</button>
      <div style="font-size:11px;color:var(--muted);text-align:center;line-height:1.45;">Use the owner credentials created when this shop was registered.</div>`;
    if (error) error.before(form);
    else card.appendChild(form);

    const username = form.querySelector('#registeredOwnerUsername');
    const password = form.querySelector('#registeredOwnerPassword');
    const button = form.querySelector('#registeredOwnerLoginBtn');
    const submit = async () => {
      if (error) error.textContent = '';
      button.disabled = true;
      button.textContent = 'Signing in…';
      try {
        const ok = await window.OraforgeShops.verifyOwner(shopId, username.value, password.value);
        if (!ok) throw new Error('Invalid owner username or password.');
        if (oldInput) oldInput.value = '1234';
        oldButton?.click();
      } catch (err) {
        if (error) error.textContent = err.message;
        button.disabled = false;
        button.textContent = 'Login to Admin';
        password.select();
      }
    };
    button.onclick = submit;
    password.onkeydown = event => {
      if (event.key === 'Enter') { event.preventDefault(); submit(); }
    };
    setTimeout(() => (username.value ? password : username).focus(), 50);
  }

  enhanceRegisteredOwnerLogin().catch(err => console.error('Owner login setup failed', err));
})();
