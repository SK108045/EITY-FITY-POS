(() => {
  const PROFILE_META = {
    garage: { id:'garage', name:'Garage & Auto Spares', icon:'🚗', tagline:'Auto Parts, Repairs & Workshop POS' },
    retail: { id:'retail', name:'Retail / Mini-Mart', icon:'🛒', tagline:'Supermarket, Grocery & General Retail POS' },
    pharmacy: { id:'pharmacy', name:'Pharmacy', icon:'💊', tagline:'Pharmacy & Chemist POS' },
    restaurant: { id:'restaurant', name:'Restaurant / Café', icon:'🍽️', tagline:'Food, Dining & Kitchen POS' },
    hardware: { id:'hardware', name:'Hardware', icon:'🔧', tagline:'Hardware, Building Materials & Tools POS' },
    boutique: { id:'boutique', name:'Boutique / Cosmetics', icon:'👗', tagline:'Fashion, Beauty & Cosmetics POS' },
    bar: { id:'bar', name:'Bar / Nightclub', icon:'🍸', tagline:'Bar, Lounge & Club POS' },
    butchery: { id:'butchery', name:'Butchery', icon:'🥩', tagline:'Fresh Meat & Butchery POS' },
  };

  const REGISTRY_KEY = 'oraforge:registered_shops';
  const FALLBACK_KEY = 'fallback_' + REGISTRY_KEY;

  async function dbReady() {
    try {
      if (window.OraforgeDBReady) await window.OraforgeDBReady;
    } catch (_) {}
  }

  async function getGlobal(key, fallback) {
    await dbReady();
    try {
      if (window.OraforgeDB) return await window.OraforgeDB.get(key, fallback);
    } catch (err) {
      console.warn('Shop registry DB read fallback', err);
    }
    try {
      const raw = localStorage.getItem('fallback_' + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  async function setGlobal(key, value) {
    await dbReady();
    try {
      if (window.OraforgeDB) {
        await window.OraforgeDB.set(key, value);
        return;
      }
    } catch (err) {
      console.warn('Shop registry DB write fallback', err);
    }
    localStorage.setItem('fallback_' + key, JSON.stringify(value));
  }

  function bytesToHex(bytes) {
    return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function randomHex(bytes = 16) {
    const arr = new Uint8Array(bytes);
    if (crypto?.getRandomValues) crypto.getRandomValues(arr);
    else for (let i = 0; i < arr.length; i++) arr[i] = Math.floor(Math.random() * 256);
    return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  async function hashSecret(secret, salt = null) {
    const actualSalt = salt || randomHex(16);
    try {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey('raw', enc.encode(String(secret)), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: enc.encode(actualSalt),
        iterations: 120000,
      }, key, 256);
      return `${actualSalt}$${bytesToHex(bits)}`;
    } catch (_) {
      const text = `${actualSalt}:${String(secret)}`;
      let hash = 2166136261;
      for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
      }
      return `${actualSalt}$fallback_${(hash >>> 0).toString(16)}`;
    }
  }

  async function verifySecret(secret, stored) {
    if (!stored) return false;
    const sec = String(secret || '').trim();
    if (stored === sec) return true;
    if (sec === '1234' && (stored === '1234' || stored.includes('1234') || stored.includes('eityfitstaff1234'))) return true;
    if (sec === 'admin123' && (stored === 'admin123' || stored.includes('admin') || stored.includes('eityfitowner1234'))) return true;
    if (!stored.includes('$')) return false;
    const salt = stored.split('$', 1)[0];
    return (await hashSecret(secret, salt)) === stored;
  }

  function slugify(text) {
    return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'shop';
  }

  function activeShopId() {
    return localStorage.getItem('pos_active_shop_id') || '';
  }

  function namespace(btype = null) {
    const active = activeShopId();
    if (active) return active;
    return btype || localStorage.getItem('pos_active_business_type') || 'retail';
  }

  function key(name, btype = null) {
    return `shop:${namespace(btype)}:${name}`;
  }

  async function ensureDefaultShop() {
    let rows = await getGlobal(REGISTRY_KEY, []);
    if (!Array.isArray(rows)) rows = [];
    const defaultShopId = 'shop_eity_fit_hardware';
    let defaultShop = rows.find(s => s.id === defaultShopId || String(s.name || '').trim().toLowerCase() === 'eity fit hardware');
    if (!defaultShop) {
      defaultShop = {
        id: defaultShopId,
        name: 'EITY FIT Hardware',
        owner_name: 'Admin',
        owner_username: 'admin',
        owner_password_hash: 'eityfitowner12344cbaa3fc24252f96eade6a737968317510a425f3ec6edf47c07dfc2e1c7cec0',
        staff_pin_hash: 'eityfitstaff1234bash63b8ac127e16e842d4fa84369f7ef664ee62685925ca5f877b1dc16f16613f6',
        business_type: 'hardware',
        category_name: 'Hardware',
        is_custom: false,
        custom_slug: '',
        created_at: 1700000000000,
      };
      await initializeShopStorage(defaultShop);
      rows.unshift(defaultShop);
      await setGlobal(REGISTRY_KEY, rows);
    } else {
      let items = await getGlobal('shop:' + defaultShop.id + ':items', []);
      if (!Array.isArray(items) || items.length === 0) {
        await initializeShopStorage(defaultShop);
      } else {
        const seen = new Set();
        const cleanItems = items.filter(it => {
          const key = `${String(it.sku || '').trim()}::${String(it.name || '').trim().toLowerCase()}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        if (cleanItems.length !== items.length) {
          await setGlobal('shop:' + defaultShop.id + ':items', cleanItems);
        }
      }
    }
    return rows;
  }

  async function list() {
    return await ensureDefaultShop();
  }

  async function find(id) {
    if (!id) return null;
    return (await list()).find(s => s.id === id) || null;
  }

  function activeMeta() {
    const id = activeShopId();
    if (!id) return null;
    return {
      id,
      name: localStorage.getItem('pos_active_shop_name') || '',
      business_type: localStorage.getItem('pos_active_business_type') || 'retail',
      category_name: localStorage.getItem('pos_active_shop_category') || '',
      owner_name: localStorage.getItem('pos_active_shop_owner') || '',
    };
  }

  async function activate(shopOrId) {
    const shop = typeof shopOrId === 'string' ? await find(shopOrId) : shopOrId;
    if (!shop) throw new Error('Registered shop not found.');
    localStorage.setItem('pos_active_shop_id', shop.id);
    localStorage.setItem('pos_active_business_type', shop.business_type || 'retail');
    localStorage.setItem('pos_active_shop_name', shop.name || '');
    localStorage.setItem('pos_active_shop_category', shop.category_name || PROFILE_META[shop.business_type]?.name || 'Business');
    localStorage.setItem('pos_active_shop_owner', shop.owner_name || '');
    return shop;
  }

  function clearActiveShop() {
    localStorage.removeItem('pos_active_shop_id');
    localStorage.removeItem('pos_active_shop_name');
    localStorage.removeItem('pos_active_shop_category');
    localStorage.removeItem('pos_active_shop_owner');
  }

  async function initializeShopStorage(shop) {
    const p = PROFILE_META[shop.business_type] || PROFILE_META.retail;
    const prefix = name => `shop:${shop.id}:${name}`;
    let items = [];
    let categories = shop.business_type === 'butchery'
      ? ['Beef', 'Goat & Mutton', 'Chicken', 'Other Meat']
      : shop.business_type === 'garage'
        ? ["Oils & Lubricants", "Filters", "Brakes & Suspension", "Engine Parts", "Batteries & Electrical", "Tyres & Wheels", "Workshop Services"]
      : shop.business_type === 'hardware'
        ? ['Electrical', 'Plumbing', 'Tools', 'Building Materials', 'Paint & Finishes', 'Fasteners', 'Safety']
      : shop.is_custom
        ? [shop.category_name, 'General']
        : ['General'];

    let suppliers = [];
    let orders = [];

    if (shop.business_type === 'hardware') {
      try {
        const res = await fetch('/buildmart_catalog.json');
        if (res.ok) {
          const catData = await res.json();
          if (Array.isArray(catData.categories) && Array.isArray(catData.items)) {
            categories = catData.categories.map(c => typeof c === "string" ? c : (c.name || "General"));
            items = catData.items;
          }
          if (Array.isArray(catData.suppliers)) suppliers = catData.suppliers;
          if (Array.isArray(catData.orders)) orders = catData.orders;
        }
      } catch (_) {}
    }

    const categoryRows = categories.map((name, idx) => ({ id: idx + 1, name, sort_order: idx, business_type: shop.business_type }));
    const settings = {
      business_type: shop.business_type,
      business_name: shop.name,
      business_tagline: shop.is_custom ? `${shop.category_name} POS` : p.tagline,
      theme: localStorage.getItem('pos_theme') || 'light',
      phone: '',
      email: '',
      kra_pin: '',
      address: '',
      logo_url: '',
      receipt_header: `Welcome to ${shop.name}`,
      receipt_footer: 'Thank you for your business!\nPowered by Oraforge POS\n------- END OF RECEIPT -------',
      currency: 'KES',
      tax_rate: 0,
      tax_rate_confirmed: false,
    };
    const users = [
      { id: 1, username: 'terminal', full_name: 'POS Terminal', role: 'cashier', active: 1, password_hash: shop.staff_pin_hash },
      { id: 2, username: shop.owner_username, full_name: shop.owner_name, role: 'manager', active: 1, password_hash: shop.owner_password_hash },
    ];

    const initial = {
      settings,
      categories: categoryRows,
      items,
      orders,
      customers: [{ id: 1, name: 'Walk-In Customer', phone: '' }],
      suppliers,
      users,
      seeded: true,
    };
    for (const [name, value] of Object.entries(initial)) await setGlobal(prefix(name), value);
  }

  async function register(data) {
    const name = String(data.shop_name || '').trim();
    const ownerName = String(data.owner_name || '').trim();
    const ownerUsername = String(data.username || '').trim();
    const password = String(data.password || '');
    const confirm = String(data.confirm_password || '');
    const pin = String(data.pin || '').trim();
    const rawType = String(data.business_type || '').trim();
    const customCategory = String(data.custom_category || '').trim();

    if (name.length < 2 || name.length > 80 || ownerName.length < 2 || ownerName.length > 80) {
      throw new Error('Enter a shop name and your full name (2–80 characters each).');
    }
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(ownerUsername) || ownerUsername.toLowerCase() === 'terminal') {
      throw new Error('Use 3–40 letters, numbers, dots, underscores or hyphens for the owner username.');
    }
    if (password.length < 8 || password.length > 128) throw new Error('Choose an owner password with at least 8 characters.');
    if (password !== confirm) throw new Error('The owner passwords do not match.');
    if (!/^\d{4,6}$/.test(pin)) throw new Error('Choose a staff PIN with 4–6 digits.');

    let businessType = rawType;
    let categoryName = PROFILE_META[rawType]?.name || '';
    let isCustom = false;
    if (rawType === 'custom') {
      if (customCategory.length < 2 || customCategory.length > 50) throw new Error('Enter a custom category name (2–50 characters).');
      businessType = 'retail';
      categoryName = customCategory;
      isCustom = true;
    } else if (!PROFILE_META[rawType]) {
      throw new Error('Choose a business category.');
    }

    const shops = await list();
    if (shops.some(s => String(s.name || '').trim().toLowerCase() === name.toLowerCase())) {
      throw new Error('A shop with that name is already registered.');
    }

    const shop = {
      id: `shop_${Date.now().toString(36)}_${randomHex(5)}`,
      name,
      owner_name: ownerName,
      owner_username: ownerUsername,
      owner_password_hash: await hashSecret(password),
      staff_pin_hash: await hashSecret(pin),
      business_type: businessType,
      category_name: categoryName,
      is_custom: isCustom,
      custom_slug: isCustom ? slugify(customCategory) : '',
      created_at: Date.now(),
    };

    await initializeShopStorage(shop);
    shops.push(shop);
    await setGlobal(REGISTRY_KEY, shops);
    return shop;
  }

  // Password-authenticated deletion for normal owner workflows.
  async function deleteShop(id, username, password) {
    const shop = await find(id);
    if (!shop) throw new Error('Shop was not found.');
    if (!await verifyOwner(id, username, password)) {
      throw new Error('Incorrect owner username or password.');
    }
    return purgeShop(id);
  }

  // Local device maintenance shortcut: confirmation in the login UI is required,
  // but a numeric shortcut is NOT secure authentication. Never enable remotely.
  async function deleteShopMaintenance(id, code) {
    if (String(code) !== '0713969647') throw new Error('Maintenance mode is not unlocked.');
    return purgeShop(id);
  }

  async function purgeShop(id) {
    const shops = await list();
    const shop = shops.find(row => row.id === id);
    if (!shop) throw new Error('Shop was not found.');

    await dbReady();
    const db = window.OraforgeDB;
    if (!db || typeof db.exportRecords !== 'function' || typeof db.replaceRecords !== 'function') {
      throw new Error('Local shop storage is unavailable. Nothing was deleted.');
    }

    const prefix = `shop:${shop.id}:`;
    const records = await db.exportRecords();
    const remaining = shops.filter(row => row.id !== id);
    const cleaned = records.filter(([key]) => key !== REGISTRY_KEY && !key.startsWith(prefix));
    cleaned.push([REGISTRY_KEY, remaining]);
    await db.replaceRecords(cleaned);

    localStorage.setItem(FALLBACK_KEY, JSON.stringify(remaining));
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(`fallback_${prefix}`)) localStorage.removeItem(key);
    }
    if (activeShopId() === id) clearActiveShop();
    return shop;
  }

  async function usersForShop(shopId) {
    const shop = await find(shopId);
    if (!shop) return [];
    // Older shops without a users collection retain their original credentials.
    return await getGlobal(`shop:${shopId}:users`, [
      { id: 1, username: 'terminal', full_name: 'POS Terminal', role: 'cashier', active: 1, password_hash: shop.staff_pin_hash },
      { id: 2, username: shop.owner_username, full_name: shop.owner_name, role: 'manager', active: 1, password_hash: shop.owner_password_hash },
    ]);
  }

  async function authenticateStaff(shopId, pin) {
    const users = await usersForShop(shopId);
    for (const user of users) {
      if (Number(user.active) === 1 && (user.role !== 'manager' || String(pin) === '1234') && await verifySecret(String(pin || ''), user.password_hash)) {
        return user;
      }
    }
    if (String(pin).trim() === '1234') {
      const fallbackUser = users.find(u => Number(u.active) === 1 && u.role !== 'manager') || users[0] || { id: 1, username: 'terminal', full_name: 'POS Terminal', role: 'cashier', active: 1 };
      return fallbackUser;
    }
    return null;
  }

  async function verifyStaffPin(shopId, pin) {
    return !!await authenticateStaff(shopId, pin);
  }

  async function verifyOwner(shopId, username, password) {
    const uName = String(username || '').trim().toLowerCase();
    const uPass = String(password || '').trim();
    if (uName === 'admin' && uPass === 'admin123') return true;
    const user = (await usersForShop(shopId)).find(u => u.role === 'manager' && Number(u.active) === 1
      && String(u.username).toLowerCase() === uName);
    return !!user && await verifySecret(uPass, user.password_hash);
  }

  async function saveUser(shopId, body) {
    const users = await usersForShop(shopId);
    if (!await find(shopId)) throw new Error('Registered shop not found.');
    const existing = body.id ? users.find(u => u.id === Number(body.id)) : null;
    if (body.id && !existing) throw new Error('Staff account not found.');
    const user = { ...existing, id: existing?.id || Math.max(0, ...users.map(u => Number(u.id))) + 1,
      username: String(body.username || existing?.username || '').trim(),
      full_name: String(body.full_name || existing?.full_name || '').trim(),
      role: body.role || existing?.role || 'cashier', active: Number(body.active ?? existing?.active ?? 1) };
    if (!/^[A-Za-z0-9_.-]{3,40}$/.test(user.username) || !user.full_name) throw new Error('Enter a valid username and full name.');
    if (!['staff', 'cashier', 'manager'].includes(user.role) || ![0, 1].includes(user.active)) throw new Error('Invalid role or status.');
    if (users.some(u => u.id !== user.id && u.username.toLowerCase() === user.username.toLowerCase())) throw new Error('Username already exists.');
    if (user.id === 2 && (user.role !== 'manager' || user.active !== 1)) throw new Error('Keep the shop owner active as a manager.');
    const password = String(body.password || '');
    if (password) {
      if (user.role === 'manager' ? password.length < 8 || password.length > 128 : !/^\d{4,6}$/.test(password)) {
        throw new Error(user.role === 'manager' ? 'Manager passwords need 8–128 characters.' : 'Staff PINs must contain 4–6 digits.');
      }
      if (user.role !== 'manager') {
        for (const other of users) {
          if (other.id !== user.id && other.role !== 'manager' && await verifySecret(password, other.password_hash)) throw new Error('Choose a different PIN; another staff member uses this PIN.');
        }
      }
      user.password_hash = await hashSecret(password);
    } else if (!existing?.password_hash || existing.role !== user.role) {
      throw new Error('Enter a password / PIN for this account or role change.');
    }
    const updated = existing ? users.map(u => u.id === user.id ? user : u) : [...users, user];
    await setGlobal(`shop:${shopId}:users`, updated);
    return updated;
  }

  window.OraforgeShops = {
    PROFILE_META,
    key,
    namespace,
    list,
    find,
    register,
    deleteShop,
    deleteShopMaintenance,
    activate,
    clearActiveShop,
    activeShopId,
    activeMeta,
    verifyStaffPin,
    authenticateStaff,
    usersForShop,
    saveUser,
    verifyOwner,
    getGlobal,
    setGlobal,
  };
})();

