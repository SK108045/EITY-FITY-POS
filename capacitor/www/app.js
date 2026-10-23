const money = cents => `KES ${(cents / 100).toFixed(2)}`;
const moneyRaw = cents => (cents / 100).toFixed(2);
const qs = (sel, root = document) => root.querySelector(sel);
const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

function parseOrderDate(order) {
  if (!order) return new Date();
  const raw = order.paid_at || order.updated_at || order.created_at || order.date || order.created_iso || order.updated_iso;
  if (!raw) return new Date();
  if (typeof raw === 'number') {
    return new Date(raw > 1e11 ? raw : raw * 1000);
  }
  if (typeof raw === 'string') {
    const num = Number(raw);
    if (!isNaN(num) && isFinite(num) && num > 0) {
      return new Date(num > 1e11 ? num : num * 1000);
    }
    const d = new Date(raw);
    if (!isNaN(d.getTime())) return d;
  }
  return new Date();
}
window.parseOrderDate = parseOrderDate;

// ── Receipt Modal ─────────────────────────────────────────────────────────────
const receiptEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
function showReceiptModal(order, isKot = false, autoPrintEtims = false) {
  document.getElementById('receiptModal')?.remove();

  const bname = state.settings?.business_name || 'POS SYSTEM';
  const baddr = state.settings?.address || '';
  const bphone = state.settings?.phone || '';
  const bEmail = state.settings?.email || '';
  const bPin = state.settings?.kra_pin || '';
  const bfooter = state.settings?.receipt_footer || 'Thank you for your business!\n------- END OF RECEIPT -------';
  const isQuote = Boolean(order.is_quote || order.order_type === 'quote');

  let bodyHtml = '';
  if (isKot) {
    const itemRows = (order.items || []).map(item =>
      `<tr>
        <td>
          <strong>${item.qty} x ${item.name}</strong>
          ${item.variant_info ? `<br><small style="color:#666">[${item.variant_info}]</small>` : ''}
          ${item.note ? `<br><small style="color:#2563eb">* ${item.note}</small>` : ''}
        </td>
      </tr>`
    ).join('');

    bodyHtml = `
      <div class="receipt">
        <h1 style="font-size:18px;">*** KITCHEN / BAR ORDER ***</h1>
        <p>Ticket: <strong>#${order.ticket_no}</strong></p>
        <div style="border-top: 2px dashed var(--line); margin: 10px 0;"></div>
        <div class="receipt-line"><span>Table / Tab</span><strong>${order.table_name || 'Counter'}</strong></div>
        <div class="receipt-line"><span>Server</span><strong>${order.employee_name || '-'}</strong></div>
        <div class="receipt-line"><span>Time</span><strong>${new Date().toLocaleTimeString()}</strong></div>
        ${order.notes ? `<div class="receipt-line"><span>Note</span><strong>${order.notes}</strong></div>` : ''}
        <div style="border-top: 2px dashed var(--line); margin: 10px 0;"></div>
        <table><tbody>${itemRows}</tbody></table>
        <div style="border-top: 2px dashed var(--line); margin: 10px 0;"></div>
        <button id="receiptPrintBtn">Print KOT</button>
      </div>
    `;
  } else {
    const itemRows = (order.items || []).map(item => {
      const qty = Number(item.qty ?? 1);
      const total = Number(item.line_total_cents || 0);
      const unit = Number.isFinite(Number(item.unit_price_cents))
        ? Number(item.unit_price_cents) : (qty ? total / qty : 0);
      const notes = [
        item.variant_info && `<small>${receiptEscape(item.variant_info)}</small>`,
        item.batch_no && `<small>Batch: ${receiptEscape(item.batch_no)}</small>`,
        item.note && `<small>${receiptEscape(item.note)}</small>`
      ].filter(Boolean).join(' ');
      return `
        <tr class="receipt-item-name"><td colspan="3">${receiptEscape(item.name)} ${notes}</td></tr>
        <tr class="receipt-item-values">
          <td>${receiptEscape(qty)}</td><td>${moneyRaw(unit)}</td><td>${moneyRaw(total)}</td>
        </tr>`;
    }).join('');
    // Do not infer VAT from today's settings. Respect the tax recorded with this sale.
    const grossCents = Number(order.total_cents || 0);
    const vatAmount = Math.max(0, Math.min(grossCents, Math.round(Number(order.tax_cents || 0))));
    const exclVat = grossCents - vatAmount;
    const savedRate = Number(order.tax_rate);
    const taxRate = (vatAmount > 0 || order.tax_treatment === 'vat')
      ? (order.tax_rate != null && Number.isFinite(savedRate) ? savedRate
        : (exclVat > 0 ? vatAmount / exclVat * 100 : 0)) : 0;
    const discountCents = Math.max(0, Number(order.discount_cents || 0));
    const subtotalCents = Number(order.subtotal_cents ?? (grossCents + discountCents));
    const created = parseOrderDate(order);
    const printedAt = new Date().toLocaleTimeString('en-KE', {hour:'2-digit', minute:'2-digit', second:'2-digit', hour12:true});
    const custName = order.etims_customer?.name || order.customer_name || 'Walk-In Customer';
    const custPin = (order.etims_customer?.pin || order.customer_kra_pin || '').trim();
    const custPhone = (order.etims_customer?.phone || order.customer_phone || '').trim();
    const custEmail = (order.etims_customer?.email || order.customer_email || '').trim();
    const custAddress = (order.etims_customer?.billing_address || order.etims_customer?.address || order.customer_billing_address || '').trim();
    const custRemarks = (order.etims_customer?.remarks || order.customer_remarks || '').trim();
    const contact = [
      baddr && `<p class="receipt-contact">Address: ${receiptEscape(baddr)}</p>`,
      bphone && `<p class="receipt-contact">Mobile: ${receiptEscape(bphone)}</p>`,
      bEmail && `<p class="receipt-contact">Email: ${receiptEscape(bEmail)}</p>`,
      bPin && `<p class="receipt-contact">KRA PIN: ${receiptEscape(bPin)}</p>`
    ].filter(Boolean).join('');
    bodyHtml = `
      <div class="receipt sales-receipt">
        <header class="receipt-business-header">
          <h1 class="receipt-business-name">${receiptEscape(bname)}</h1>
          ${contact}
          <p class="receipt-kind">${isQuote ? 'QUOTATION / ESTIMATE' : 'SALES RECEIPT'}</p>
          <h2 class="receipt-sale-title">${isQuote ? 'Quotation' : 'Cash Sale'}</h2>
        </header>
        <div class="receipt-details">
          <div class="receipt-line"><span>Name</span><span>${receiptEscape(custName)}</span></div>
          ${(custPin && custPin !== 'NA') ? `<div class="receipt-line"><span>Buyer KRA PIN</span><span>${receiptEscape(custPin)}</span></div>` : ''}
          ${custPhone ? `<div class="receipt-line"><span>Phone</span><span>${receiptEscape(custPhone)}</span></div>` : ''}
          ${custEmail ? `<div class="receipt-line"><span>Email</span><span>${receiptEscape(custEmail)}</span></div>` : ''}
          ${custAddress ? `<div class="receipt-line"><span>Address</span><span>${receiptEscape(custAddress)}</span></div>` : ''}
          ${custRemarks ? `<div class="receipt-line"><span>Remarks</span><span>${receiptEscape(custRemarks)}</span></div>` : ''}
          <div class="receipt-line"><span>Receipt No.</span><span>${receiptEscape(order.ticket_no || order.id || '-')}</span></div>
          <div class="receipt-line"><span>Date</span><span>${created.toLocaleDateString('en-GB')}</span></div>
          <div class="receipt-line"><span>Print Time</span><span>${printedAt}</span></div>
          ${order.table_name ? `<div class="receipt-line"><span>Table / Tab</span><span>${receiptEscape(order.table_name)}</span></div>` : ''}
          <div class="receipt-line"><span>Type</span><span>${receiptEscape((order.order_type || 'walk-in').toUpperCase())}</span></div>
          <div class="receipt-line"><span>Served By</span><span>${receiptEscape(order.employee_name || 'POS Terminal')}</span></div>
          <div class="receipt-line"><span>Status</span><span>${receiptEscape((order.status || 'open').toUpperCase())}</span></div>
        </div>
        <table class="receipt-items">
          <thead><tr><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
          <tbody>${itemRows}</tbody>
        </table>
        <div class="receipt-totals">
          ${discountCents ? `<div class="receipt-line"><span>Subtotal</span><span>${moneyRaw(subtotalCents)}</span></div><div class="receipt-line"><span>Discount</span><span>-${moneyRaw(discountCents)}</span></div>` : ''}
          <div class="receipt-line"><span>Total Excl. VAT</span><span>${moneyRaw(exclVat)}</span></div>
          <div class="receipt-line"><span>VAT Total (${Number(taxRate.toFixed(1))}%)</span><span>${moneyRaw(vatAmount)}</span></div>
          <div class="receipt-total"><span>Total</span><strong>KES ${moneyRaw(grossCents)}</strong></div>
        </div>
        ${isQuote ? '' : `
          <div class="receipt-payment">
            <div class="receipt-line"><span>Payment Method</span><span>${receiptEscape((order.payment_method || 'CASH').toUpperCase())}</span></div>
            ${order.payment_ref ? `<div class="receipt-line"><span>Txn Ref</span><span>${receiptEscape(order.payment_ref)}</span></div>` : ''}
          </div>
        `}
        ${isQuote ? '' : '<div data-etims-receipt></div>'}
        <footer class="receipt-note">${receiptEscape(bfooter)}</footer>
        <button id="receiptPrintBtn">Print ${isQuote ? 'Quotation' : 'Receipt'}</button>
      </div>
    `;

  }

  const overlay = document.createElement('div');
  overlay.id = 'receiptModal';
  overlay.dataset.etimsAutoPrint = String(autoPrintEtims && Boolean(order.etims_requested));
  overlay.className = 'receipt-modal-overlay';
  overlay.innerHTML = `
    <div class="receipt-modal" role="dialog" aria-modal="true">
      <button class="receipt-modal-close" id="receiptModalClose" title="Close">&times;</button>
      <div class="receipt-modal-print-area">
        ${bodyHtml}
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.classList.add('receipt-modal-visible');
  if (!isKot && !isQuote) window.OraforgeEtims?.mountReceipt(overlay, order);

  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  };

  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('receiptModalClose').addEventListener('click', close);
  document.getElementById('receiptPrintBtn').addEventListener('click', async () => {
    try {
      await overlay.etimsReady;
      if (!isKot && !isQuote && overlay.dataset.etimsRequested === 'true' && overlay.dataset.etimsConfirmed !== 'true') {
        toast('The payment is saved. Wait for eTIMS local issuance before printing the final fiscal receipt.', 'info');
        return;
      }
      await Promise.all([...overlay.querySelectorAll('.receipt-kra-qr')].map(img => img.decode()));
      if (window.OraforgeNative) {
        if (!window.OraforgePrinter) throw new Error('Install the latest APK to enable printing.');
        await window.OraforgePrinter.print({name:'Receipt '+(order.ticket_no || order.id)});
      } else { window.print(); }
    } catch(e) { toast('Could not open printing: '+e.message,'error'); }
  });

  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
}

// ── UI Utilities ─────────────────────────────────────────────────────────────
function toast(msg, type = 'success') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]||'•'}</span><span>${msg}</span>`;
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    document.body.appendChild(container);
  }
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── SPA Pages ────────────────────────────────────────────────────────────────
const SPA_PAGES = {
  '/pos':       { title: 'POS',       active: 'POS',       shell: 'pos-shell',  page: 'pos' },
  '/suppliers': { title: 'Suppliers', active: 'Suppliers', shell: 'page-shell', page: 'suppliers' },
  '/sales':     { title: 'Sales',     active: 'Sales',     shell: 'page-shell', page: 'sales' },
  '/products':  { title: 'Products',  active: 'Products',  shell: 'page-shell', page: 'products' },
  '/customers': { title: 'Customers', active: 'Customers', shell: 'page-shell', page: 'customers' },
  '/reports':   { title: 'Reports',   active: 'Reports',   shell: 'page-shell', page: 'reports' },
  '/settings':  { title: 'Settings',  active: 'Settings',  shell: 'page-shell', page: 'settings' },
};

// ── State & Capabilities ──────────────────────────────────────────────────────
const state = {
  user: null,
  settings: {},
  profile: {},
  profiles: {},
  capabilities: {},
  tables: [],
  alerts: { expiry: 0, low_stock: 0 },
  employees: [],
  selectedEmployeeId: null,
  selectedTableId: null,
  pricingTier: 'retail', // 'retail' or 'wholesale'
  categories: [],
  items: [],
  activeCategory: null,
  order: null,
  searchQuery: '',
};

function hasCap(capName) {
  return Boolean(state.capabilities && state.capabilities[capName]);
}

// Services can be sold repeatedly and do not consume physical inventory.
function garageUnitOptions(currentUnit = 'pcs') {
  const units = [...new Set(['pcs', 'btl', 'set', 'litre', 'service', currentUnit])];
  const escape = value => String(value).replace(/[&<>"]/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;'}[c]));
  return units.map(unit => `<option value="${escape(unit)}" ${currentUnit === unit ? 'selected' : ''}>${unit === 'service' ? 'Service / Labour (no stock)' : escape(unit)}</option>`).join('');
}

function tracksStock(item) {
  return Boolean(item && item.unit !== 'service' && item.stock_qty !== undefined);
}

function syncActiveTopNav(path = window.location.pathname) {
  const navRoot = qs('#topNav') || qs('header nav');
  if (!navRoot) return;
  const currentPath = (path || '/pos').replace(/\/+$/, '') || '/pos';
  const isPos = currentPath === '/pos' || currentPath === '' || currentPath === '/index.html';
  qsa('.nav-link', navRoot).forEach(link => {
    const rawHref = link.getAttribute('href') || '';
    const linkPath = new URL(rawHref, window.location.origin).pathname.replace(/\/+$/, '') || '/';
    const active = isPos ? (linkPath === '/pos' || linkPath === '/' || linkPath === '/index.html') : (linkPath === currentPath);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

function updateHeaderAndNav() {
  const bLogo = qs('.brand-logo');
  if (bLogo && state.profile && state.profile.icon) bLogo.textContent = state.profile.icon;
  const bName = qs('#brandName') || qs('.brand-text span');
  if (bName && state.settings && state.settings.business_name) bName.textContent = state.settings.business_name;
  const bTag = qs('#brandTagline') || qs('.brand-text small');
  if (bTag && state.settings && state.settings.business_tagline) bTag.textContent = state.settings.business_tagline;

  // Sync mobile drawer brand and user details
  const dTitle = qs('#drawerStoreTitle');
  if (dTitle && state.settings && state.settings.business_name) dTitle.textContent = state.settings.business_name;
  const dTag = qs('#drawerStoreTag');
  if (dTag && state.settings && state.settings.business_tagline) dTag.textContent = state.settings.business_tagline;
  const dUser = qs('#drawerUserName');
  if (dUser) {
    const shopName = (state.profile && state.profile.name) ? state.profile.name : 'Terminal Active';
    dUser.textContent = shopName;
  }
  const dLogout = qs('#drawerLogoutBtn');
  if (dLogout) {
    dLogout.onclick = (e) => {
      e.preventDefault();
      if (typeof window.closeMobileNav === 'function') window.closeMobileNav();
      const posLogout = qs('#posLogoutBtn');
      if (posLogout) posLogout.click();
    };
  }
  const dTheme = qs('#drawerThemeBtn');
  if (dTheme) {
    const currentTheme = document.documentElement.getAttribute('data-theme') || localStorage.getItem('pos_theme') || 'light';
    dTheme.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
    dTheme.onclick = (e) => {
      e.preventDefault();
      const themeToggle = qs('#themeToggleBtn');
      if (themeToggle) themeToggle.click();
      const updatedTheme = document.documentElement.getAttribute('data-theme') || 'light';
      dTheme.textContent = updatedTheme === 'dark' ? '☀️' : '🌙';
    };
  }

  // Remove quick profile switcher from inside the portal (store selection only on login)
  qs('#quickProfileWrap')?.remove();

  // Hook up Logout button to return to login screen
  const logoutBtn = qs('.logout');
  if (logoutBtn) {
    logoutBtn.onclick = (e) => {
      e.preventDefault();
      localStorage.removeItem('pos_logged_in');
      sessionStorage.removeItem('pos_admin_logged_in');
      if (window.OraforgeShops) window.OraforgeShops.clearActiveShop();
      state.items = [];
      state.categories = [];
      state.order = null;
      bootstrapped = false;
      showLoginScreen();
    };
  }

  // Setup theme toggle button in header
  const themeToggle = qs('#themeToggleBtn');
  if (themeToggle) {
    const currentTheme = document.documentElement.getAttribute('data-theme') || localStorage.getItem('pos_theme') || 'light';
    themeToggle.textContent = currentTheme === 'dark' ? '☀️' : '🌙';
    themeToggle.title = currentTheme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme';
    themeToggle.onclick = () => {
      const active = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      const next = active === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('pos_theme', next);
      themeToggle.textContent = next === 'dark' ? '☀️' : '🌙';
      themeToggle.title = next === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme';
      if (dTheme) dTheme.textContent = next === 'dark' ? '☀️' : '🌙';
      // Re-render settings if settings page is currently active
      if (qs('#themeCardLight') || qs('#themeCardDark')) {
        renderSettings();
      }
    };
  }

  const navRoot = qs('#topNav') || qs('header nav');
  if (navRoot) {
    const navItems = [
      { icon: '🖥️', label: 'POS', href: '/pos' },
    ];
    if (hasCap('suppliers')) {
      navItems.push({ icon: '🚚', label: 'Suppliers', href: '/suppliers' });
    }
    navItems.push({ icon: '🧾', label: 'Sales', href: '/sales' });
    const productLabel = state.profile?.id === 'garage' ? 'Catalogue' : state.profile?.item_label || 'Products';
    navItems.push({ icon: '📦', label: productLabel, href: '/products' });
    navItems.push({ icon: '📊', label: 'Reports', href: '/reports' });
    navItems.push({ icon: '⚙️', label: 'Settings', href: '/settings' });
    navItems.push({ icon: '👑', label: 'Admin', href: 'admin.html', id: 'navAdminLink' });

    navRoot.innerHTML = navItems.map(item =>
      `<a class="nav-link" href="${item.href}"${item.id ? ` id="${item.id}"` : ''}><span class="nav-icon">${item.icon}</span><span class="nav-text">${item.label}</span></a>`
    ).join('');
    syncActiveTopNav();
  }
}

if (!window.__posActiveNavRouterHooked) {
  window.__posActiveNavRouterHooked = true;
  const originalPushState = history.pushState.bind(history);
  const originalReplaceState = history.replaceState.bind(history);

  history.pushState = (...args) => {
    const result = originalPushState(...args);
    queueMicrotask(() => syncActiveTopNav());
    return result;
  };

  history.replaceState = (...args) => {
    const result = originalReplaceState(...args);
    queueMicrotask(() => syncActiveTopNav());
    return result;
  };

  window.addEventListener('popstate', () => queueMicrotask(() => syncActiveTopNav()));
  document.addEventListener('click', event => {
    const link = event.target.closest?.('#topNav .nav-link, header nav .nav-link');
    if (!link) return;
    const path = new URL(link.href, window.location.origin).pathname;
    syncActiveTopNav(path);
  });
}

// ── Full Profiles Data & Local Offline POS Storage ───────────────────────────
const LOCAL_PROFILES_DATA = {"profiles":{"retail":{"id":"retail","name":"Retail / Mini-Mart","tagline":"Supermarket, Grocery & General Retail POS","icon":"\ud83d\uded2","item_label":"Products","order_type_default":"walk-in","capabilities":{"barcode":true,"stock_tracking":true,"reorder_levels":true,"suppliers":true,"tables":false,"waiters":false,"kot":false,"batches_expiry":false,"decimal_qty":false,"units_extended":false,"quotations":true,"wholesale_pricing":false,"variants":false,"order_notes":false,"order_types":["walk-in","quote","delivery"]}},"pharmacy":{"id":"pharmacy","name":"Pharmacy","tagline":"Pharmacy & Chemist POS","icon":"\ud83d\udc8a","item_label":"Medicines","order_type_default":"walk-in","capabilities":{"barcode":true,"stock_tracking":true,"reorder_levels":true,"suppliers":true,"tables":false,"waiters":false,"kot":false,"batches_expiry":true,"decimal_qty":false,"units_extended":false,"quotations":false,"wholesale_pricing":false,"variants":false,"order_notes":true,"order_types":["walk-in","prescription","delivery"]}},"restaurant":{"id":"restaurant","name":"Restaurant / Caf\u00e9","tagline":"Food, Dining & Kitchen POS","icon":"\ud83c\udf7d\ufe0f","item_label":"Menu Items","order_type_default":"dine-in","capabilities":{"barcode":false,"stock_tracking":true,"reorder_levels":false,"suppliers":true,"tables":true,"waiters":true,"kot":true,"batches_expiry":false,"decimal_qty":false,"units_extended":false,"quotations":false,"wholesale_pricing":false,"variants":false,"order_notes":true,"order_types":["dine-in","takeaway","delivery"]}},"hardware":{"id":"hardware","name":"Hardware","tagline":"Hardware, Building Materials & Tools POS","icon":"\ud83d\udd27","item_label":"Hardware Items","order_type_default":"walk-in","capabilities":{"barcode":true,"stock_tracking":true,"reorder_levels":true,"suppliers":true,"tables":false,"waiters":false,"kot":false,"batches_expiry":false,"decimal_qty":true,"units_extended":true,"quotations":true,"wholesale_pricing":true,"variants":false,"order_notes":true,"order_types":["walk-in","quote","delivery"]}},"boutique":{"id":"boutique","name":"Boutique / Cosmetics","tagline":"Fashion, Beauty & Cosmetics POS","icon":"\ud83d\udc57","item_label":"Apparel & Beauty","order_type_default":"walk-in","capabilities":{"barcode":true,"stock_tracking":true,"reorder_levels":true,"suppliers":true,"tables":false,"waiters":false,"kot":false,"batches_expiry":false,"decimal_qty":false,"units_extended":false,"quotations":false,"wholesale_pricing":false,"variants":true,"order_notes":false,"order_types":["walk-in","layaway","delivery"]}},"bar":{"id":"bar","name":"Bar / Nightclub","tagline":"Bar, Lounge & Club POS","icon":"\ud83c\udf78","item_label":"Drinks & Snacks","order_type_default":"dine-in","capabilities":{"barcode":true,"stock_tracking":true,"reorder_levels":false,"suppliers":true,"tables":true,"waiters":true,"kot":true,"batches_expiry":false,"decimal_qty":false,"units_extended":false,"quotations":false,"wholesale_pricing":false,"variants":false,"order_notes":true,"order_types":["dine-in","bar-tab","takeaway"]}},"garage":{"id":"garage","name":"Garage & Auto Spares","tagline":"Auto Parts, Repairs & Workshop POS","icon":"\ud83d\ude97","item_label":"Parts & Services","order_type_default":"walk-in","capabilities":{"barcode":true,"stock_tracking":true,"reorder_levels":true,"suppliers":true,"tables":false,"waiters":false,"kot":false,"batches_expiry":false,"decimal_qty":false,"units_extended":true,"quotations":true,"wholesale_pricing":false,"variants":false,"order_notes":true,"order_types":["walk-in","service","quote"]}}},"sample_data":{"pharmacy":{"categories":["Pain & Fever Relief","Antibiotics & Prescriptions","Cough, Cold & Flu","Vitamins & Supplements","First Aid & Antiseptics"],"items":[{"category":"Pain & Fever Relief","name":"Paracetamol 500mg Tablets","price":100,"cost":60,"sku":"PHARM-001","barcode":"616120100001","stock":80,"unit":"strip","reorder_level":15,"batch_no":"B4829","expiry_date":"2027-11-30","manufacturer":"Dawa Ltd","strength":"500mg","image_url":"/static/uploads/sample_paracetamol.jpg","color":"#0e7490"},{"category":"Antibiotics & Prescriptions","name":"Amoxicillin 500mg Capsules","price":350,"cost":220,"sku":"PHARM-002","barcode":"616120100002","stock":40,"unit":"strip","reorder_level":10,"batch_no":"AM912","expiry_date":"2027-08-15","manufacturer":"Cosmos Ltd","strength":"500mg","image_url":"/static/uploads/sample_amoxicillin.jpg","color":"#0d9488"},{"category":"Cough, Cold & Flu","name":"Cough Relief Syrup 100ml","price":280,"cost":180,"sku":"PHARM-003","barcode":"616120100003","stock":24,"unit":"btl","reorder_level":6,"batch_no":"CR104","expiry_date":"2026-12-31","manufacturer":"Regal Pharma","strength":"100ml","image_url":"/static/uploads/sample_cough_syrup.jpg","color":"#b45309"},{"category":"Cough, Cold & Flu","name":"Cetirizine 10mg Tablets","price":150,"cost":90,"sku":"PHARM-004","barcode":"616120100004","stock":50,"unit":"strip","reorder_level":10,"batch_no":"CT553","expiry_date":"2027-05-20","manufacturer":"GlaxoSmithKline","strength":"10mg","image_url":"/static/uploads/sample_cetirizine.jpg","color":"#0284c7"},{"category":"Vitamins & Supplements","name":"Multivitamin Effervescent 20s","price":650,"cost":450,"sku":"PHARM-005","barcode":"616120100005","stock":18,"unit":"tube","reorder_level":5,"batch_no":"MV771","expiry_date":"2028-01-10","manufacturer":"Bayer","strength":"20 tabs","image_url":"/static/uploads/sample_multivitamin.jpg","color":"#d97706"},{"category":"First Aid & Antiseptics","name":"Povidone Iodine 100ml","price":220,"cost":140,"sku":"PHARM-006","barcode":"616120100006","stock":30,"unit":"btl","reorder_level":8,"batch_no":"PI302","expiry_date":"2027-04-01","manufacturer":"Medilab","strength":"10%","image_url":"/static/uploads/sample_iodine.jpg","color":"#9f1239"}]},"hardware":{"categories":["Cement & Building","Fasteners & Fixings","Paints & Finishes","Plumbing","Hand Tools","Electrical"],"items":[{"category":"Cement & Building","name":"Simba Portland Cement 50kg","price":750,"wholesale_price":680,"cost":620,"sku":"HDW-001","barcode":"616130100001","stock":120,"unit":"bag","reorder_level":25,"decimal_qty_enabled":0,"image_url":"/static/uploads/sample_cement.jpg","color":"#475569"},{"category":"Fasteners & Fixings","name":"Steel Wire Nails 3-inch","price":180,"wholesale_price":150,"cost":120,"sku":"HDW-002","barcode":"616130100002","stock":250,"unit":"kg","reorder_level":30,"decimal_qty_enabled":1,"image_url":"/static/uploads/sample_nails.jpg","color":"#64748b"},{"category":"Paints & Finishes","name":"Crown Vinyl Gloss Paint White 4L","price":2400,"wholesale_price":2100,"cost":1800,"sku":"HDW-003","barcode":"616130100003","stock":30,"unit":"tin","reorder_level":5,"decimal_qty_enabled":0,"image_url":"/static/uploads/sample_paint.jpg","color":"#ea580c"},{"category":"Plumbing","name":"PPR Plumbing Pipe 1/2-inch","price":120,"wholesale_price":95,"cost":80,"sku":"HDW-004","barcode":"616130100004","stock":300,"unit":"metre","reorder_level":50,"decimal_qty_enabled":1,"image_url":"/static/uploads/sample_pipe.jpg","color":"#10b981"},{"category":"Hand Tools","name":"Heavy Duty Claw Hammer 16oz","price":850,"wholesale_price":720,"cost":550,"sku":"HDW-005","barcode":"616130100005","stock":15,"unit":"pcs","reorder_level":4,"decimal_qty_enabled":0,"image_url":"/static/uploads/sample_hammer.jpg","color":"#1e293b"},{"category":"Electrical","name":"Twin & Earth Electric Cable 2.5mm","price":160,"wholesale_price":135,"cost":110,"sku":"HDW-006","barcode":"616130100006","stock":500,"unit":"metre","reorder_level":100,"decimal_qty_enabled":1,"image_url":"/static/uploads/sample_cable.jpg","color":"#dc2626"}]},"boutique":{"categories":["Women's Apparel","Men's Wear","Lip & Face Beauty","Skincare","Denim & Trousers"],"items":[{"category":"Women's Apparel","name":"Floral Summer Chiffon Dress","price":2800,"cost":1600,"sku":"BTQ-001","barcode":"616140100001","stock":24,"unit":"pcs","reorder_level":6,"image_url":"/static/uploads/sample_dress.jpg","color":"#db2777","variants_json":"[{\"name\": \"S / Sky Blue\", \"size\": \"S\", \"color\": \"Sky Blue\", \"shade\": \"\", \"stock\": 6, \"price_cents\": 280000}, {\"name\": \"M / Sky Blue\", \"size\": \"M\", \"color\": \"Sky Blue\", \"shade\": \"\", \"stock\": 8, \"price_cents\": 280000}, {\"name\": \"L / Sky Blue\", \"size\": \"L\", \"color\": \"Sky Blue\", \"shade\": \"\", \"stock\": 4, \"price_cents\": 280000}, {\"name\": \"M / Rose Pink\", \"size\": \"M\", \"color\": \"Rose Pink\", \"shade\": \"\", \"stock\": 6, \"price_cents\": 280000}]"},{"category":"Men's Wear","name":"Men's Oxford Slim Fit Shirt","price":2200,"cost":1300,"sku":"BTQ-002","barcode":"616140100002","stock":30,"unit":"pcs","reorder_level":8,"image_url":"/static/uploads/sample_shirt.jpg","color":"#2563eb","variants_json":"[{\"name\": \"38 / White\", \"size\": \"38\", \"color\": \"White\", \"shade\": \"\", \"stock\": 8, \"price_cents\": 220000}, {\"name\": \"40 / White\", \"size\": \"40\", \"color\": \"White\", \"shade\": \"\", \"stock\": 10, \"price_cents\": 220000}, {\"name\": \"42 / Navy Blue\", \"size\": \"42\", \"color\": \"Navy Blue\", \"shade\": \"\", \"stock\": 12, \"price_cents\": 220000}]"},{"category":"Lip & Face Beauty","name":"Velvet Matte Longstay Lipstick","price":850,"cost":450,"sku":"BTQ-003","barcode":"616140100003","stock":45,"unit":"pcs","reorder_level":12,"image_url":"/static/uploads/sample_lipstick.jpg","color":"#be123c","variants_json":"[{\"name\": \"Ruby Red #01\", \"size\": \"\", \"color\": \"Red\", \"shade\": \"Ruby Red\", \"stock\": 15, \"price_cents\": 85000}, {\"name\": \"Velvet Nude #05\", \"size\": \"\", \"color\": \"Nude\", \"shade\": \"Velvet Nude\", \"stock\": 18, \"price_cents\": 85000}, {\"name\": \"Plum Desire #09\", \"size\": \"\", \"color\": \"Purple\", \"shade\": \"Plum Desire\", \"stock\": 12, \"price_cents\": 85000}]"},{"category":"Skincare","name":"Hydrating Glow Serum 50ml","price":1500,"cost":900,"sku":"BTQ-004","barcode":"616140100004","stock":20,"unit":"btl","reorder_level":5,"image_url":"/static/uploads/sample_serum.jpg","color":"#f59e0b"},{"category":"Denim & Trousers","name":"High-Waist Stretch Denim Jeans","price":2500,"cost":1400,"sku":"BTQ-005","barcode":"616140100005","stock":18,"unit":"pcs","reorder_level":5,"image_url":"/static/uploads/sample_jeans.jpg","color":"#1e3a8a","variants_json":"[{\"name\": \"Size 28 / Dark Wash\", \"size\": \"28\", \"color\": \"Dark Wash\", \"shade\": \"\", \"stock\": 6, \"price_cents\": 250000}, {\"name\": \"Size 30 / Dark Wash\", \"size\": \"30\", \"color\": \"Dark Wash\", \"shade\": \"\", \"stock\": 7, \"price_cents\": 250000}, {\"name\": \"Size 32 / Light Wash\", \"size\": \"32\", \"color\": \"Light Wash\", \"shade\": \"\", \"stock\": 5, \"price_cents\": 250000}]"}]},"restaurant":{"categories":["Burgers & Grills","Main Courses","Pizzas","Pasta & Bowls","Desserts","Beverages"],"items":[{"category":"Burgers & Grills","name":"Classic Beef Burger with Fries","price":650,"cost":320,"sku":"REST-001","barcode":"","stock":100,"unit":"plate","reorder_level":0,"image_url":"/static/uploads/sample_burger.jpg","color":"#b45309"},{"category":"Main Courses","name":"Grilled Herb Chicken Breast","price":850,"cost":420,"sku":"REST-002","barcode":"","stock":80,"unit":"plate","reorder_level":0,"image_url":"/static/uploads/sample_chicken.jpg","color":"#c2410c"},{"category":"Pizzas","name":"Wood-Fired Margherita Pizza","price":900,"cost":400,"sku":"REST-003","barcode":"","stock":50,"unit":"pie","reorder_level":0,"image_url":"/static/uploads/sample_pizza.jpg","color":"#dc2626"},{"category":"Pasta & Bowls","name":"Creamy Chicken Alfredo Pasta","price":750,"cost":350,"sku":"REST-004","barcode":"","stock":60,"unit":"plate","reorder_level":0,"image_url":"/static/uploads/sample_pasta.jpg","color":"#ca8a04"},{"category":"Desserts","name":"Fresh Fruit Salad & Ice Cream","price":350,"cost":150,"sku":"REST-005","barcode":"","stock":40,"unit":"bowl","reorder_level":0,"image_url":"/static/uploads/sample_fruit.jpg","color":"#10b981"},{"category":"Beverages","name":"House Cappuccino Coffee","price":280,"cost":80,"sku":"REST-006","barcode":"","stock":200,"unit":"cup","reorder_level":0,"image_url":"/static/uploads/sample_coffee.jpg","color":"#78350f"}]},"retail":{"categories":["Bakery & Bread","Dairy & Milk","Cooking Oils & Spices","Sugar, Flour & Rice","Cleaning & Household"],"items":[{"category":"Bakery & Bread","name":"Fresh Sliced White Bread 400g","price":65,"cost":50,"sku":"RET-001","barcode":"616110100001","stock":45,"unit":"loaf","reorder_level":10,"image_url":"/static/uploads/sample_bread.jpg","color":"#d97706"},{"category":"Dairy & Milk","name":"Fresh Whole Milk 500ml","price":60,"cost":45,"sku":"RET-002","barcode":"616110100002","stock":30,"unit":"pkt","reorder_level":8,"image_url":"/static/uploads/sample_milk.jpg","color":"#0ea5e9"},{"category":"Cooking Oils & Spices","name":"Pure Vegetable Cooking Oil 1L","price":290,"cost":240,"sku":"RET-003","barcode":"616110100003","stock":25,"unit":"btl","reorder_level":5,"image_url":"/static/uploads/sample_oil.jpg","color":"#eab308"},{"category":"Sugar, Flour & Rice","name":"White Sugar Refined 1kg","price":170,"cost":140,"sku":"RET-004","barcode":"616110100004","stock":50,"unit":"pkt","reorder_level":10,"image_url":"/static/uploads/sample_sugar.jpg","color":"#64748b"},{"category":"Sugar, Flour & Rice","name":"Pure Basmati Rice 2kg","price":450,"cost":370,"sku":"RET-005","barcode":"616110100005","stock":20,"unit":"bag","reorder_level":5,"image_url":"/static/uploads/sample_rice.jpg","color":"#ca8a04"},{"category":"Cleaning & Household","name":"Multi-Purpose Bar Soap 800g","price":160,"cost":130,"sku":"RET-006","barcode":"616110100006","stock":35,"unit":"bar","reorder_level":8,"image_url":"/static/uploads/sample_soap.jpg","color":"#10b981"}]},"bar":{"categories":["Beers","Cocktails","Spirits","Wines","Soft Drinks","Snacks"],"items":[{"name":"Tusker Lager 500ml","category":"Beers","price":250,"cost":200,"color":"#d97706","sku":"BE-001","stock_qty":120,"unit":"btl"},{"name":"Guinness 500ml","category":"Beers","price":300,"cost":240,"color":"#1e293b","sku":"BE-002","stock_qty":80,"unit":"btl"},{"name":"White Cap 500ml","category":"Beers","price":250,"cost":200,"color":"#94a3b8","sku":"BE-003","stock_qty":100,"unit":"btl"},{"name":"Heineken","category":"Beers","price":350,"cost":280,"color":"#15803d","sku":"BE-004","stock_qty":60,"unit":"btl"},{"name":"Mojito","category":"Cocktails","price":600,"cost":300,"color":"#22c55e","sku":"CO-001","stock_qty":999,"unit":"glass"},{"name":"Margarita","category":"Cocktails","price":650,"cost":320,"color":"#eab308","sku":"CO-002","stock_qty":999,"unit":"glass"},{"name":"Jameson 750ml","category":"Spirits","price":3500,"cost":2800,"color":"#166534","sku":"SP-001","stock_qty":12,"unit":"btl"},{"name":"Gilbeys Gin 750ml","category":"Spirits","price":1800,"cost":1400,"color":"#0ea5e9","sku":"SP-002","stock_qty":15,"unit":"btl"},{"name":"Four Cousins Sweet","category":"Wines","price":1200,"cost":900,"color":"#db2777","sku":"WI-001","stock_qty":24,"unit":"btl"},{"name":"Coca Cola 300ml","category":"Soft Drinks","price":80,"cost":50,"color":"#dc2626","sku":"SD-001","stock_qty":60,"unit":"btl"},{"name":"Roasted Peanuts","category":"Snacks","price":100,"cost":60,"color":"#d97706","sku":"SN-001","stock_qty":30,"unit":"pkt"}]},"garage":{"categories":["Oils & Lubricants","Filters","Brakes & Suspension","Engine Parts","Batteries & Electrical","Tyres & Wheels","Workshop Services"],"items":[{"name":"Engine Oil 5W-30 \u00b7 4L","category":"Oils & Lubricants","price":3500,"cost":2600,"sku":"GAR-001","barcode":"2000000700014","stock":24,"stock_qty":24,"unit":"btl","color":"#183d35","reorder_level":5,"image_url":"/static/uploads/garage_engine_oil.jpg"},{"name":"Oil Filter","category":"Filters","price":850,"cost":500,"sku":"GAR-002","barcode":"2000000700021","stock":40,"stock_qty":40,"unit":"pcs","color":"#183d35","reorder_level":8,"image_url":"/static/uploads/garage_oil_filter.jpg"},{"name":"Front Brake Pads Set","category":"Brakes & Suspension","price":2800,"cost":1900,"sku":"GAR-003","barcode":"2000000700038","stock":18,"stock_qty":18,"unit":"set","color":"#183d35","reorder_level":4,"image_url":"/static/uploads/garage_brake_pads.jpg"},{"name":"Spark Plugs \u00b7 Set of 4","category":"Engine Parts","price":1800,"cost":1100,"sku":"GAR-004","barcode":"2000000700045","stock":32,"stock_qty":32,"unit":"set","color":"#183d35","reorder_level":6,"image_url":"/static/uploads/garage_spark_plugs.jpg"},{"name":"Car Battery \u00b7 12V 60Ah","category":"Batteries & Electrical","price":9500,"cost":7300,"sku":"GAR-005","barcode":"2000000700052","stock":10,"stock_qty":10,"unit":"pcs","color":"#183d35","reorder_level":3,"image_url":"/static/uploads/garage_car_battery.jpg"},{"name":"Passenger Tyre \u00b7 195/65 R15","category":"Tyres & Wheels","price":6500,"cost":4700,"sku":"GAR-006","barcode":"2000000700069","stock":16,"stock_qty":16,"unit":"pcs","color":"#183d35","reorder_level":4,"image_url":"/static/uploads/garage_tyre.jpg"},{"name":"Computer Diagnostics","category":"Workshop Services","price":1500,"cost":0,"sku":"GAR-007","barcode":"","stock":0,"stock_qty":0,"unit":"service","color":"#183d35","reorder_level":0,"image_url":"/static/uploads/garage_diagnostics.jpg"},{"name":"Oil Change Labour","category":"Workshop Services","price":800,"cost":0,"sku":"GAR-008","barcode":"","stock":0,"stock_qty":0,"unit":"service","color":"#183d35","reorder_level":0,"image_url":"/static/uploads/garage_engine_oil.jpg"}]}}};

const SHOP_PROFILES = [
  { id: 'garage', name: 'Garage & Auto Spares', icon: '🚗', tagline: 'Auto Parts, Repairs & Workshop POS' },
  { id: 'retail', name: 'Retail / Mini-Mart', icon: '🛒', tagline: 'Supermarket, Grocery & General Retail POS' },
  { id: 'pharmacy', name: 'Pharmacy & Chemist', icon: '💊', tagline: 'Pharmacy & Drugstore POS' },
  { id: 'restaurant', name: 'Restaurant & Café', icon: '🍽️', tagline: 'Food & Dining POS' },
  { id: 'hardware', name: 'Hardware & Tools', icon: '🔧', tagline: 'Hardware Store POS' },
  { id: 'boutique', name: 'Boutique & Fashion', icon: '👗', tagline: 'Fashion & Cosmetics POS' },
  { id: 'bar', name: 'Bar & Nightclub', icon: '🍸', tagline: 'Bar, Lounge & Club POS' }
];

const CLOUD_API_BASE = (localStorage.getItem('pos_cloud_api_base') || 'http://3.87.19.244:5000').replace(/\/$/, '');
const CLOUD_ONLY_PATHS = [
  '/api/admin/sms/config',
  '/api/admin/sms/send',
  '/api/product/image-search',
  '/api/product/save-image'
];

const PROFILE_SAMPLE_SKU_PREFIXES = {
  garage: 'GAR-',
  pharmacy: 'PHARM-',
  hardware: 'HDW-',
  boutique: 'BTQ-',
  retail: 'RET-',
  restaurant: 'REST-',
  bar: ['BE-', 'CO-', 'SP-', 'WI-', 'SD-', 'SN-']
};

function sanitizeProfileItems(items, profileId) {
  if (!Array.isArray(items) || !profileId) return items;
  const foreignPrefixes = [];
  for (const [p, prefixes] of Object.entries(PROFILE_SAMPLE_SKU_PREFIXES)) {
    if (p !== profileId) {
      if (Array.isArray(prefixes)) foreignPrefixes.push(...prefixes);
      else foreignPrefixes.push(prefixes);
    }
  }
  const seen = new Set();
  return items.filter(item => {
    const sku = String(item.sku || '').toUpperCase();
    if (foreignPrefixes.some(fp => sku.startsWith(fp))) return false;
    const key = `${String(item.sku || '').trim()}::${String(item.name || '').trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sanitizeProfileCategories(categories, profileId) {
  if (!Array.isArray(categories) || !profileId) return categories;
  const sampleData = (typeof LOCAL_PROFILES_DATA !== 'undefined') ? LOCAL_PROFILES_DATA.sample_data : null;
  if (!sampleData || !sampleData[profileId]) return categories;

  const validSampleCats = new Set((sampleData[profileId].categories || []).map(c => c.toLowerCase()));
  const otherCats = new Set();
  for (const [p, data] of Object.entries(sampleData)) {
    if (p !== profileId && data.categories) {
      data.categories.forEach(c => otherCats.add(c.toLowerCase()));
    }
  }

  return categories.filter(c => {
    if (c.custom) return true;
    const lower = String(c.name || '').toLowerCase();
    if (otherCats.has(lower) && !validSampleCats.has(lower)) {
      return false;
    }
    return true;
  });
}

const LocalPOS = {
  shopKey(name, btype = null) {
    if (window.OraforgeShops && window.OraforgeShops.activeShopId()) {
      return `shop:${window.OraforgeShops.activeShopId()}:${name}`;
    }
    const type = btype || localStorage.getItem('pos_active_business_type') || 'retail';
    return `shop:${type}:${name}`;
  },
  async get(key, fallback) {
    try {
      if (window.OraforgeDBReady) await window.OraforgeDBReady;
      if (window.OraforgeDB) return await window.OraforgeDB.get(key, fallback);
    } catch (e) {
      console.warn('Local DB read fallback:', e);
    }
    try {
      const raw = localStorage.getItem('fallback_' + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  async set(key, value) {
    try {
      if (window.OraforgeDBReady) await window.OraforgeDBReady;
      if (window.OraforgeDB) {
        await window.OraforgeDB.set(key, value);
        return;
      }
    } catch (e) {
      console.warn('Local DB write fallback:', e);
    }
    localStorage.setItem('fallback_' + key, JSON.stringify(value));
  },
  async getShop(name, fallback, btype = null) {
    return this.get(this.shopKey(name, btype), fallback);
  },
  async setShop(name, value, btype = null) {
    const res = await this.set(this.shopKey(name, btype), value);
    if (['orders', 'items', 'suppliers', 'categories', 'settings'].includes(name)) {
      window.OraforgeAutoBackup?.scheduleCheck?.();
    }
    return res;
  },
  async seedShop(btype, force = false) {
    const prof = LOCAL_PROFILES_DATA.profiles[btype] || LOCAL_PROFILES_DATA.profiles.retail;
    const sample = LOCAL_PROFILES_DATA.sample_data[btype] || LOCAL_PROFILES_DATA.sample_data.retail;
    const seeded = await this.getShop('seeded', false, btype);
    if (seeded && !force) return;

    const cats = sample.categories.map((name, i) => ({
      id: i + 1,
      name,
      sort_order: i,
      business_type: btype
    }));
    const items = sample.items.map((it, i) => ({
      id: i + 1,
      category_id: Math.max(1, sample.categories.indexOf(it.category) + 1),
      name: it.name,
      price_cents: Math.round(Number(it.price || 0) * 100),
      wholesale_price_cents: Math.round(Number(it.wholesale_price || 0) * 100),
      cost_cents: Math.round(Number(it.cost || 0) * 100),
      color: it.color || '#334155',
      sku: it.sku || `SKU-${i + 1}`,
      barcode: it.barcode || '',
      stock_qty: Number(it.stock_qty ?? it.stock ?? 0),
      unit: it.unit || 'pcs',
      reorder_level: Number(it.reorder_level ?? 5),
      batch_no: it.batch_no || '',
      expiry_date: it.expiry_date || '',
      manufacturer: it.manufacturer || '',
      strength: it.strength || '',
      variants_json: it.variants_json || '',
      decimal_qty_enabled: Number(it.decimal_qty_enabled || 0),
      image_url: it.image_url || '',
      active: 1
    }));

    await this.setShop('categories', cats, btype);
    await this.setShop('items', items, btype);
    if (force || !(await this.getShop('settings', null, btype))) {
      await this.setShop('settings', {
        business_name: prof.name + ' POS',
        business_tagline: prof.tagline || '',
        business_type: btype,
        tax_rate: 0,
        tax_rate_confirmed: false,
        currency: 'KES',
        phone: '',
        email: '',
        kra_pin: '',
        address: '',
        receipt_header: 'Welcome to ' + prof.name,
        receipt_footer: 'Thank you for your business!\n------- END OF RECEIPT -------'
      }, btype);
    }
    if (!(await this.getShop('orders', null, btype))) await this.setShop('orders', [], btype);
    if (!(await this.getShop('suppliers', null, btype))) {
      await this.setShop('suppliers', [
        { id: 1, name: 'Local Wholesale Distributor', phone: '', email: '', active: 1 }
      ], btype);
    }
    if (!(await this.getShop('customers', null, btype))) {
      await this.setShop('customers', [{ id: 1, name: 'Walk-In Customer', phone: '' }], btype);
    }
    await this.setShop('seeded', true, btype);
  },
  async switchProfile(btype) {
    const type = LOCAL_PROFILES_DATA.profiles[btype] ? btype : 'retail';
    localStorage.setItem('pos_active_business_type', type);
    await this.seedShop(type, false);
    return type;
  },
  async init() {
    const type = localStorage.getItem('pos_active_business_type') || 'retail';
    await this.seedShop(type, false);
    return type;
  },
  recalc(order) {
    order.subtotal_cents = (order.items || []).reduce((sum, it) => sum + Number(it.line_total_cents || 0), 0);
    order.tax_cents = 0;
    order.discount_cents = Math.min(order.subtotal_cents, Math.round(order.discount_type === 'percent'
      ? order.subtotal_cents * Number(order.discount_value || 0) / 100
      : Number(order.discount_value || 0) * 100));
    order.total_cents = order.subtotal_cents - order.discount_cents;
    order.updated_at = Math.floor(Date.now() / 1000);
    return order;
  },
  nextId(rows) {
    return (rows || []).reduce((m, row) => Math.max(m, Number(row.id || 0)), 0) + 1;
  },
  async saveOrders(orders, btype) {
    await this.setShop('orders', orders, btype);
  },
  async handle(path, options = {}) {
    const btype = await this.init();
    const url = new URL(path, 'https://local.pos');
    const cleanPath = url.pathname;
    const method = (options.method || 'GET').toUpperCase();
    const body = options.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) : {};
    const prof = LOCAL_PROFILES_DATA.profiles[btype] || LOCAL_PROFILES_DATA.profiles.retail;

    if (cleanPath === '/api/bootstrap') {
      let cats = await this.getShop('categories', [], btype);
      let items = await this.getShop('items', [], btype);

      const targetType = (window.OraforgeShops && window.OraforgeShops.activeShopId()
        ? (window.OraforgeShops.activeMeta()?.business_type || btype)
        : btype) || 'retail';

      const cleanItems = sanitizeProfileItems(items, targetType);
      const cleanCats = sanitizeProfileCategories(cats, targetType);

      if (cleanItems.length !== items.length) {
        items = cleanItems;
        await this.setShop('items', items, btype);
      }
      if (cleanCats.length !== cats.length) {
        cats = cleanCats;
        await this.setShop('categories', cats, btype);
      }

      let settings = await this.getShop('settings', {}, btype);
      // Previous versions assigned 16% automatically without tax verification.
      // Migrate that unconfirmed legacy default once; preserve owner-confirmed rates.
      if (Number(settings.tax_rate) === 16 && settings.tax_rate_confirmed !== true) {
        settings = { ...settings, tax_rate: 0, tax_rate_confirmed: false };
        await this.setShop('settings', settings, btype);
      }
      const low = items.filter(i => tracksStock(i) && Number(i.stock_qty || 0) <= Number(i.reorder_level ?? 5)).length;
      return {
        user: { id: 1, username: 'terminal', full_name: 'POS Terminal', role: 'cashier', business_type: btype },
        settings,
        profile: prof,
        profiles: LOCAL_PROFILES_DATA.profiles,
        capabilities: prof.capabilities || {},
        employees: window.OraforgeShops?.activeShopId()
          ? (await window.OraforgeShops.usersForShop(window.OraforgeShops.activeShopId())).filter(u => Number(u.active) === 1).map(u => ({ id: u.id, name: u.full_name }))
          : [{ id: 1, name: 'POS Terminal' }, { id: 2, name: 'The Owner' }],
        menu: { categories: cats, items },
        tables: [{ id: 1, name: 'Counter 1', seats: 4 }, { id: 2, name: 'Counter 2', seats: 4 }],
        alerts: { expiry: 0, low_stock: low }
      };
    }

    if (cleanPath === '/api/orders' && method === 'POST') {
      const orders = await this.getShop('orders', [], btype);
      const now = Math.floor(Date.now() / 1000);
      const order = {
        id: this.nextId(orders),
        ticket_no: `R${String(now).slice(-6)}-${String(orders.length + 1).padStart(3, '0')}`,
        business_type: btype,
        order_type: body.order_type || prof.order_type_default || 'walk-in',
        customer_name: body.customer_name || '',
        table_id: body.table_id || null,
        table_name: body.table_id ? `Counter ${body.table_id}` : '',
        employee_id: Number(body.employee_id || 1),
        employee_name: window.OraforgeShops?.activeShopId()
          ? (await window.OraforgeShops.usersForShop(window.OraforgeShops.activeShopId())).find(u => u.id === Number(body.employee_id || 1))?.full_name || 'POS Terminal'
          : Number(body.employee_id || 1) === 2 ? 'The Owner' : 'POS Terminal',
        pricing_tier: body.pricing_tier || 'retail',
        is_quote: body.is_quote ? 1 : 0,
        notes: body.notes || '',
        status: 'open', subtotal_cents: 0, tax_cents: 0, total_cents: 0,
        paid_cents: 0, payment_method: '', payment_ref: '',
        created_at: now, updated_at: now, paid_at: null, items: []
      };
      orders.unshift(order);
      await this.saveOrders(orders, btype);
      return order;
    }

    if (cleanPath === '/api/order/add-manual' && method === 'POST') {
      const orders=await this.getShop('orders',[],btype);
      const order=orders.find(o=>o.id===Number(body.order_id));
      if(!order || order.status!=='open')throw Error('Select an open sale');
      const name=String(body.name || '').trim(),sku=String(body.sku || '').trim().toLowerCase();
      const qty=Number(body.qty),price=Number(body.unit_price_cents),cost=Number(body.cost_cents);
      if(!name || name.length>160 || /[\u0000-\u001f]/.test(name+sku) || sku.length>120)throw Error('Enter a valid custom product name and reference');
      if(!Number.isFinite(qty) || qty<=0 || !Number.isSafeInteger(price) || price<=0 || !Number.isSafeInteger(cost) || cost<0 || !Number.isSafeInteger(Math.round(qty*price)))throw Error('Enter actual quantity, selling price and purchase cost');
      order.items.push({id:this.nextId(order.items || []),menu_item_id:null,name,qty,unit_price_cents:price,cost_cents:cost,
        line_total_cents:Math.round(qty*price),variant_info:'',note:'',batch_no:'',
        etims_product_key:'manual:'+(sku || name.toLowerCase()),etims_registration:{unit_cost_cents:cost}});
      this.recalc(order);await this.saveOrders(orders,btype);return order;
    }

    if (cleanPath === '/api/order/add' && method === 'POST') {
      const orders = await this.getShop('orders', [], btype);
      const products = await this.getShop('items', [], btype);
      const order = orders.find(o => o.id === Number(body.order_id));
      const product = products.find(i => i.id === Number(body.menu_item_id));
      if (!order) throw new Error('Sale not found');
      if (!product) throw new Error('Product not found');
      const qty = Number(body.qty || 1);
      const price = body.pricing_tier === 'wholesale' && Number(product.wholesale_price_cents || 0) > 0
        ? Number(product.wholesale_price_cents)
        : Number(body.unit_price_cents || product.price_cents || 0);
      const variant = body.variant_info || '';
      const note = body.note || '';
      let row = (order.items || []).find(i => i.menu_item_id === product.id && (i.variant_info || '') === variant && (i.note || '') === note);
      if (row) {
        row.qty = Number(row.qty || 0) + qty;
        row.unit_price_cents = price;
        row.line_total_cents = Math.round(row.qty * price);
      } else {
        row = {
          id: this.nextId(order.items || []),
          menu_item_id: product.id,
          name: product.name,
          description: product.description || '',
          qty,
          unit_price_cents: price,
          line_total_cents: Math.round(qty * price),
          cost_cents: Number(product.cost_cents || 0),
          variant_info: variant,
          note,
          batch_no: body.batch_no || product.batch_no || ''
        };
        order.items.push(row);
      }
      this.recalc(order);
      await this.saveOrders(orders, btype);
      return order;
    }

    if (cleanPath === '/api/order/qty' && method === 'POST') {
      const orders = await this.getShop('orders', [], btype);
      let found = null;
      for (const order of orders) {
        const idx = (order.items || []).findIndex(i => i.id === Number(body.item_id));
        if (idx < 0) continue;
        if (Number(body.qty) <= 0) order.items.splice(idx, 1);
        else {
          const row = order.items[idx];
          row.qty = Number(body.qty);
          row.line_total_cents = Math.round(row.qty * Number(row.unit_price_cents || 0));
        }
        this.recalc(order);
        found = order;
        break;
      }
      if (!found) throw new Error('Cart item not found');
      await this.saveOrders(orders, btype);
      return found;
    }

    if (cleanPath === '/api/order/status' && method === 'POST') {
      const orders = await this.getShop('orders', [], btype);
      const order = orders.find(o => o.id === Number(body.order_id));
      if (!order) throw new Error('Sale not found');
      if (body.status === 'paid') throw new Error('Payment status can only be set by a verified checkout.');
      order.status = body.status || order.status;
      order.updated_at = Math.floor(Date.now() / 1000);
      await this.saveOrders(orders, btype);
      return order;
    }

    if (cleanPath === '/api/order/convert-quote' && method === 'POST') {
      const orders = await this.getShop('orders', [], btype);
      const order = orders.find(o => o.id === Number(body.order_id));
      if (!order) throw new Error('Quotation not found');
      order.is_quote = 0;
      order.status = 'open';
      order.order_type = 'walk-in';
      this.recalc(order);
      await this.saveOrders(orders, btype);
      return order;
    }

    if (cleanPath === '/api/order/discount' && method === 'POST') {
      const orders = await this.getShop('orders', [], btype);
      const order = orders.find(o => o.id === Number(body.order_id));
      if (!order || !['open','sent'].includes(order.status)) throw new Error('Only unpaid sales can be discounted.');
      const value = Number(body.value);
      if (!['percent','fixed'].includes(body.type) || !Number.isFinite(value) || value < 0 || !Number.isSafeInteger(Math.round(value * 100)) || Math.abs(value * 100 - Math.round(value * 100)) > 0.00001) throw new Error('Enter a valid discount with up to two decimal places.');
      if (value > (body.type === 'percent' ? 100 : order.subtotal_cents / 100)) throw new Error('Discount exceeds the sale amount.');
      order.discount_type = body.type; order.discount_value = value;
      this.recalc(order); await this.saveOrders(orders, btype); return order;
    }

    if (cleanPath === '/api/order/pay' && method === 'POST') {
      const orders = await this.getShop('orders', [], btype);
      const products = await this.getShop('items', [], btype);
      const customers = await this.getShop('customers', [], btype);
      const order = orders.find(o => o.id === Number(body.order_id));
      if (!order) throw new Error('Sale not found');
      if (order.status === 'paid') return order;
      if (body.generate_etims && body.etims_shop_id !== (window.OraforgeShops?.activeShopId() || btype)) throw new Error('The active shop changed. Reopen checkout in the original shop.');
      const configuredSettings = await this.getShop('settings', {}, btype);
      const configuredRate = Number(configuredSettings.tax_rate);
      const explicitTax = body.tax_rate !== undefined;
      if(explicitTax && ![0,16].includes(Number(body.tax_rate)))throw Error('Choose Non-VAT (0%) or VAT (16%).');
      const taxRate = explicitTax ? Number(body.tax_rate) : configuredSettings.tax_rate_confirmed===true &&
        Number.isFinite(configuredRate) && configuredRate>0 && configuredRate<=100 ? configuredRate : 0;
      let verifiedMpesa = null;
      if (body.payment_method === 'mpesa') {
        // Never allow cashier taps or an STK acceptance to mark M-Pesa paid.
        // Independently recheck the provider before reducing stock or saving a sale.
        verifiedMpesa = await getVerifiedSwiftaStatus({
          checkoutId: body.swifta_checkout_id,
          attemptId: body.swifta_attempt_id,
          orderId: order.id,
          amountCents: order.total_cents,
          shopId: window.OraforgeShops?.activeShopId() || btype
        });
        if (verifiedMpesa.status !== 'success') {
          throw new Error('M-Pesa is not verified yet. Complete the prompt and wait for automatic confirmation.');
        }
      }
      if (body.generate_etims) {
        const buyer=window.OraforgeEtimsCore.customer(body.etims_customer || {});
        if(!buyer.pin || !buyer.name) throw Error('Buyer KRA PIN and name are required.');
        window.OraforgeEtims.enrich(order,products);
        order.etims_registration_details=body.etims_registration_details || {};
      }
      if (order.status !== 'paid') {
        for (const oi of order.items || []) {
          const product = products.find(p => p.id === oi.menu_item_id);
          if (tracksStock(product)) product.stock_qty = Math.max(0, Number(product.stock_qty || 0) - Number(oi.qty || 0));
        }
      }
      // Item prices are tax-inclusive. Tax only exists if the owner explicitly
      // selected a non-zero rate; it never increases the charged total.
      order.tax_rate = taxRate;
      order.tax_treatment = taxRate>0?'vat':'non_vat';
      order.tax_inclusive = true;
      order.tax_cents = taxRate > 0
        ? Math.round(Number(order.total_cents || 0) * taxRate / (100 + taxRate))
        : 0;
      order.status = 'paid';
      order.payment_method = body.payment_method || 'cash';
      order.payment_ref = verifiedMpesa?.payment_ref || body.payment_ref || (order.payment_method === 'cash' ? 'CASH' : `TXN-${Date.now()}`);
      order.paid_cents = order.total_cents;
      order.paid_at = Math.floor(Date.now() / 1000);
      order.updated_at = order.paid_at;
      order.customer_phone = String(body.customer_phone || '').trim();
      if (body.generate_etims) {
        order.etims_requested = true;
        order.etims_customer = window.OraforgeEtimsCore.customer(body.etims_customer || {});
        // These optional details belong to the buyer, not necessarily the
        // M-Pesa payer. Preserve independently from the STK payment phone.
        if (order.etims_customer.name) order.customer_name = order.etims_customer.name;
        if (order.etims_customer.phone) order.customer_phone = order.etims_customer.phone;
        if (order.etims_customer.pin) order.customer_kra_pin = order.etims_customer.pin;
        if (order.etims_customer.email) order.customer_email = order.etims_customer.email;
        if (order.etims_customer.billing_address) order.customer_billing_address = order.etims_customer.billing_address;
        if (order.etims_customer.remarks) order.customer_remarks = order.etims_customer.remarks;
        order.etims_shop_id = body.etims_shop_id;
        order.etims_seller_pin = configuredSettings.kra_pin || '';
      }
      const phone = order.customer_phone;
      if (phone && !customers.some(c => String(c.phone || '').replace(/\D/g, '') === phone.replace(/\D/g, ''))) {
        customers.push({ id: this.nextId(customers), name: order.customer_name || phone, phone, email: '', notes: '' });
      }
      await this.saveOrders(orders, btype);
      await this.setShop('items', products, btype);
      await this.setShop('customers', customers, btype);
      window.OraforgeAutoBackup?.check();
      if (typeof fetch === 'function') {
        const activeShop = window.OraforgeShops?.activeShopId() || btype || 'retail';
        fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Oraforge-Shop': activeShop },
          body: JSON.stringify({ ...order, shop_id: activeShop })
        }).catch(e => console.warn('Cloud sync deferred:', e));
      }
      return order;
    }

    if (cleanPath === '/api/orders' && method === 'GET') {
      let orders = [];
      const shopScope = window.OraforgeShops?.activeShopId() || btype || 'retail';

      // 1. Try fetching live orders from Supabase cloud API first
      if (typeof fetch === 'function') {
        try {
          const cloudUrl = '/api/orders?status=' + encodeURIComponent(url.searchParams.get('status') || '') +
            '&shop_id=' + encodeURIComponent(shopScope) + '&limit=300';
          const res = await fetch(cloudUrl, {
            headers: { 'X-Oraforge-Shop': shopScope },
            cache: 'no-store'
          });
          if (res.ok) {
            const cloudOrders = await res.json();
            if (Array.isArray(cloudOrders) && cloudOrders.length > 0) {
              orders = cloudOrders;
              await this.setShop('orders', orders, btype);
            }
          }
        } catch (_) {}
      }

      // 2. If cloud didn't return orders, read from local IndexedDB
      if (!orders || orders.length === 0) {
        orders = await this.getShop('orders', [], btype);
      }

      // 3. Fallback to catalog if local is still completely empty
      if (!orders || orders.length === 0) {
        try {
          const res = await fetch('/buildmart_catalog.json');
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.orders) && data.orders.length > 0) {
              orders = data.orders;
              await this.setShop('orders', orders, btype);
            }
          }
        } catch (_) {}
      }

      const status = url.searchParams.get('status');
      let rows = status ? orders.filter(o => o.status === status) : orders;
      rows = [...rows].sort((a, b) => parseOrderDate(b).getTime() - parseOrderDate(a).getTime());
      return window.OraforgeEtims ? window.OraforgeEtims.attach(rows) : rows;
    }

    if (cleanPath === '/api/order' && method === 'GET') {
      const orderId = Number(url.searchParams.get('id'));
      let order = null;
      const orders = await this.getShop('orders', [], btype);
      if (Array.isArray(orders)) order = orders.find(o => o.id === orderId);

      if (!order && typeof fetch === 'function') {
        try {
          const res = await fetch(`/api/order?id=${orderId}`, { cache: 'no-store' });
          if (res.ok) order = await res.json();
        } catch (_) {}
      }

      return order && window.OraforgeEtims ? (await window.OraforgeEtims.attach([order]))[0] : order || {};
    }

    if (cleanPath === '/api/payments') {
      const q = (url.searchParams.get('q') || '').toLowerCase();
      const orders = (await this.getShop('orders', [], btype)).filter(o => o.status === 'open' || o.status === 'sent');
      return q ? orders.filter(o => `${o.ticket_no} ${o.customer_name} ${o.employee_name}`.toLowerCase().includes(q)) : orders;
    }

    if (cleanPath === '/api/suppliers') {
      let suppliers = await this.getShop('suppliers', [], btype);
      if (!suppliers || suppliers.length === 0) {
        try {
          const res = await fetch('/buildmart_catalog.json');
          if (res.ok) {
            const data = await res.json();
            if (Array.isArray(data.suppliers) && data.suppliers.length > 0) {
              suppliers = data.suppliers;
              await this.setShop('suppliers', suppliers, btype);
            }
          }
        } catch (_) {}
      }
      return suppliers;
    }
    if (cleanPath === '/api/customers') return await this.getShop('customers', [], btype);

    if (cleanPath === '/api/admin/supplier' && method === 'POST') {
      const suppliers = await this.getShop('suppliers', [], btype);
      let supplier = body.id ? suppliers.find(s => s.id === Number(body.id)) : null;
      if (!supplier) {
        supplier = { id: this.nextId(suppliers) };
        suppliers.push(supplier);
      }
      Object.assign(supplier, { name: body.name || supplier.name || 'Supplier', phone: body.phone || '', email: body.email || '', active: Number(body.active ?? 1) });
      await this.setShop('suppliers', suppliers, btype);
      return supplier;
    }

    if (cleanPath === '/api/supplier/detail') {
      const suppliers = await this.getShop('suppliers', [], btype);
      const products = await this.getShop('items', [], btype);
      const supplier = suppliers.find(s => s.id === Number(url.searchParams.get('id')));
      if (!supplier) throw new Error('Supplier not found');
      return { ...supplier, total_purchases: 0, products: products.filter(p => Number(p.supplier_id || 0) === supplier.id) };
    }

    if (cleanPath === '/api/menu/category' && method === 'POST') {
      const categories = await this.getShop('categories', [], btype);
      const id = Number(body.id), existing = categories.find(c => c.id === id);
      if (body.id && !existing) throw new Error('Category not found.');
      if (body.action === 'delete') {
        if (!existing) throw new Error('Category not found.');
        const items = await this.getShop('items', [], btype);
        if (items.some(i => Number(i.category_id) === id)) throw new Error('Move products to another category before deleting this category.');
        categories.splice(categories.indexOf(existing), 1);
      } else {
        const name = String(body.name || '').trim();
        if (!name || name.length > 80) throw new Error('Enter a category name of 1–80 characters.');
        if (categories.some(c => c.id !== id && c.name.trim().toLowerCase() === name.toLowerCase())) throw new Error('That category already exists.');
        if (existing) Object.assign(existing, {name, custom:true});
        else categories.push({id:this.nextId(categories), name, custom:true});
      }
      await this.setShop('categories', categories, btype);
      return {categories};
    }

    if (cleanPath === '/api/settings' && method === 'POST') {
      const current = await this.getShop('settings', {}, btype);
      const settings = { ...current, ...body, business_type: btype };
      if (Object.prototype.hasOwnProperty.call(body, 'tax_rate')) {
        const rate = Number(body.tax_rate);
        if (!Number.isFinite(rate) || rate < 0 || rate > 100) {
          throw new Error('VAT rate must be between 0% and 100%.');
        }
        settings.tax_rate = rate;
        settings.tax_rate_confirmed = true; // Only an owner's saved selection authorizes VAT.
      }
      await this.setShop('settings', settings, btype);
      return { settings, profile: prof, capabilities: prof.capabilities || {} };
    }

    if (cleanPath === '/api/seed-samples' && method === 'POST') {
      throw new Error('Sample catalogue replacement is disabled.');
      return { ok: true, menu: { categories: await this.getShop('categories', [], btype), items: await this.getShop('items', [], btype) } };
    }

    if (cleanPath === '/api/menu/item' && method === 'POST') {
      const categories = await this.getShop('categories', [], btype);
      const items = await this.getShop('items', [], btype);
      let item = body.id ? items.find(i => i.id === Number(body.id)) : null;
      if (window.OraforgeCatalogIntegrity?.assertUnique) {
        window.OraforgeCatalogIntegrity.assertUnique(items, {
          active: Number(body.active ?? item?.active ?? 1),
          name: body.name || item?.name || 'Product',
          sku: body.sku ?? item?.sku ?? '',
          barcode: body.barcode ?? item?.barcode ?? ''
        }, item?.id ?? null);
      }
      if (!item) {
        item = { id: this.nextId(items), active: 1 };
        items.push(item);
      }
      Object.assign(item, {
        category_id: Number(body.category_id || item.category_id || 1),
        name: body.name || item.name || 'Product',
        sku: body.sku || '', barcode: body.barcode || '', unit: body.unit || 'pcs',
        stock_qty: Number(body.stock_qty ?? item.stock_qty ?? 0),
        reorder_level: Number(body.reorder_level ?? item.reorder_level ?? 5),
        cost_cents: Math.round(Number(body.cost || 0) * 100),
        price_cents: Math.round(Number(body.price || 0) * 100),
        wholesale_price_cents: Math.round(Number(body.wholesale_price || 0) * 100),
        batch_no: body.batch_no || '', expiry_date: body.expiry_date || '',
        manufacturer: body.manufacturer || '', strength: body.strength || '',
        variants_json: body.variants_json || '', decimal_qty_enabled: body.decimal_qty_enabled ? 1 : 0,
        image_url: body.image_base64 || body.image_url || item.image_url || '', color: body.color || item.color || '#334155'
      });
      await this.setShop('items', items, btype);
      return { categories, items };
    }

    if (cleanPath === '/api/menu/item' && method === 'DELETE') {
      const id = Number(url.searchParams.get('id'));
      const orders = await this.getShop('orders', [], btype);
      if (orders.some(o => (o.items || []).some(i => i.menu_item_id === id))) return { error: 'Cannot delete product with sales history.' };
      const categories = await this.getShop('categories', [], btype);
      const items = (await this.getShop('items', [], btype)).filter(i => i.id !== id);
      await this.setShop('items', items, btype);
      return { categories, items };
    }

    if (cleanPath === '/api/stock') return (await this.getShop('items', [], btype)).filter(tracksStock);
    if (cleanPath === '/api/stock/adjust' && method === 'POST') {
      const items = await this.getShop('items', [], btype);
      const item = items.find(i => i.id === Number(body.product_id));
      if (!item) throw new Error('Product not found');
      item.stock_qty = Math.max(0, Number(item.stock_qty || 0) + Number(body.qty_change || 0));
      await this.setShop('items', items, btype);
      return { ok: true, item };
    }

    if (cleanPath === '/api/reports') {
      const period = url.searchParams.get('period') || 'today';
      const now = new Date();
      let start = new Date(now);
      if (period === 'yesterday') { start.setDate(start.getDate() - 1); start.setHours(0,0,0,0); }
      else if (period === 'week') { start.setDate(start.getDate() - 6); start.setHours(0,0,0,0); }
      else if (period === 'month') { start.setDate(start.getDate() - 29); start.setHours(0,0,0,0); }
      else start.setHours(0,0,0,0);
      let end = now;
      if (period === 'yesterday') { end = new Date(start); end.setDate(end.getDate() + 1); }
      const startTs = Math.floor(start.getTime()/1000), endTs = Math.floor(end.getTime()/1000) + 1;
      const orders = (await this.getShop('orders', [], btype)).filter(o => o.status === 'paid' && Number(o.paid_at || o.updated_at || 0) >= startTs && Number(o.paid_at || o.updated_at || 0) < endTs);
      const products = await this.getShop('items', [], btype);
      let sales = 0, costs = 0;
      const paymentMap = new Map(), top = new Map();
      for (const o of orders) {
        sales += Number(o.total_cents || 0);
        const pm = o.payment_method || 'cash';
        paymentMap.set(pm, (paymentMap.get(pm) || 0) + Number(o.total_cents || 0));
        for (const it of o.items || []) {
          costs += Number(it.cost_cents || 0) * Number(it.qty || 0);
          const cur = top.get(it.menu_item_id) || { name: it.name, qty: 0, sales: 0, current_stock: 0 };
          cur.qty += Number(it.qty || 0); cur.sales += Number(it.line_total_cents || 0);
          cur.current_stock = Number(products.find(p => p.id === it.menu_item_id)?.stock_qty || 0);
          top.set(it.menu_item_id, cur);
        }
      }
      const inventoryValue = products.filter(tracksStock).reduce((s,p) => s + Number(p.stock_qty || 0) * Number(p.cost_cents || 0), 0);
      const potentialProfit = products.filter(tracksStock).reduce((s,p) => s + Number(p.stock_qty || 0) * Math.max(0, Number(p.price_cents || 0) - Number(p.cost_cents || 0)), 0);
      return {
        totals: { sales, costs, orders: orders.length },
        payments: [...paymentMap.entries()].map(([method, amount]) => ({ method, amount, transactions: orders.filter(o => (o.payment_method || 'cash') === method).length })),
        top_items: [...top.values()].sort((a,b) => b.sales - a.sales).slice(0, 15),
        stock: { inventory_value: inventoryValue, potential_profit: potentialProfit },
        period,
        range: { start: startTs, end: endTs, label: period === 'today' ? 'Today' : period === 'yesterday' ? 'Yesterday' : period === 'week' ? 'Last 7 days' : 'Last 30 days' }
      };
    }

    throw new Error(`Offline feature not implemented yet: ${cleanPath}`);
  }
};

async function api(path, options = {}) {
  const cloudOnly = CLOUD_ONLY_PATHS.some(prefix => path.startsWith(prefix));
  if (cloudOnly) {
    if (!navigator.onLine) throw new Error('This feature needs an internet connection.');
    const init = { headers: { 'Content-Type': 'application/json' }, credentials: 'include', ...options };
    if (init.body && typeof init.body !== 'string') init.body = JSON.stringify(init.body);
    const res = await fetch(CLOUD_API_BASE + path, init);
    let payload = {};
    try { payload = await res.json(); } catch (_) {}
    if (!res.ok) throw new Error(payload.error || payload.message || `Online service failed (${res.status})`);
    return payload;
  }
  return LocalPOS.handle(path, options);
}


async function bootstrap() {
  if (window.OraforgeCatalogIntegrityReady) await window.OraforgeCatalogIntegrityReady;
  const data = await api('/api/bootstrap');
  state.user = data.user;
  state.settings = data.settings || {};
  state.profile = data.profile || {};
  state.profiles = data.profiles || {};
  state.capabilities = data.capabilities || {};
  state.tables = data.tables || [];
  state.alerts = data.alerts || { expiry: 0, low_stock: 0 };
  state.employees = data.employees || [];
  state.selectedEmployeeId = Number(localStorage.getItem('pos_employee_id')) || state.employees[0]?.id || null;
  state.categories = data.menu ? data.menu.categories : [];
  state.items = data.menu ? data.menu.items : [];
  state.activeCategory = 'all';

  updateHeaderAndNav();
}

function pageName() {
  return qs('[data-page]')?.dataset.page;
}

function renderShellError(err) {
  const root = qs('[data-page]');
  if (root) root.innerHTML = `<section class="empty">Could not load page. ${err.message}</section>`;
}

// ── Audio Feedback Synthesizer ───────────────────────────────────────────────
function playBeep(type = 'success') {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    if (type === 'success') {
      // Crisp two-tone register chime
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      osc.frequency.setValueAtTime(1174.66, ctx.currentTime + 0.05);
      gain.gain.setValueAtTime(0.2, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
      osc.start();
      osc.stop(ctx.currentTime + 0.16);
    } else {
      // Low buzz for error or not found
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(220, ctx.currentTime);
      gain.gain.setValueAtTime(0.25, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.22);
      osc.start();
      osc.stop(ctx.currentTime + 0.22);
    }
  } catch (e) {
    // AudioContext may be restricted until user gesture
  }
}

// ── Unified Barcode Scanner Modal ────────────────────────────────────────────
function showBarcodeModal(mode = 'pos', onScan = null) {
  const isPos = (mode === 'pos');
  const title = isPos ? 'Scan Barcode to Add to Cart' : 'Scan Barcode for Product';
  const subtitle = isPos 
    ? 'Scan physical barcode with camera or handheld USB reader to immediately add to order'
    : 'Scan a barcode to populate product details or lookup existing items';

  // Sample barcoded items from current catalog for quick 1-click test
  const sampleItems = (state.items || []).filter(i => i.barcode).slice(0, 5);

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="width:480px; max-width:92vw; max-height:92vh; overflow-y:auto;">
      <div class="modal-head" style="padding:16px 20px; border-bottom:1px solid var(--line); display:flex; align-items:center; justify-content:space-between;">
        <div style="display:flex; align-items:center; gap:10px;">
          <span style="font-size:24px;">📷</span>
          <div>
            <h3 style="margin:0; font-size:16px; font-weight:800; color:var(--ink);">${title}</h3>
            <span style="font-size:12px; color:var(--muted);">${subtitle}</span>
          </div>
        </div>
        <button class="modal-close" id="bmClose" type="button">&times;</button>
      </div>

      <div style="padding:18px 20px;">
        <!-- Camera Viewfinder -->
        <div class="scanner-viewfinder" id="scannerViewfinder">
          <video class="scanner-video" id="scannerVideo" playsinline muted autoplay></video>
          <div class="scanner-reticle"></div>
          <div class="scanner-laser"></div>
          <div id="cameraStatusText" style="position:absolute; bottom:10px; left:0; right:0; text-align:center; font-size:11px; color:#a1a1aa; z-index:6; background:rgba(0,0,0,0.6); padding:3px 8px;">
            Initializing camera…
          </div>
        </div>

        <!-- Manual or USB Scanner Input -->
        <div style="margin-bottom:12px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:6px;">
            <label style="font-size:12px; font-weight:700; color:var(--ink); text-transform:uppercase; letter-spacing:0.5px;">Barcode / SKU Input</label>
            <span style="font-size:11px; color:var(--muted);">USB scanner ready</span>
          </div>
          <div style="display:flex; gap:8px;">
            <input type="text" id="barcodeManualInput" class="field" placeholder="Enter / scan barcode here…" autocomplete="off" autofocus style="flex:1; font-size:15px; font-family:monospace; font-weight:700; text-align:center; letter-spacing:1px;">
            <button type="button" class="primary" id="barcodeSubmitBtn" style="padding:8px 16px; font-size:13px; font-weight:700; white-space:nowrap;">
              ${isPos ? '+ Add to Cart' : 'Lookup / Add'}
            </button>
          </div>
        </div>

        <!-- Scan Feedback Notification Box -->
        <div id="scannerFeedback" style="min-height:48px; border-radius:8px; border:1px solid var(--line); background:var(--bg); padding:10px 14px; margin-bottom:14px; display:flex; align-items:center; justify-content:space-between; transition:all 0.2s;">
          <div style="font-size:12.5px; color:var(--muted); line-height:1.4;" id="feedbackMsg">
            Ready to scan. Point camera or press Enter after scanning barcode.
          </div>
        </div>

        ${sampleItems.length ? `
          <!-- Quick-test Sample Barcodes from Catalog -->
          <div style="border-top:1px dashed var(--line); padding-top:12px; margin-bottom:14px;">
            <div style="font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">
              ⚡ Quick Test Barcodes (Click to simulate scan):
            </div>
            <div style="display:flex; flex-wrap:wrap; gap:6px;">
              ${sampleItems.map(item => `
                <button type="button" class="quick-barcode-pill" data-code="${item.barcode}" title="${item.name} (${money(item.price_cents)})">
                  <strong>${item.barcode}</strong>
                  <span>${item.name}</span>
                </button>
              `).join('')}
            </div>
          </div>
        ` : ''}

        <!-- Footer actions -->
        <div style="display:flex; align-items:center; justify-content:space-between; border-top:1px solid var(--line); padding-top:14px;">
          <div style="font-size:12px; font-weight:600; color:var(--muted);">
            ${isPos ? `Cart items: <strong id="scannerCartCount">${state.order?.items?.length || 0}</strong>` : ''}
          </div>
          <button type="button" class="primary" id="bmDoneBtn" style="padding:9px 20px; font-size:13px;">
            ${isPos ? '✓ Done / Return to Cart' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);

  const videoElem = overlay.querySelector('#scannerVideo');
  const cameraStatus = overlay.querySelector('#cameraStatusText');
  const manualInput = overlay.querySelector('#barcodeManualInput');
  const submitBtn = overlay.querySelector('#barcodeSubmitBtn');
  const feedbackMsg = overlay.querySelector('#feedbackMsg');
  const feedbackBox = overlay.querySelector('#scannerFeedback');
  const cartCountElem = overlay.querySelector('#scannerCartCount');

  manualInput.focus();

  let stream = null;
  let detector = null;
  let scanActive = true;
  let lastScannedCode = '';
  let lastScannedTime = 0;

  // Cleanup handler
  const closeModal = () => {
    scanActive = false;
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    overlay.remove();
  };

  overlay.querySelector('#bmClose').addEventListener('click', closeModal);
  overlay.querySelector('#bmDoneBtn').addEventListener('click', closeModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) closeModal(); });

  // Start Camera Stream & Detection
  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
    }).then(s => {
      stream = s;
      if (videoElem) {
        videoElem.srcObject = stream;
        videoElem.play().catch(() => {});
        cameraStatus.textContent = 'Camera active — hold barcode in box';
      }

      if ('BarcodeDetector' in window) {
        try {
          detector = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
          const detectLoop = async () => {
            if (!scanActive) return;
            if (videoElem.readyState >= 2) {
              try {
                const barcodes = await detector.detect(videoElem);
                if (barcodes && barcodes.length > 0) {
                  const rawCode = barcodes[0].rawValue;
                  const now = Date.now();
                  // Debounce: prevent same code scanning repeatedly in 1.5s
                  if (rawCode !== lastScannedCode || (now - lastScannedTime) > 1500) {
                    lastScannedCode = rawCode;
                    lastScannedTime = now;
                    handleCodeScanned(rawCode);
                  }
                }
              } catch (e) {}
            }
            if (scanActive) requestAnimationFrame(detectLoop);
          };
          requestAnimationFrame(detectLoop);
        } catch (e) {
          cameraStatus.textContent = 'Hold barcode in box or scan with USB gun';
        }
      } else {
        cameraStatus.textContent = 'Video on. Use handheld scanner or type barcode below';
      }
    }).catch(err => {
      if (cameraStatus) cameraStatus.textContent = 'Camera unavailable — use handheld reader or input below';
    });
  } else {
    if (cameraStatus) cameraStatus.textContent = 'Use handheld reader or type barcode below';
  }

  // Core Barcode Processor
  const handleCodeScanned = async (code) => {
    const q = (code || '').trim().toLowerCase();
    if (!q) return;

    manualInput.value = code;

    // Custom onScan callback (used e.g. in Add Product modal barcode input)
    if (typeof onScan === 'function') {
      playBeep('success');
      onScan(code);
      closeModal();
      return;
    }

    // Match against state.items
    const match = (state.items || []).find(i =>
      (i.barcode && i.barcode.trim().toLowerCase() === q) ||
      (i.sku && i.sku.trim().toLowerCase() === q)
    );

    if (isPos) {
      if (match) {
        // In system: Add to cart
        if (hasCap('variants') && match.variants_json) {
          closeModal();
          showVariantModal(match);
          return;
        }

        const existing = state.order?.items?.find(i => i.menu_item_id === match.id);
        const existingQty = existing ? existing.qty : 0;
        if (tracksStock(match) && (1 + existingQty) > match.stock_qty) {
          playBeep('error');
          feedbackBox.style.background = 'rgba(239, 68, 68, 0.15)';
          feedbackBox.style.borderColor = 'var(--danger)';
          feedbackMsg.innerHTML = `<span style="color:var(--danger); font-weight:700;">⚠️ Cannot add "${match.name}". Stock limit reached (${match.stock_qty} in stock).</span>`;
          return;
        }

        await addItemWithQty(match.id, 1);
        playBeep('success');

        feedbackBox.style.background = 'rgba(22, 163, 74, 0.15)';
        feedbackBox.style.borderColor = 'var(--ok)';
        feedbackMsg.innerHTML = `
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:18px;">✅</span>
            <div>
              <strong style="color:var(--ok); font-size:13px;">Added to cart: ${match.name}</strong>
              <div style="font-size:11px; color:var(--ink);">${money(match.price_cents)} • Barcode: ${match.barcode || match.sku}</div>
            </div>
          </div>
        `;

        if (cartCountElem) {
          cartCountElem.textContent = state.order?.items?.length || 0;
        }

        manualInput.value = '';
        manualInput.focus();
      } else {
        // Not in system
        playBeep('error');
        feedbackBox.style.background = 'rgba(245, 158, 11, 0.15)';
        feedbackBox.style.borderColor = 'var(--warn)';
        feedbackMsg.innerHTML = `
          <div>
            <div style="color:var(--warn); font-weight:700; font-size:13px;">⚠️ Barcode "${code}" not found in system!</div>
            <div style="font-size:11px; color:var(--muted); margin-top:2px;">Item is not registered in this shop catalog.</div>
          </div>
          <button type="button" class="btn-xs" id="registerMissingProductBtn" style="white-space:nowrap; background:var(--ink); color:var(--panel);">+ Register Product</button>
        `;

        feedbackBox.querySelector('#registerMissingProductBtn')?.addEventListener('click', () => {
          closeModal();
          location.href = '/products';
          setTimeout(() => {
            showProductModal({ barcode: code, sku: 'SKU-' + code.slice(-6) });
          }, 300);
        });
      }
    } else {
      // Product Page Mode
      if (match) {
        playBeep('success');
        feedbackBox.style.background = 'rgba(37, 99, 235, 0.15)';
        feedbackBox.style.borderColor = 'var(--info)';
        feedbackMsg.innerHTML = `
          <div>
            <div style="color:var(--info); font-weight:700; font-size:13px;">✓ Product Already Registered</div>
            <div style="font-size:11px; color:var(--ink); margin-top:2px;"><strong>${match.name}</strong> • SKU: ${match.sku} • ${money(match.price_cents)}</div>
          </div>
          <button type="button" class="btn-xs" id="editFoundProductBtn" style="white-space:nowrap; background:var(--primary); color:var(--primary-fg);">✏️ Edit Product</button>
        `;
        feedbackBox.querySelector('#editFoundProductBtn')?.addEventListener('click', () => {
          closeModal();
          showProductModal(match);
        });
      } else {
        // New Barcode detected -> open Add Product modal with barcode pre-filled
        playBeep('success');
        toast(`New barcode "${code}" detected. Opening product form…`, 'info');
        closeModal();
        showProductModal({ barcode: code, sku: 'SKU-' + (code.length > 6 ? code.slice(-6) : code) });
      }
    }
  };

  // Submit on manual input or USB scanner enter
  submitBtn.addEventListener('click', () => {
    handleCodeScanned(manualInput.value.trim());
  });

  manualInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleCodeScanned(manualInput.value.trim());
    }
  });

  // Sample barcode pills click
  overlay.querySelectorAll('.quick-barcode-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      handleCodeScanned(btn.dataset.code);
    });
  });
}

// ── POS Layout ────────────────────────────────────────────────────────────────
function posLayout() {
  const root = qs('[data-page="pos"]');
  document.body.classList.remove('mobile-cart-open');
  const itemLabel = state.profile?.item_label || 'Products';
  const orderTypes = (state.profile?.order_types && state.profile.order_types.length)
    ? state.profile.order_types
    : state.profile?.id === 'garage'
      ? state.capabilities.order_types
      : ['walk-in', 'quote', 'layaway'];

  root.innerHTML = `
    <div class="mobile-cart-backdrop" id="mobileCartBackdrop" aria-hidden="true"></div>
    <section class="menu-side">
      <div class="pos-head mobile-pos-head">
        <div class="pos-title-block">
          <span class="pos-kicker">Quick sale</span>
          <h2>${itemLabel}</h2>
          <small>Tap a product to add it instantly</small>
        </div>
        <div class="pos-control-strip">
          <button type="button" class="secondary" id="customSaleItemBtn">Custom item</button>
          ${hasCap('wholesale_pricing') ? `<button type="button" id="tierToggleBtn" class="tier-toggle-btn ${state.pricingTier === 'wholesale' ? 'active' : ''}">${state.pricingTier === 'wholesale' ? '⚡ Wholesale' : '🏷️ Retail'}</button>` : ''}
          ${hasCap('tables') ? `<select id="tableSelect" class="field"><option value="">Table / Tab</option>${state.tables.map(t => `<option value="${t.id}" ${state.selectedTableId == t.id ? 'selected' : ''}>${t.name}</option>`).join('')}</select>` : ''}
          ${hasCap('waiters') ? `<select id="waiterSelect" class="field"><option value="">Staff / Waiter</option>${state.employees.map(e => `<option value="${e.id}" ${state.selectedEmployeeId == e.id ? 'selected' : ''}>${e.name}</option>`).join('')}</select>` : ''}
          <select id="orderType" class="field">${orderTypes.map(t => `<option value="${t}">${t.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</option>`).join('')}</select>
        </div>
      </div>
      <div class="sku-search-wrap mobile-search-row">
        <div class="sku-search-inner">
          <span class="sku-search-icon">&#128269;</span>
          <input class="sku-search-input" id="skuSearch" placeholder="${hasCap('barcode') ? 'Search name, SKU or scan barcode…' : 'Search by name or SKU…'}" autocomplete="off" autocorrect="off">
          <button class="sku-search-clear" id="skuClear" title="Clear">&#215;</button>
        </div>
        <button type="button" class="barcode-scan-btn" id="posBarcodeScanBtn" title="Scan Barcode"><span class="barcode-glyph">▥</span><span>Scan</span></button>
      </div>
      <div class="tabs" id="catTabs"></div>
      <div class="item-grid" id="itemGrid"></div>
    </section>
    <aside class="ticket-side mobile-ticket-drawer" id="mobileTicketDrawer">
      <div class="ticket-head">
        <div><h2>${hasCap('tables') ? 'Ticket / Tab' : 'Sale'}</h2><small>${state.profile?.name || 'POS'}</small></div>
        <div class="ticket-staff">${selectedEmployeeName() || state.user?.username || 'Staff'}</div>
        <button type="button" class="mobile-cart-close" id="mobileCartClose" aria-label="Close cart">×</button>
      </div>
      <div class="ticket-list" id="ticketList"></div>
      <div class="ticket-foot" id="ticketFoot"></div>
    </aside>
    <div class="mobile-cart-bar">
      <button type="button" class="mobile-cart-summary" id="mobileCartBar" aria-label="Open sale cart">
        <span class="mobile-cart-items"><span class="mobile-cart-icon">🛒</span><strong id="mobileCartCount">0</strong><span>items</span></span>
        <strong class="mobile-cart-total" id="mobileCartTotal">KES 0.00</strong>
        <span class="mobile-cart-action">View cart ↑</span>
      </button>
    </div>`;

  qs('#orderType')?.addEventListener('change', ensureOrder);
  qs('#tableSelect')?.addEventListener('change', e => {
    state.selectedTableId = e.target.value ? Number(e.target.value) : null;
    if (state.order) { state.order.table_id = state.selectedTableId; state.order.table_name = state.tables.find(t => t.id === state.selectedTableId)?.name || ''; renderTicket(); }
  });
  qs('#waiterSelect')?.addEventListener('change', e => {
    state.selectedEmployeeId = e.target.value ? Number(e.target.value) : null;
    if (state.order) { state.order.employee_id = state.selectedEmployeeId; state.order.employee_name = selectedEmployeeName(); renderTicket(); }
  });
  qs('#tierToggleBtn')?.addEventListener('click', () => {
    state.pricingTier = state.pricingTier === 'wholesale' ? 'retail' : 'wholesale';
    qs('#tierToggleBtn').classList.toggle('active', state.pricingTier === 'wholesale');
    qs('#tierToggleBtn').textContent = state.pricingTier === 'wholesale' ? '⚡ Wholesale' : '🏷️ Retail';
    renderItems();
  });
  qs('#posBarcodeScanBtn')?.addEventListener('click', () => showBarcodeModal('pos'));
  qs('#customSaleItemBtn')?.addEventListener('click',showCustomSaleItem);
  qs('#mobileCartBar')?.addEventListener('click', () => setMobileCartOpen(true));
  qs('#mobileCartBackdrop')?.addEventListener('click', () => setMobileCartOpen(false));
  qs('#mobileCartClose')?.addEventListener('click', () => setMobileCartOpen(false));

  const skuInput = qs('#skuSearch');
  skuInput.addEventListener('input', () => { state.searchQuery = skuInput.value.trim().toLowerCase(); renderItems(); });
  qs('#skuClear').addEventListener('click', () => { skuInput.value = ''; state.searchQuery = ''; renderItems(); skuInput.focus(); });
  skuInput.addEventListener('keydown', async e => {
    if (e.key !== 'Enter') return;
    const q = skuInput.value.trim().toLowerCase();
    if (!q) return;
    const match = (state.items || []).find(i => (i.barcode && i.barcode.trim().toLowerCase() === q) || (i.sku && i.sku.trim().toLowerCase() === q));
    if (!match) { playBeep('error'); toast(`Barcode / SKU "${skuInput.value.trim()}" not found`, 'error'); return; }
    if (hasCap('variants') && match.variants_json) showVariantModal(match);
    else await addItemWithQty(match.id, 1);
    playBeep('success'); skuInput.value = ''; state.searchQuery = ''; renderItems();
  });
  renderTabs(); renderItems(); renderTicket(); updateMobileCartBar();
}

function getCategoryIcon(name) {
  const zap = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-right:6px;vertical-align:-3px"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>`;
  const droplet = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-right:6px;vertical-align:-3px"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path></svg>`;
  const palette = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-right:6px;vertical-align:-3px"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10c2 0 3-1 3-2 0-.55-.22-1.05-.59-1.41-.36-.36-.59-.86-.59-1.41 0-1.1.9-2 2-2h1c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-4 8c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm4-4c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm4 4c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z"/></svg>`;
  const crosshair = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-right:6px;vertical-align:-3px"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="16"></line><line x1="8" y1="12" x2="16" y2="12"></line></svg>`;
  const wrench = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-right:6px;vertical-align:-3px"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path></svg>`;
  const shield = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-right:6px;vertical-align:-3px"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>`;
  const box = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-right:6px;vertical-align:-3px"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline><line x1="12" y1="22.08" x2="12" y2="12"></line></svg>`;
  
  const lower = name.toLowerCase();
  if (lower.includes('electric')) return zap;
  if (lower.includes('plumb')) return droplet;
  if (lower.includes('paint')) return palette;
  if (lower.includes('fastener')) return crosshair;
  if (lower.includes('tool')) return wrench;
  if (lower.includes('safet')) return shield;
  if (lower.includes('building') || lower.includes('material')) return box;
  if (lower === 'all') return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-right:6px;vertical-align:-3px"><rect x="3" y="3" width="7" height="7"></rect><rect x="14" y="3" width="7" height="7"></rect><rect x="14" y="14" width="7" height="7"></rect><rect x="3" y="14" width="7" height="7"></rect></svg>`;
  
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px;height:16px;margin-right:6px;vertical-align:-3px"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`;
}

function renderTabs() {
  const tabs = qs('#catTabs');
  if (!tabs) return;
  
  const allTab = `<button class="tab ${state.activeCategory === 'all' ? 'active' : ''}" data-cat="all">
    ${getCategoryIcon('All')} All
  </button>`;
  
  const catTabs = state.categories.map(cat =>
    `<button class="tab ${cat.id === state.activeCategory ? 'active' : ''}" data-cat="${cat.id}">
       ${getCategoryIcon(cat.name)} ${cat.name}
     </button>`
  ).join('');
  
  tabs.innerHTML = allTab + catTabs;
  
  qsa('.tab').forEach(btn => btn.addEventListener('click', () => {
    state.activeCategory = btn.dataset.cat === 'all' ? 'all' : Number(btn.dataset.cat);
    state.searchQuery = '';
    const inp = qs('#skuSearch');
    if (inp) inp.value = '';
    renderTabs();
    renderItems();
  }));
}

function renderItems() {
  const grid = qs('#itemGrid');
  if (!grid) return;
  let items = state.items;
  if (state.searchQuery) {
    const q = state.searchQuery;
    items = items.filter(i =>
      i.name.toLowerCase().includes(q) ||
      (i.sku && i.sku.toLowerCase().includes(q)) ||
      (i.barcode && i.barcode.toLowerCase().includes(q))
    );
  } else {
    if (state.activeCategory !== 'all') {
      items = items.filter(i => i.category_id === state.activeCategory);
    }
  }

  grid.innerHTML = items.map(item => {
    const low = tracksStock(item) && (item.reorder_level ? item.stock_qty <= item.reorder_level : item.stock_qty <= 5);
    const stockLabel = tracksStock(item)
      ? `<span class="stock-badge ${low ? '' : 'ok'}">${item.stock_qty} ${item.unit || 'pcs'}</span>`
      : '';
    const catName = state.categories.find(c => c.id === item.category_id)?.name || '';
    const effectivePrice = (state.pricingTier === 'wholesale' && item.wholesale_price_cents) ? item.wholesale_price_cents : item.price_cents;
    return `
      <button class="menu-btn" data-id="${item.id}">
        <div class="menu-btn-img-wrapper">
          ${item.image_url ? `<img src="${item.image_url}" style="width:100%;height:100%;object-fit:contain;padding:12px;box-sizing:border-box;">` : getCategoryIcon(catName)}
          ${stockLabel}
        </div>
        <div class="menu-btn-content">
          <strong>${item.name}</strong>
          ${item.strength ? `<div style="font-size:11px; color:#2563eb; font-weight:700;">${item.strength}</div>` : ''}
          ${item.sku ? `<div class="item-sku">SKU: ${item.sku}</div>` : ''}
          <div class="item-price">
            ${money(effectivePrice)}
            ${state.pricingTier === 'wholesale' && item.wholesale_price_cents ? '<span style="font-size:10px; color:#2563eb; font-weight:700; margin-left:4px;">(Wholesale)</span>' : ''}
          </div>
          <div class="menu-btn-stock-status ${low ? 'low' : ''}">
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>
            ${item.unit === 'service' ? 'Workshop Service' : low ? 'Low Stock' : 'In Stock'}
          </div>
        </div>
      </button>
    `;
  }).join('') || `<div class="empty">No products found</div>`;

  qsa('.menu-btn').forEach(btn => btn.addEventListener('click', async () => {
    const id = Number(btn.dataset.id);
    const item = state.items.find(i => i.id === id);
    if (!item) return;

    if (hasCap('variants') && item.variants_json) {
      showVariantModal(item);
      return;
    }

    const existing = state.order?.items?.find(i => i.menu_item_id === item.id && !(i.variant_info || ''));
    const existingQty = existing ? Number(existing.qty || 0) : 0;
    if (tracksStock(item) && (1 + existingQty) > Number(item.stock_qty)) {
      toast(`Cannot add item. Only ${item.stock_qty} left in stock (you have ${existingQty} in cart).`, 'error');
      return;
    }
    await addItemWithQty(item.id, 1, '', '', item.batch_no || '');
  }));
}

// ── Variant Selection Modal ───────────────────────────────────────────────────
function showVariantModal(item) {
  let variants = [];
  try {
    if (typeof item.variants_json === 'string') {
      variants = JSON.parse(item.variants_json);
    } else if (Array.isArray(item.variants_json)) {
      variants = item.variants_json;
    }
  } catch(e) {
    if (item.variants_json) {
      variants = item.variants_json.split(',').map(s => ({ name: s.trim() }));
    }
  }

  const overlay = document.createElement('div');
  overlay.className = 'qty-popup-overlay';
  overlay.innerHTML = `
    <div class="qty-popup" style="max-width: 460px; text-align: left;">
      <h3 style="margin-top:0">${item.name}</h3>
      <p style="color:var(--muted); font-size:13px; margin-bottom: 16px;">Select variant or shade to add to order:</p>
      
      <div class="variant-grid" style="display:grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap:10px; margin-bottom: 16px;">
        ${variants.map((v, idx) => {
          const vName = typeof v === 'object' ? v.name : v;
          const vPrice = typeof v === 'object' && v.price_cents ? money(v.price_cents) : '';
          const vStock = typeof v === 'object' && v.stock_qty !== undefined ? `${v.stock_qty} left` : '';
          return `
            <button type="button" class="variant-btn" data-idx="${idx}" style="padding:10px; border:2px solid var(--line); border-radius:8px; background:white; text-align:left; cursor:pointer; transition:all 0.15s;">
              <strong style="display:block; color:var(--ink); font-size:13px;">${vName}</strong>
              ${vPrice ? `<div style="color:var(--primary-dark); font-weight:700; font-size:12px; margin-top:2px;">${vPrice}</div>` : ''}
              ${vStock ? `<div style="color:var(--muted); font-size:11px;">${vStock}</div>` : ''}
            </button>
          `;
        }).join('')}
      </div>

      <div style="border-top:1px dashed var(--line); padding-top:12px; margin-bottom:16px;">
        <label style="font-size:12px; font-weight:600; color:var(--muted); display:block; margin-bottom:4px;">Or custom specification:</label>
        <input class="field" id="customVariantInput" placeholder="e.g. Size XL / Red / Shade 3" style="width:100%; padding:8px;">
      </div>

      <div class="qty-popup-actions">
        <button class="ghost" id="varCancel">Cancel</button>
        <button class="primary" id="varCustomConfirm">Add Specification</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#varCancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  overlay.querySelectorAll('.variant-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      const selected = variants[idx];
      const vName = typeof selected === 'object' ? selected.name : selected;
      const existing = state.order?.items?.find(i => i.menu_item_id === item.id && (i.variant_info || '') === (vName || ''));
      const existingQty = existing ? Number(existing.qty || 0) : 0;
      const variantStock = typeof selected === 'object' && selected.stock_qty !== undefined ? Number(selected.stock_qty) : Number(item.stock_qty);
      if (Number.isFinite(variantStock) && (1 + existingQty) > variantStock) {
        toast(`Cannot add ${vName}. Only ${variantStock} left in stock.`, 'error');
        return;
      }
      close();
      await addItemWithQty(item.id, 1, vName || '', '', item.batch_no || '');
    });
  });

  overlay.querySelector('#varCustomConfirm').addEventListener('click', async () => {
    const val = overlay.querySelector('#customVariantInput').value.trim();
    if (!val) {
      toast('Please enter or select a variant', 'error');
      return;
    }
    close();
    await addItemWithQty(item.id, 1, val, '', item.batch_no || '');
  });
}

// ── Qty Popup ─────────────────────────────────────────────────────────────────
function showQtyPopup(item, variantInfo = null, customPrice = null) {
  const isDecimal = Boolean(item.decimal_qty_enabled || hasCap('decimal_qty'));
  const step = isDecimal ? '0.01' : '1';
  const min = isDecimal ? '0.01' : '1';
  const unitPrice = customPrice !== null ? customPrice : (state.pricingTier === 'wholesale' && item.wholesale_price_cents ? item.wholesale_price_cents : item.price_cents);

  const overlay = document.createElement('div');
  overlay.className = 'qty-popup-overlay';
  overlay.innerHTML = `
    <div class="qty-popup" style="max-width:420px; text-align:left;">
      <h3 style="margin-top:0;">${item.name}</h3>
      ${variantInfo ? `<div style="background:#f1f5f9; padding:4px 8px; border-radius:6px; display:inline-block; font-size:12px; font-weight:700; color:var(--primary-dark); margin-bottom:8px;">Variant: ${variantInfo}</div>` : ''}
      <p style="margin:4px 0 12px; color:var(--muted); font-size:14px;">
        ${money(unitPrice)} per ${item.unit || 'pcs'} ${item.sku ? `· SKU: ${item.sku}` : ''}
        ${item.batch_no ? `<br><small>Batch: ${item.batch_no} ${item.expiry_date ? `(Exp: ${item.expiry_date})` : ''}</small>` : ''}
      </p>

      <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px;">Quantity (${item.unit || 'pcs'})</label>
      <div class="qty-popup-row" style="margin-bottom:12px;">
        <button class="qty-pop-btn" id="qtyDec">−</button>
        <input type="number" id="qtyVal" value="1" min="${min}" step="${step}" max="9999" inputmode="decimal">
        <button class="qty-pop-btn" id="qtyInc">+</button>
      </div>

      ${hasCap('order_notes') ? `
        <div style="margin-bottom:12px;">
          <label style="display:block; font-size:13px; font-weight:600; margin-bottom:4px;">Item Note / Instructions</label>
          <input type="text" class="field" id="itemNoteInput" placeholder="${state.profile?.id === 'garage' ? 'Vehicle reg, model, repair instructions...' : 'e.g. Well done, no ice, 2.5m cut, dosage note...'}" style="width:100%; padding:8px;" autocomplete="off">
        </div>
      ` : ''}

      <div class="qty-popup-actions">
        <button class="ghost" id="qtyCancel">Cancel</button>
        <button class="primary" id="qtyConfirm">Add to Sale</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const inp = overlay.querySelector('#qtyVal');
  inp.select();
  inp.focus();

  overlay.querySelector('#qtyDec').addEventListener('click', () => {
    const current = parseFloat(inp.value) || 1;
    const next = Math.max(isDecimal ? 0.1 : 1, current - 1);
    inp.value = isDecimal ? (Math.round(next * 100) / 100) : next;
  });
  overlay.querySelector('#qtyInc').addEventListener('click', () => {
    const current = parseFloat(inp.value) || 0;
    const next = current + 1;
    inp.value = isDecimal ? (Math.round(next * 100) / 100) : next;
  });
  overlay.querySelector('#qtyCancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  const confirm = async () => {
    const qty = parseFloat(inp.value) || 1;
    if (qty <= 0) {
      toast('Quantity must be greater than 0', 'error');
      return;
    }

    const note = overlay.querySelector('#itemNoteInput')?.value?.trim() || '';

    const existing = state.order?.items?.find(i => i.menu_item_id === item.id && (i.variant_info || '') === (variantInfo || ''));
    const existingQty = existing ? existing.qty : 0;

    if (tracksStock(item) && (qty + existingQty) > item.stock_qty) {
      toast(`Cannot add ${qty}. Only ${item.stock_qty} left in stock (you have ${existingQty} in cart).`, 'error');
      return;
    }

    overlay.remove();
    await addItemWithQty(item.id, qty, variantInfo || '', note, item.batch_no || '');
  };
  overlay.querySelector('#qtyConfirm').addEventListener('click', confirm);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); });
}

async function ensureOrder() {
  if (state.order && state.order.status === 'open') return state.order;
  const customerInput = qs('#customerName');
  const orderType = qs('#orderType')?.value || (state.profile?.order_types?.[0] || 'walk-in');
  const isQuote = orderType.toLowerCase().includes('quote') || orderType === 'quote';
  state.order = await api('/api/orders', {
    method: 'POST',
    body: {
      order_type: orderType,
      table_id: state.selectedTableId || null,
      employee_id: state.selectedEmployeeId,
      customer_name: customerInput?.value?.trim() || '',
      pricing_tier: state.pricingTier || 'retail',
      is_quote: isQuote ? 1 : 0,
      notes: qs('#orderNotes')?.value?.trim() || '',
    },
  });
  renderTicket();
  return state.order;
}

function showCustomSaleItem() {
  const overlay=document.createElement('div');overlay.className='qty-popup-overlay';
  overlay.innerHTML=`<form class="qty-popup"><h3>Custom sale item</h3><label>Product name *<input class="field" name="name" maxlength="160" required></label><label>Stable product reference (optional)<input class="field" name="sku" maxlength="120"></label><label>Quantity *<input class="field" name="qty" type="number" min="0.001" step="0.001" value="1" required></label><label>Unit selling price (KES) *<input class="field" name="price" type="number" min="0.01" step="0.01" required></label><label>Actual unit purchase cost (KES) *<input class="field" name="cost" type="number" min="0" step="0.01" required></label><p data-msg role="status"></p><div class="qty-popup-actions"><button type="button" data-cancel>Cancel</button><button class="primary">Add to sale</button></div></form>`;
  document.body.append(overlay);overlay.querySelector('[data-cancel]').onclick=()=>overlay.remove();
  overlay.querySelector('form').onsubmit=async event=>{
    event.preventDefault();const form=event.target,button=form.querySelector('.primary');button.disabled=true;
    try{
      const toCents=value=>{const n=Number(value)*100;if(Math.abs(n-Math.round(n))>0.000001)throw Error('Use at most two decimal places for money');return Math.round(n);};
      const order=await ensureOrder();state.order=await api('/api/order/add-manual',{method:'POST',body:{order_id:order.id,name:form.elements.name.value,sku:form.elements.sku.value,qty:Number(form.elements.qty.value),unit_price_cents:toCents(form.elements.price.value),cost_cents:toCents(form.elements.cost.value)}});
      overlay.remove();renderTicket();
    }catch(error){overlay.querySelector('[data-msg]').textContent=error.message;button.disabled=false;}
  };
}

async function addItemWithQty(menuItemId, qty, variantInfo = '', note = '', batchNo = '') {
  const order = await ensureOrder();
  state.order = await api('/api/order/add', {
    method: 'POST',
    body: {
      order_id: order.id,
      menu_item_id: menuItemId,
      qty,
      pricing_tier: state.pricingTier || 'retail',
      variant_info: variantInfo,
      note: note,
      batch_no: batchNo,
    },
  });
  renderTicket();
}

async function changeQty(itemId, qty) {
  if (state.order && state.order.items) {
    const existingItem = state.order.items.find(i => i.id === itemId);
    if (existingItem) {
      const catalogItem = state.items.find(i => i.id === existingItem.menu_item_id);
      if (tracksStock(catalogItem)) {
        if (qty > catalogItem.stock_qty) {
          toast(`Cannot increase. Only ${catalogItem.stock_qty} left in stock.`, 'error');
          return;
        }
      }
    }
  }
  
  state.order = await api('/api/order/qty', { method: 'POST', body: { item_id: itemId, qty } });
  renderTicket();
}

async function setStatus(status) {
  if (!state.order) return;
  state.order = await api('/api/order/status', {
    method: 'POST',
    body: { order_id: state.order.id, status },
  });
  renderTicket();
}

function setMobileCartOpen(open) {
  document.body.classList.toggle('mobile-cart-open', Boolean(open));
}

function updateMobileCartBar() {
  const bar = qs('#mobileCartBar');
  const countEl = qs('#mobileCartCount');
  const totalEl = qs('#mobileCartTotal');
  if (!bar || !countEl || !totalEl) return;
  const items = state.order?.items || [];
  const quantity = items.reduce((sum, item) => sum + Number(item.qty || 0), 0);
  countEl.textContent = Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  totalEl.textContent = money(state.order?.total_cents || 0);
  bar.classList.toggle('has-items', quantity > 0);
}

function renderTicket() {
  const list = qs('#ticketList');
  const foot = qs('#ticketFoot');
  if (!list || !foot) return;
  updateMobileCartBar();

  if (!state.order) {
    list.innerHTML = `<div class="empty">Add products to start a sale</div>`;
    foot.innerHTML = `
      <div class="customer-row">
        <input id="customerName" placeholder="Customer name (optional)" autocomplete="off">
      </div>
      <button class="primary" id="newTicket" style="width:100%">New Sale</button>
      <div class="totals"><div class="grand"><span>Total</span><span>KES 0.00</span></div></div>
    `;
    qs('#newTicket').addEventListener('click', ensureOrder);
    return;
  }

  const isQuote = Boolean(state.order.is_quote || state.order.order_type === 'quote');

  list.innerHTML = state.order.items.length
    ? state.order.items.map(item => {
      const dbItem = state.items.find(i => i.id === item.menu_item_id) || {};
      const catName = state.categories.find(c => c.id === dbItem.category_id)?.name || '';
      return `
      <div class="ticket-row">
        <div class="ticket-img">
          ${dbItem.image_url ? `<img src="${dbItem.image_url}" style="width:100%;height:100%;object-fit:contain;padding:4px;box-sizing:border-box;border-radius:7px;">` : getCategoryIcon(catName)}
        </div>
        <div class="ticket-info">
          <strong>${receiptEscape(item.name)}</strong>
          ${item.variant_info ? `<div style="font-size:11px; color:var(--ink); font-weight:700;">[${item.variant_info}]</div>` : ''}
          ${item.batch_no ? `<div style="font-size:11px; color:var(--muted);">Batch: ${item.batch_no}</div>` : ''}
          ${item.note ? `<div style="font-size:11px; color:#2563eb; font-style:italic;">* ${item.note}</div>` : ''}
          <small>SKU: ${dbItem.sku || '-'}</small>
          <div class="t-price">${money(item.unit_price_cents)}</div>
        </div>
        <div class="ticket-right">
          <div class="qty-controls">
            <button data-qty="${Math.max(0, (item.qty - 1))}" data-id="${item.id}">−</button>
            ${(dbItem.decimal_qty_enabled || hasCap('decimal_qty'))
              ? `<input type="number" class="cart-qty-input" data-id="${item.id}" value="${item.qty}" min="0.01" step="0.01" inputmode="decimal" style="width:64px;text-align:center;padding:4px;border:1px solid var(--line);border-radius:6px;background:var(--panel);color:var(--ink);font-weight:700;">`
              : `<strong>${item.qty}</strong>`}
            <button data-qty="${item.qty + 1}" data-id="${item.id}">+</button>
            <button class="remove-btn" data-qty="0" data-id="${item.id}">×</button>
          </div>
          <div class="t-total">${money(item.line_total_cents)}</div>
        </div>
      </div>
      `}).join('')
    : `<div class="empty">Add products to start a sale</div>`;

  qsa('.qty-controls button').forEach(btn =>
    btn.addEventListener('click', () => changeQty(Number(btn.dataset.id), Number(btn.dataset.qty)))
  );
  qsa('.cart-qty-input').forEach(input => {
    const applyQty = () => {
      const qty = Number.parseFloat(input.value);
      if (!Number.isFinite(qty) || qty <= 0) {
        toast('Enter a quantity greater than 0', 'error');
        renderTicket();
        return;
      }
      changeQty(Number(input.dataset.id), Math.round(qty * 100) / 100);
    };
    input.addEventListener('change', applyQty);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
    });
  });

  foot.innerHTML = `
    ${isQuote ? `<div class="quote-banner" style="background:#eff6ff; border:1px dashed #3b82f6; border-radius:8px; padding:8px; text-align:center; font-size:12px; font-weight:800; color:#1d4ed8; margin-bottom:10px;">📋 ESTIMATE / QUOTATION</div>` : ''}
    <div class="totals">
      <div><span>Receipt #</span><span>${state.order.ticket_no}</span></div>
      ${state.order.table_name ? `<div><span>Table / Tab</span><strong>${state.order.table_name}</strong></div>` : ''}
      <div><span>Type</span><span>${state.order.order_type}</span></div>
      ${state.order.pricing_tier === 'wholesale' ? `<div><span>Tier</span><span class="cap-pill" style="background:#e0e7ff; color:#3730a3; font-size:10px;">Wholesale</span></div>` : ''}
      <div><span>Served By</span><span>${state.order.employee_name || selectedEmployeeName() || '-'}</span></div>
      <div><span>Subtotal</span><span>${money(state.order.subtotal_cents)}</span></div>
      <div><span>Discount</span><span>−${money(state.order.discount_cents || 0)}</span></div>
      <button class="secondary" id="discountBtn">Apply / edit discount</button>
      <div class="grand"><span>Total</span><span>${money(state.order.total_cents)}</span></div>
    </div>
    <div class="actions" style="display:flex; flex-direction:column; gap:8px;">
      <div style="display:flex; gap:8px;">
        ${isQuote ? `
          <button class="primary" id="convertQuoteBtn" style="flex:1;">Convert to Sale</button>
          <button class="secondary" id="printQuoteBtn" style="flex:1;">Print Quote</button>
        ` : `
          <button class="primary" id="checkoutBtn" style="flex:1;">Checkout</button>
        `}
      </div>
      <div style="display:flex; gap:8px;">
        <button class="secondary" id="newTicket" style="flex:1;">New</button>
        <button class="danger" id="voidTicket" style="flex:1;">Void</button>
      </div>
    </div>
  `;

  qs('#discountBtn')?.addEventListener('click', showDiscountEditor);
  if (isQuote) {
    qs('#convertQuoteBtn')?.addEventListener('click', async () => {
      try {
        state.order = await api('/api/order/convert-quote', {
          method: 'POST',
          body: { order_id: state.order.id }
        });
        toast('Quotation converted to active sale!', 'success');
        renderTicket();
      } catch (err) {
        toast(err.message, 'error');
      }
    });
    qs('#printQuoteBtn')?.addEventListener('click', () => {
      showReceiptModal(state.order);
    });
  } else {
    qs('#checkoutBtn')?.addEventListener('click', () => showCheckoutModal(state.order));
  }

  qs('#newTicket')?.addEventListener('click', () => { state.order = null; renderTicket(); });
  qs('#voidTicket')?.addEventListener('click', async () => {
    await setStatus('cancelled');
    state.order = null;
    renderTicket();
  });
}

function selectedEmployeeName() {
  return state.employees.find(emp => emp.id === state.selectedEmployeeId)?.name;
}


function normalizeMpesaPhone(p) {
  let digits = String(p || '').replace(/\D/g, '');
  if (digits.startsWith('254') && digits.length === 12) return '+' + digits;
  if (digits.startsWith('0') && digits.length === 10) return '+254' + digits.slice(1);
  if ((digits.startsWith('7') || digits.startsWith('1')) && digits.length === 9) return '+254' + digits;
  if (p && String(p).trim().startsWith('+')) return String(p).trim();
  return digits ? ('+254' + digits) : '';
}

function formatMpesaDisplayPhone(p) {
  const norm = normalizeMpesaPhone(p);
  if (norm.startsWith('+254') && norm.length === 13) {
    return `+254 ${norm.slice(4, 7)} ${norm.slice(7, 10)} ${norm.slice(10)}`;
  }
  return norm || p;
}


async function getVerifiedSwiftaStatus({attemptId, checkoutId, orderId, amountCents, shopId}) {
  if (!checkoutId || !Number.isSafeInteger(Number(amountCents)) || Number(amountCents)<=0) return {status:'unknown'};
  let response;
  if (window.OraforgeNative) {
    if (!window.OraforgeProviders?.paymentStatus) throw new Error('Update the APK to enable verified M-Pesa receipts.');
    response = await window.OraforgeProviders.paymentStatus({reference:checkoutId});
  } else {
    if (!/^[a-f0-9]{32}$/.test(String(attemptId||''))) return {status:'unknown'};
    const result = await fetch('/api/swifta/status?attempt='+encodeURIComponent(attemptId), {cache:'no-store'});
    if (!result.ok) throw new Error('Unable to verify M-Pesa with the payment server.');
    response = await result.json();
  }
  if (response.status !== 'success') return {status:response.status||'pending'};
  const receipt=String(response.payment_ref||'').toUpperCase().trim();
  if(!/^[A-Z0-9]{8,30}$/.test(receipt)) return {status:'unknown'};
  if (response.checkout_id && response.checkout_id!==checkoutId) return {status:'unknown'};
  if (response.amount_cents!=null && Number(response.amount_cents)!==Number(amountCents)) return {status:'unknown'};
  if (response.order_id && String(response.order_id)!==String(orderId)) return {status:'unknown'};
  if (response.shop_id && response.shop_id!==shopId) return {status:'unknown'};
  return {status:'success',payment_ref:receipt};
}

async function triggerSwiftaMpesaCharge(params) {
  try {
    if (!Number.isSafeInteger(params.amount) || params.amount<=0) throw new Error('Payment amount must be greater than zero.');
    const phone = normalizeMpesaPhone(params.phone);
    const payload = {
      phone: phone.startsWith('+254') ? '0'+phone.slice(4) : phone,
      amount: params.amount / 100,
      accountReference: 'ORAFORGE-'+String(params.reference),
      description: 'POS payment',
      shop_id: String(window.OraforgeShops?.activeShopId() || localStorage.getItem('pos_active_business_type') || 'retail'),
      order_id: String(params.orderId)
    };
    if (window.OraforgeNative) return await window.OraforgeProviders.charge(payload);
    const response = await fetch('/api/swifta/stkpush', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
    const result = await response.json();
    if (!response.ok) return {status:false,message:result.message || 'Swifta request failed.'};
    return result;
  } catch(error) {
    return {status:false,message:error.message || 'Could not confirm STK submission. Check payment status before retrying.'};
  }
}

async function showCheckoutModal(order) {

  const overlay = document.createElement('div');
  overlay.className = 'qty-popup-overlay';
  overlay.addEventListener('click', e => { if (e.target === overlay && !checkoutBusy) { stopPaymentPoll(); overlay.remove(); } });

  let selectedMethod = 'mpesa';
  let checkoutBusy = false;
  let selectedTaxRate = state.settings.tax_rate_confirmed === true && Number(state.settings.tax_rate) === 16 ? 16 : 0;
  let savedPhone = order.customer_phone || '';
  const checkoutShop = window.OraforgeEtims?.scope();
  let etimsRegistrationDetails = {};
  let generateEtims = false, etimsCustomer = {name:order.etims_customer?.name || order.customer_name || '', phone:order.etims_customer?.phone || order.customer_phone || '',pin:order.customer_kra_pin || '', email:order.customer_email || '',billing_address:order.customer_billing_address || ''};
  let paymentPollTimer = null;
  let paymentPollGeneration = 0;
  function stopPaymentPoll() {
    paymentPollGeneration++;
    if(paymentPollTimer) clearTimeout(paymentPollTimer);
    paymentPollTimer = null;
  }

  function renderFormView() {
    overlay.innerHTML = `
      <div class="qty-popup" style="max-width: 420px; text-align: left;">
        <h3 style="margin-top:0">Checkout - ${order.ticket_no}</h3>
        <p style="font-size: 18px; font-weight: bold; margin-bottom: 20px;">Total: ${money(order.total_cents)}</p>
        
        <div style="margin-bottom: 16px;">
          <label style="display:block; margin-bottom: 8px; font-weight: 600;">Customer Phone <span style="font-weight:400;color:var(--muted)">(optional)</span></label>
          <input type="tel" id="checkoutCustomerPhone" class="field" placeholder="e.g. 0712345678" style="width: 100%; padding: 10px;" autocomplete="tel" value="${receiptEscape(savedPhone)}">
          <small style="display:block;margin-top:6px;color:var(--muted);">If entered, the number is saved to Customers after payment.</small>
        </div>

        <div style="margin-bottom: 16px;">
          <label style="display:block; margin-bottom: 8px; font-weight: 600;">Payment Method</label>
          <select id="checkoutMethod" class="field" style="width: 100%; padding: 10px;">
            <option value="mpesa" ${selectedMethod === 'mpesa' ? 'selected' : ''}>M-Pesa</option>
            <option value="cash" ${selectedMethod === 'cash' ? 'selected' : ''}>Cash</option>
          </select>
        </div>

        <div id="mpesaRefContainer" style="${selectedMethod === 'mpesa' ? 'display:block;' : 'display:none;'} margin-bottom: 16px;">
          <label style="display:block; margin-bottom: 8px; font-weight: 600;">M-Pesa / STK Phone</label>
          <input type="tel" id="mpesaRef" class="field" placeholder="e.g. 0712345678" style="width: 100%; padding: 10px;" autocomplete="tel" value="${receiptEscape(savedPhone)}">
          <small style="display:block;margin-top:4px;color:var(--muted);font-size:12px;">An STK push prompt will be sent to this phone to enter M-Pesa PIN.</small>
        </div>

        <div class="checkout-tax">
          <label for="checkoutTaxRate">Tax treatment</label>
          <select id="checkoutTaxRate" class="field">
            <option value="0" ${selectedTaxRate === 0 ? 'selected' : ''}>Non-VAT (0%)</option>
            <option value="16" ${selectedTaxRate === 16 ? 'selected' : ''}>VAT (16%, included in price)</option>
          </select>
          <small id="checkoutTaxSummary"></small>
        </div>
        ${window.OraforgeEtims?.checkoutMarkup() || ''}
        <p id="checkoutTaxNotice" class="checkout-tax-notice" role="status" hidden></p>

        <div id="checkoutMsg" role="status" aria-live="polite" aria-atomic="true" style="margin-top: 10px; font-weight: 600; font-size: 14px; text-align: center;"></div>

        <div class="qty-popup-actions" style="margin-top: 16px;">
          <button type="button" class="ghost" id="chkCancel">Cancel</button>
          <button type="button" class="primary" id="chkConfirm" style="${selectedMethod === 'mpesa' ? 'background:#16a34a;border-color:#16a34a;' : ''}">
            ${selectedMethod === 'mpesa' ? '⚡ Send STK Prompt' : 'Confirm & Print'}
          </button>
        </div>
      </div>
    `;

    const methodSelect = overlay.querySelector('#checkoutMethod');
    const refContainer = overlay.querySelector('#mpesaRefContainer');
    const refInput = overlay.querySelector('#mpesaRef');
    const customerPhoneInput = overlay.querySelector('#checkoutCustomerPhone');
    const confirmBtn = overlay.querySelector('#chkConfirm');
    const cancelBtn = overlay.querySelector('#chkCancel');
    const msgEl = overlay.querySelector('#checkoutMsg');

    const taxSelect = overlay.querySelector('#checkoutTaxRate');
    function updateTaxInfo() {
      const tax = selectedTaxRate ? Math.round(Number(order.total_cents)*selectedTaxRate/(100+selectedTaxRate)) : 0;
      overlay.querySelector('#checkoutTaxSummary').textContent = selectedTaxRate
        ? 'VAT included: '+money(tax)+' · Excl. VAT: '+money(order.total_cents-tax)+'. Total stays '+money(order.total_cents)+'.'
        : 'No VAT charged. Total: '+money(order.total_cents)+'.';
      const unsupported = generateEtims && ![0, 16].includes(selectedTaxRate);
      const notice = overlay.querySelector('#checkoutTaxNotice');
      notice.hidden = !unsupported;
      notice.textContent = unsupported ? 'Only Non-VAT (0%) and VAT (16%) are supported for eTIMS.' : '';
      confirmBtn.disabled = checkoutBusy || unsupported;
    }
    function setBusy(busy, message='Processing your sale…') {
      checkoutBusy = busy;
      overlay.querySelector('.qty-popup')?.setAttribute('aria-busy',String(busy));
      overlay.querySelectorAll('input, select, #chkCancel').forEach(control=>{control.disabled=busy;});
      confirmBtn.setAttribute('aria-busy',String(busy));
      msgEl.classList.toggle('checkout-progress',busy);
      if (busy) {
        confirmBtn.innerHTML = '<span class="pos-spinner-ring" aria-hidden="true"></span> Processing…';
        msgEl.style.color=''; msgEl.textContent=message;
        confirmBtn.scrollIntoView?.({block:'nearest',behavior:'instant'});
      } else {
        confirmBtn.textContent=selectedMethod==='mpesa'?'⚡ Send STK Prompt':'Confirm & Print';
      }
      updateTaxInfo();
    }
    taxSelect.addEventListener('change',()=>{selectedTaxRate=Number(taxSelect.value);updateTaxInfo();});
    const etimsToggle = overlay.querySelector('#generateEtims');
    if (etimsToggle) {
      etimsToggle.checked = generateEtims;
      const custOptions = overlay.querySelector('#etimsCustomerOptions');
      const walkInRadio = overlay.querySelector('#etimsTypeWalkIn');
      const regRadio = overlay.querySelector('#etimsTypeRegistered');
      const walkInNotice = overlay.querySelector('#etimsWalkInNotice');
      const custFields = overlay.querySelector('#etimsCustomerFields');
      const updateEtimsVisibility = () => {
        if (custOptions) custOptions.hidden = !generateEtims;
        const isWalkIn = walkInRadio ? walkInRadio.checked : true;
        if (walkInNotice) walkInNotice.hidden = !isWalkIn;
        if (custFields) custFields.hidden = isWalkIn;
      };
      if (walkInRadio && regRadio) {
        walkInRadio.onchange = updateEtimsVisibility;
        regRadio.onchange = updateEtimsVisibility;
      }
      overlay.querySelector('#etimsName').value = etimsCustomer.name || '';
      overlay.querySelector('#etimsPhone').value = etimsCustomer.phone || '';
      overlay.querySelector('#etimsPin').value = etimsCustomer.pin || '';
      overlay.querySelector('#etimsEmail').value = etimsCustomer.email || '';
      overlay.querySelector('#etimsAddress').value = etimsCustomer.billing_address || '';
      etimsToggle.onchange = () => {
        generateEtims = etimsToggle.checked;
        updateEtimsVisibility();
        updateTaxInfo();
      };
      updateEtimsVisibility();
    }

    customerPhoneInput.addEventListener('input', () => {
      savedPhone = customerPhoneInput.value;
      if (refInput && (!refInput.value || refInput.value.length < 3)) {
        refInput.value = customerPhoneInput.value;
      }
    });

    refInput.addEventListener('input', () => {
      savedPhone = refInput.value;
      if (customerPhoneInput && !customerPhoneInput.value) {
        customerPhoneInput.value = refInput.value;
      }
    });

    methodSelect.addEventListener('change', () => {
      selectedMethod = methodSelect.value;
      if (selectedMethod === 'mpesa') {
        refContainer.style.display = 'block';
        confirmBtn.textContent = '⚡ Send STK Prompt';
        confirmBtn.style.background = '#16a34a';
        confirmBtn.style.borderColor = '#16a34a';
        refInput.focus();
      } else {
        refContainer.style.display = 'none';
        confirmBtn.textContent = 'Confirm & Print';
        confirmBtn.style.background = '';
        confirmBtn.style.borderColor = '';
      }
    });

    updateTaxInfo();
    cancelBtn.addEventListener('click', () => { if(!checkoutBusy){stopPaymentPoll(); overlay.remove();} });

    confirmBtn.addEventListener('click', async () => {
      if (checkoutBusy || confirmBtn.disabled) return;
      // Paint feedback before preflight, local persistence or payment work.
      setBusy(true,generateEtims?'Checking eTIMS products and stock…':'Preparing your payment…');
      let errorField=null;
      try {
        await new Promise(resolve=>{
          // Background/occluded Windows browser frames can pause. Feedback
          // must never prevent checkout from proceeding in that situation.
          let finished=false;
          const finish=()=>{if(!finished){finished=true;clearTimeout(timer);resolve();}};
          const timer=setTimeout(finish,80);
          requestAnimationFrame(()=>requestAnimationFrame(finish));
        });
        let cleanPhone='';
        if (selectedMethod==='mpesa') {
          const rawPhone=refInput.value.trim() || customerPhoneInput.value.trim();
          errorField=refInput;
          if(!rawPhone)throw Error('Please enter customer M-Pesa phone number.');
          cleanPhone=normalizeMpesaPhone(rawPhone);
          if(!cleanPhone || cleanPhone.length<10)throw Error('Please enter a valid phone number (e.g. 0712345678).');
          savedPhone=rawPhone;errorField=null;
        }
        if (generateEtims) {
          const isWalkIn = overlay.querySelector('#etimsTypeWalkIn')?.checked ?? true;
          const custName = isWalkIn ? 'Walk-In' : overlay.querySelector('#etimsName').value.trim();
          const custPin = isWalkIn ? 'NA' : overlay.querySelector('#etimsPin').value.trim().toUpperCase();
          if (!custName) throw Error('Please enter the customer name.');
          if (!custPin) throw Error('Please enter the customer KRA PIN.');
          etimsCustomer = window.OraforgeEtimsCore.customer({
            name: custName,
            phone: isWalkIn ? '' : (overlay.querySelector('#etimsPhone').value.trim() || customerPhoneInput.value.trim()),
            pin: custPin,
            email: isWalkIn ? '' : overlay.querySelector('#etimsEmail').value.trim(),
            billing_address: isWalkIn ? '' : overlay.querySelector('#etimsAddress').value.trim()
          });
          etimsCustomer.remarks = isWalkIn ? '' : overlay.querySelector('#etimsRemarks').value.trim();
          etimsRegistrationDetails = await window.OraforgeEtims.beforePayment(order, state.settings, etimsCustomer, selectedMethod, state.items, selectedTaxRate);
        }
        if (selectedMethod==='mpesa') {
          setBusy(true,'Sending M-Pesa prompt…');
          const payResult=await triggerSwiftaMpesaCharge({reference:order.ticket_no || order.id,orderId:order.id,
            amount:order.total_cents,phone:cleanPhone});
          if(payResult.status!==true || payResult.data?.status==='failed')
            throw Error('STK request failed: '+(payResult.data?.message || payResult.message || 'Please retry.'));
          renderProcessingView(cleanPhone,payResult);
        } else {
          setBusy(true,'Saving your sale and preparing the receipt…');
          const paidOrder=await api('/api/order/pay',{method:'POST',body:{order_id:order.id,
            payment_method:'cash',payment_ref:'CASH',tax_rate:selectedTaxRate,
            customer_phone:customerPhoneInput.value.trim(),generate_etims:generateEtims,
            etims_customer:etimsCustomer,etims_shop_id:checkoutShop,etims_registration_details:etimsRegistrationDetails}});
          overlay.remove();showReceiptModal(paidOrder,false,true);
          window.OraforgeEtims?.afterPayment(paidOrder,state.settings);
          state.order=null;renderTicket();
        }
      } catch(error) {
        msgEl.style.color='var(--danger)';msgEl.textContent=error.message;
      } finally {
        checkoutBusy=false;
        if(overlay.contains(confirmBtn))setBusy(false);
        if(errorField && overlay.contains(errorField))errorField.focus();
      }
    });
  }


  function renderProcessingView(cleanPhone, payResult = {}) {
    stopPaymentPoll();
    const generation = paymentPollGeneration;
    const checkoutId = String(payResult?.data?.reference || '');
    const attemptId = String(payResult?.data?.attempt_id || '');
    const displayPhone = formatMpesaDisplayPhone(cleanPhone);
    if (!checkoutId) {
      checkoutBusy=false;
      renderFormView();
      const notice = overlay.querySelector('#checkoutMsg');
      notice.textContent = 'Swifta did not return a checkout ID. Check Swifta before retrying.';
      notice.style.color = 'var(--danger)';
      return;
    }
    overlay.innerHTML = `
      <div class="qty-popup" style="max-width:430px;text-align:center;padding:24px;">
        <div style="font-size:32px;padding:9px;">📲</div>
        <h3 style="margin:0 0 6px;font-size:20px;">Verifying M-Pesa</h3>
        <p style="font-size:13px;color:var(--muted);line-height:1.5;">STK prompt sent to <strong>${displayPhone}</strong>. Enter the M-Pesa PIN on the customer's phone.</p>
        <div style="background:var(--line);padding:14px;text-align:left;border-radius:10px;margin:16px 0;">
          <div style="display:flex;justify-content:space-between;gap:9px;"><span>Amount Due</span><strong>${money(order.total_cents)}</strong></div>
          <div style="display:flex;justify-content:space-between;gap:9px;margin-top:6px;font-size:12px;"><span>Order Ticket</span><strong>${order.ticket_no}</strong></div>
        </div>
        <div id="paymentVerificationNotice" role="status" aria-live="polite" style="border-radius:9px;padding:12px;background:var(--surface-soft,var(--panel));font-size:13px;line-height:1.5;"><span class="pos-spinner-ring"></span> Checking Swifta for successful payment…</div>
        <p style="font-size:12px;color:var(--muted);margin:15px 0;">The receipt opens automatically after verified payment. An accepted STK prompt is not proof of payment.</p>
        <div style="display:grid;gap:9px;">
          <button type="button" class="primary" id="btnCheckSwiftaStatus">Check Payment Status</button>
          <button type="button" class="ghost" id="btnRetryFailedSwifta" style="display:none;">Send New STK Prompt</button>
          <button type="button" class="ghost" id="btnCancelProcessing">Leave Pending / Back</button>
        </div>
      </div>
    `;
    const notice = overlay.querySelector('#paymentVerificationNotice');
    const checkBtn = overlay.querySelector('#btnCheckSwiftaStatus');
    const retryBtn = overlay.querySelector('#btnRetryFailedSwifta');
    const cancelBtn = overlay.querySelector('#btnCancelProcessing');
    let polling = false, completed = false, failed = false, checks = 0;

    async function checkPayment() {
      if (polling || completed || failed || generation !== paymentPollGeneration) return;
      polling = true;
      try {
        const verified = await getVerifiedSwiftaStatus({
          checkoutId, attemptId, orderId: order.id, amountCents: order.total_cents,
          shopId: String(window.OraforgeShops?.activeShopId() || localStorage.getItem('pos_active_business_type') || 'retail')
        });
        if (generation !== paymentPollGeneration) return;
        if (verified.status === 'success') {
          completed = true;
          notice.textContent = 'M-Pesa verified! Preparing your receipt…';
          const paidOrder = await api('/api/order/pay', {
            method:'POST',
            body:{order_id:order.id,payment_method:'mpesa',payment_ref:verified.payment_ref,
              customer_phone:cleanPhone,tax_rate:selectedTaxRate,swifta_attempt_id:attemptId,swifta_checkout_id:checkoutId,
              generate_etims:generateEtims, etims_customer:etimsCustomer, etims_shop_id:checkoutShop, etims_registration_details:etimsRegistrationDetails}
          });
          if (generation !== paymentPollGeneration) return;
          stopPaymentPoll();
          overlay.remove();
          showReceiptModal(paidOrder, false, true);
          window.OraforgeEtims?.afterPayment(paidOrder, state.settings);
          state.order = null;
          renderTicket();
          return;
        }
        if (verified.status === 'failed') {
          failed = true;
          notice.style.color = 'var(--danger)';
          notice.textContent = 'The M-Pesa payment failed or was cancelled. No paid receipt was generated.';
          retryBtn.style.display = 'block';
          return;
        }
        checks += 1;
        notice.textContent = checks > 55
          ? 'Still unverified. Check Swifta before sending another STK prompt.'
          : 'Waiting for M-Pesa confirmation — checking automatically…';
      } catch (err) {
        if (generation !== paymentPollGeneration) return;
        completed = false;
        notice.textContent = 'Could not reach Swifta. Will retry automatically; this sale is still unpaid.';
      } finally {
        polling = false;
        if (!completed && !failed && generation === paymentPollGeneration)
          paymentPollTimer = setTimeout(checkPayment, checks > 55 ? 10000 : 3000);
      }
    }
    checkBtn.addEventListener('click', () => {
      if (paymentPollTimer) clearTimeout(paymentPollTimer);
      paymentPollTimer = null;
      checkPayment();
    });
    retryBtn.addEventListener('click', async () => {
      if (!failed) return;
      retryBtn.disabled = true;
      const next = await triggerSwiftaMpesaCharge({
        reference:order.ticket_no||order.id,orderId:order.id,amount:order.total_cents,phone:cleanPhone
      });
      if (next.status === true && next.data?.reference) renderProcessingView(cleanPhone,next);
      else { notice.textContent = next.message || 'Unable to retry the STK prompt.'; retryBtn.disabled=false; }
    });
    cancelBtn.addEventListener('click', () => {
      stopPaymentPoll();
      renderFormView();
    });
    checkPayment();
  }

  document.body.appendChild(overlay);
  renderFormView();
}

// ── Suppliers (replaces Tables) ───────────────────────────────────────────────
async function renderSuppliers() {
  const root = qs('[data-page="suppliers"]');
  const suppliers = await api('/api/suppliers');
  
  root.innerHTML = `
    <div class="panel-title-group" style="margin: 0 24px 20px; padding-top: 24px;">
      <h2>Suppliers</h2>
      <div style="display: flex; gap: 12px; margin-left: auto;">
        <button class="add-btn" id="addSupplierBtn" style="background:var(--primary)">+ Add Supplier</button>
        <button class="add-btn" id="refreshSuppliers" style="background:var(--ink)">Refresh</button>
      </div>
    </div>
    
    <div class="sales-table-container">
      <table class="sales-table">
        <thead>
          <tr>
            <th>Supplier Name</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Status</th>
            <th style="text-align: right">Action</th>
          </tr>
        </thead>
        <tbody>
          ${suppliers.map(s => `
            <tr class="sales-row">
              <td><strong>${s.name}</strong></td>
              <td>${s.phone || '-'}</td>
              <td>${s.email || '-'}</td>
              <td>
                <span class="pay-badge" style="${s.active ? 'background:#dcfce7;color:#16a34a;' : 'background:#f1f5f9;color:#64748b;'}">
                  ${s.active ? 'Active' : 'Inactive'}
                </span>
              </td>
              <td style="text-align: right">
                <button class="view-receipt-btn supplier-view-btn" data-id="${s.id}" style="margin-right: 4px;">View</button>
                <button class="view-receipt-btn supplier-edit-btn" data-id="${s.id}">Edit</button>
              </td>
            </tr>
          `).join('') || `<tr><td colspan="5" class="empty" style="text-align:center; padding: 40px;">No suppliers found</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  
  qs('#refreshSuppliers').addEventListener('click', renderSuppliers);
  qs('#addSupplierBtn').addEventListener('click', () => showSupplierModal());
  
  qsa('.supplier-edit-btn', root).forEach(btn => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const supplier = suppliers.find(s => s.id === id);
      if (supplier) showSupplierModal(supplier);
    });
  });

  qsa('.supplier-view-btn', root).forEach(btn => {
    btn.addEventListener('click', () => {
      showSupplierDetails(Number(btn.dataset.id));
    });
  });
}

async function showSupplierDetails(id) {
  const supplier = await api(`/api/supplier/detail?id=${id}`);
  
  const formatDate = (ts) => {
    if (!ts) return '-';
    const d = new Date(ts * 1000);
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short' });
  };

  const overlay = document.createElement('div');
  overlay.className = 'qty-popup-overlay';
  overlay.innerHTML = `
    <div class="qty-popup" style="max-width: 500px; text-align: left;">
      <h2 style="margin-top:0">${supplier.name}</h2>
      <p style="color:var(--muted); margin-bottom: 20px;">Total Purchases: <strong style="color:var(--ink)">${money(supplier.total_purchases)}</strong></p>
      
      <div style="font-weight:700; font-size:12px; text-transform:uppercase; color:var(--muted); border-bottom:1px solid var(--line); padding-bottom:8px; margin-bottom:8px;">Products Supplied</div>
      <div style="max-height:300px; overflow-y:auto; margin-bottom:20px;">
        ${supplier.products.length ? supplier.products.map(p => `
          <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid #f1f5f9;">
            <div>
              <div style="font-weight:600;">${p.name}</div>
              <div style="font-size:12px; color:var(--muted)">Last Delivery: ${formatDate(p.last_delivery)}</div>
            </div>
            <div style="text-align:right;">
              <div style="font-weight:700; color:var(--primary-dark)">${money(p.cost_cents)} cost</div>
              <div style="font-size:12px; color:var(--muted)">Stock: ${p.stock_qty}</div>
            </div>
          </div>
        `).join('') : '<div style="color:var(--muted); font-size:14px; padding:10px 0;">No products supplied yet.</div>'}
      </div>

      <div class="qty-popup-actions">
        <button class="primary" id="closeSupplierView" style="width:100%">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#closeSupplierView').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
}

function showSupplierModal(supplier = null) {
  const overlay = document.createElement('div');
  overlay.className = 'qty-popup-overlay';
  overlay.innerHTML = `
    <div class="qty-popup" style="max-width: 450px; text-align: left;">
      <h3 style="margin-top:0">${supplier ? 'Edit Supplier' : 'New Supplier'}</h3>
      <form id="supplierForm" style="display:flex; flex-direction:column; gap:16px;">
        <div>
          <label style="display:block; margin-bottom:6px; font-weight:600; font-size:14px;">Supplier Name *</label>
          <input class="field" name="name" required value="${supplier ? supplier.name : ''}" style="width:100%; padding:10px;">
        </div>
        <div style="display:flex; gap:16px;">
          <div style="flex:1;">
            <label style="display:block; margin-bottom:6px; font-weight:600; font-size:14px;">Phone Number</label>
            <input class="field" name="phone" value="${supplier?.phone || ''}" style="width:100%; padding:10px;">
          </div>
          <div style="flex:1;">
            <label style="display:block; margin-bottom:6px; font-weight:600; font-size:14px;">Status</label>
            <select name="active" class="field" style="width:100%; padding:10px;">
              <option value="1" ${supplier?.active === 0 ? '' : 'selected'}>Active</option>
              <option value="0" ${supplier?.active === 0 ? 'selected' : ''}>Inactive</option>
            </select>
          </div>
        </div>
        <div>
          <label style="display:block; margin-bottom:6px; font-weight:600; font-size:14px;">Email Address</label>
          <input type="email" class="field" name="email" value="${supplier?.email || ''}" style="width:100%; padding:10px;">
        </div>
        
        <div id="supplierMsg" style="margin-top:4px; font-weight:600; font-size:14px; text-align:center;"></div>
        
        <div class="qty-popup-actions" style="margin-top:16px;">
          <button type="button" class="ghost" id="cancelSupplierBtn">Cancel</button>
          <button type="submit" class="primary">Save Supplier</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#cancelSupplierBtn').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  const msgEl = overlay.querySelector('#supplierMsg');
  const submitBtn = overlay.querySelector('button[type="submit"]');

  overlay.querySelector('#supplierForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    msgEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving...';
    
    const fd = new FormData(e.target);
    const payload = Object.fromEntries(fd.entries());
    if (supplier) payload.id = supplier.id;
    
    try {
      await api('/api/admin/supplier', { method: 'POST', body: payload });
      msgEl.style.color = 'var(--ok)';
      msgEl.textContent = 'Supplier saved successfully!';
      
      setTimeout(() => {
        close();
        renderSuppliers();
      }, 800);
      
    } catch (err) {
      msgEl.style.color = 'var(--danger)';
      msgEl.textContent = err.message;
      submitBtn.disabled = false;
      submitBtn.textContent = 'Save Supplier';
    }
  });
}

// ── Sales History (replaces Orders) ──────────────────────────────────────────
async function renderSales() {
  const root = qs('[data-page="sales"]');
  const orders = await api('/api/orders?status=paid');
  
  const formatDate = (val, order) => {
    const d = parseOrderDate(order || { updated_at: val });
    return d.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };

  const sortedOrders = [...(orders || [])].sort((a, b) => parseOrderDate(b).getTime() - parseOrderDate(a).getTime());

  root.innerHTML = `
    <div class="panel-title-group" style="margin: 0 24px 20px; padding-top: 24px;">
      <h2>Sales History</h2>
      <button class="add-btn" id="refreshSales" style="background:var(--ink)">Refresh</button>
    </div>
    
    <div class="sales-table-container">
      <table class="sales-table">
        <thead>
          <tr>
            <th>Receipt No.</th>
            <th>Date</th>
            <th>Cashier</th>
            <th>Payment</th>
            <th style="text-align: right">Total</th>
            <th style="text-align: right">Action</th>
          </tr>
        </thead>
        <tbody>
          ${sortedOrders.map(o => `
            <tr class="sales-row" data-id="${o.id}">
              <td class="font-mono"><strong>${o.ticket_no}</strong></td>
              <td class="text-muted">${formatDate(o.updated_at, o)}</td>
              <td>${o.employee_name || '-'}</td>
              <td>
                <span class="pay-badge ${o.payment_method === 'mpesa' ? 'mpesa' : 'cash'}">
                  ${o.payment_method === 'mpesa' ? 'M-Pesa' : 'Cash'}
                </span>
                ${o.payment_ref ? `<div class="pay-ref">${o.payment_ref}</div>` : ''}
              </td>
              <td class="sales-total" style="text-align: right">${money(o.total_cents)}</td>
              <td style="text-align: right">
                <button class="view-receipt-btn">View</button>
              </td>
            </tr>
          `).join('') || `<tr><td colspan="6" class="empty" style="text-align:center; padding: 40px;">No sales found</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  
  qs('#refreshSales').addEventListener('click', renderSales);
  
  qsa('.sales-row', root).forEach(row => {
    row.addEventListener('click', async () => {
      const id = row.dataset.id;
      try {
        const fullOrder = await api(`/api/order?id=${id}`);
        showReceiptModal(fullOrder);
      } catch (err) {
        toast('Failed to load receipt', 'error');
      }
    });
  });
}

// ── Cashier Payments ──────────────────────────────────────────────────────────
async function renderCashier() {
  const root = qs('[data-page="cashier"]');
  const existingSearch = qs('#paymentSearch')?.value || '';
  const orders = await api(`/api/payments?q=${encodeURIComponent(existingSearch)}`);
  root.innerHTML = `
    <div class="panel-head">
      <h2>Pending Payments</h2>
      <div class="head-actions">
        <input class="field compact-field" id="paymentSearch" placeholder="Ticket, customer, staff" value="${existingSearch}">
        <button class="primary" id="refreshCashier">Refresh</button>
      </div>
    </div>
    <div class="content-grid">
      ${orders.map(o => `
        <article class="order-card ${o.status}" data-order="${o.id}">
          <span class="badge">${o.status}</span>
          <strong>${o.ticket_no}</strong>
          <span>${o.order_type} — ${o.employee_name || '-'}</span>
          ${o.customer_name ? `<span>Customer: ${o.customer_name}</span>` : ''}
          <strong>${money(o.total_cents)}</strong>
          <input class="field pay-ref" placeholder="M-Pesa code / reference">
          <div class="pay-actions">
            <button class="primary pay-btn" data-method="mpesa">M-Pesa</button>
            <button class="secondary pay-btn" data-method="cash">Cash</button>
            <button class="secondary pay-btn" data-method="card">Card</button>
          </div>
          <button class="receipt-link-btn" data-receipt-order="${o.id}">View Receipt</button>
        </article>
      `).join('') || '<div class="empty">No pending payments</div>'}
    </div>
  `;

  qs('#refreshCashier').addEventListener('click', renderCashier);
  qs('#paymentSearch').addEventListener('keydown', event => {
    if (event.key === 'Enter') renderCashier();
  });

  qsa('[data-receipt-order]', root).forEach(btn => btn.addEventListener('click', async () => {
    const orderId = Number(btn.dataset.receiptOrder);
    try {
      const allOrders = await api('/api/payments?q=');
      const summary = allOrders.find(o => o.id === orderId);
      if (summary) showReceiptModal({ ...summary, items: [] });
    } catch(e) { /* ignore */ }
  }));

  qsa('.pay-btn', root).forEach(btn => btn.addEventListener('click', async () => {
    const card = btn.closest('[data-order]');
    const orderId = Number(card.dataset.order);
    const ref = qs('.pay-ref', card).value.trim();
    await api('/api/order/pay', {
      method: 'POST',
      body: { order_id: orderId, payment_method: btn.dataset.method, payment_ref: ref },
    });
    await renderCashier();
  }));
}

// ── Product Admin (replaces Menu Admin) ──────────────────────────────────────
let productSearch = '';
let productCategoryFilter = '';

function renderProductAdmin() {
  const root = qs('[data-page="products"]');

  root.innerHTML = `
    <div class="panel-head">
      <div class="panel-title-group">
        <h2>Products</h2>
        <span class="badge" id="productCountBadge">${state.items.length} active</span>
      </div>
      <div style="display:flex; gap:8px; align-items:center;">
        <button type="button" class="secondary barcode-scan-btn" id="scanAddProductBtn" style="padding:9px 14px; font-size:13px;" title="Scan Barcode to Add or Lookup Product">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M3 5v14M8 5v14M12 5v14M17 5v14M21 5v14"/>
          </svg>
          <span>Scan Barcode / Add</span>
        </button>
        <button class="secondary" id="addCategoryBtn">Manage Categories</button>
        <button class="primary add-btn" id="showAddProductModal">+ Add Product</button>
      </div>
    </div>
    
    <div class="toolbar">
      <div class="search-bar">
        <span class="search-icon">🔍</span>
        <input type="text" class="field search-field" id="productSearchInput" placeholder="Search by name or SKU..." value="${productSearch}">
      </div>
      <select class="field cat-filter" id="productCatFilter">
        <option value="">All Categories</option>
        ${state.categories.map(c => `<option value="${c.id}" ${productCategoryFilter == c.id ? 'selected' : ''}>${String(c.name).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}</option>`).join('')}
      </select>
    </div>

    <div class="sales-table-container staff-product-list" id="productAdminGrid"></div>
  `;

  // Global Event Listeners for the page
  const searchInput = qs('#productSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      productSearch = e.target.value;
      renderProductAdminGrid();
    });
  }

  qs('#productCatFilter')?.addEventListener('change', e => {
    productCategoryFilter = e.target.value;
    renderProductAdminGrid();
  });

  qs('#addCategoryBtn')?.addEventListener('click', showCategoryManager);
  qs('#showAddProductModal')?.addEventListener('click', () => showProductModal());
  qs('#scanAddProductBtn')?.addEventListener('click', () => showBarcodeModal('product'));

  // Close menus on outside click
  document.addEventListener('click', () => {
    qsa('.action-menu', root).forEach(m => m.classList.add('hidden'));
  });

  renderProductAdminGrid();
}

function formatVariantChips(raw, maxVisible = 4) {
  if (!raw) return '';
  let variants = [];
  try {
    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        const parsed = JSON.parse(trimmed);
        variants = Array.isArray(parsed) ? parsed : [parsed];
      } else if (trimmed) {
        variants = trimmed.split(',').map(s => ({ name: s.trim() })).filter(v => v.name);
      }
    } else if (Array.isArray(raw)) {
      variants = raw;
    } else if (typeof raw === 'object') {
      variants = [raw];
    }
  } catch (_) {
    if (typeof raw === 'string') {
      variants = raw.split(',').map(s => ({ name: s.trim() }));
    }
  }

  if (!variants || !variants.length) return '';

  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const chips = variants.slice(0, maxVisible).map(v => {
    let label = '';
    if (typeof v === 'string') {
      label = v;
    } else if (typeof v === 'object' && v !== null) {
      label = v.name || [v.size, v.color || v.shade].filter(Boolean).join(' / ') || 'Variant';
    }
    label = esc(label);
    const stock = (typeof v === 'object' && v !== null && v.stock !== undefined && v.stock !== '') 
      ? `<span style="opacity:0.75; font-size:10px; margin-left:3px;">(${v.stock})</span>` 
      : '';
    return `<span class="cap-pill" style="font-size:10.5px; background:rgba(37,99,235,0.08); color:#1d4ed8; border:1px solid rgba(37,99,235,0.2); border-radius:12px; padding:2px 7px; font-weight:600; display:inline-flex; align-items:center; line-height:1.3;">${label}${stock}</span>`;
  }).join('');

  const remaining = variants.length - maxVisible;
  const morePill = remaining > 0 
    ? `<span class="cap-pill" style="font-size:10px; background:var(--line); color:var(--muted); border-radius:12px; padding:2px 6px; font-weight:700;">+${remaining} more</span>` 
    : '';

  return `
    <div style="margin-top:4px; display:flex; flex-wrap:wrap; gap:4px; align-items:center;">
      <span style="font-size:10px; font-weight:700; text-transform:uppercase; color:var(--muted); letter-spacing:0.5px;">Variants:</span>
      ${chips}
      ${morePill}
    </div>
  `;
}

function renderProductAdminGrid() {
  const grid = qs('#productAdminGrid');
  if (!grid) return;
  const root = qs('[data-page="products"]');
  
  const filteredItems = state.items.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(productSearch.toLowerCase()) || 
                          (item.sku && item.sku.toLowerCase().includes(productSearch.toLowerCase())) ||
                          (item.barcode && item.barcode.toLowerCase().includes(productSearch.toLowerCase()));
    const matchesCat = productCategoryFilter ? item.category_id === Number(productCategoryFilter) : true;
    return matchesSearch && matchesCat;
  });

  const badge = qs('#productCountBadge');
  if (badge) badge.textContent = `${filteredItems.length} active`;

  const safe = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  grid.innerHTML = `<table class="sales-table staff-products"><thead><tr><th>Product</th><th>Category</th><th>SKU</th><th>Price</th><th>Stock</th><th>Actions</th></tr></thead><tbody>${filteredItems.map(item=>`<tr class="sales-row"><td><strong>${safe(item.name)}</strong>${item.strength?`<small>${safe(item.strength)}</small>`:''}</td><td>${safe(categoryName(item.category_id))}</td><td><code>${safe(item.sku || '—')}</code></td><td><strong>${money(item.price_cents)}</strong></td><td><span class="staff-stock ${tracksStock(item) && (item.stock_qty||0)<=(item.reorder_level??5)?'low':''}">${item.unit === 'service' ? 'Service' : `${safe(item.stock_qty ?? '—')} ${safe(item.unit || 'pcs')}`} </span></td><td><div class="product-actions">${item.unit === 'service' ? '' : `<button class="quick-add-stock-btn" data-id="${item.id}" title="Add newly arrived stock" style="background:rgba(22,163,74,0.12);color:#16a34a;border:1px solid #16a34a;border-radius:4px;padding:3px 7px;font-size:12px;font-weight:600;cursor:pointer;">+ Stock</button>`}<button class="edit-btn" data-id="${item.id}">Edit</button><button class="delete-btn" data-id="${item.id}">Delete</button></div></td></tr>`).join('') || '<tr><td colspan="6">No products match your criteria.</td></tr>'}</tbody></table>`;

  // Dropdown toggles
  qsa('.action-menu-btn', grid).forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const menu = btn.nextElementSibling;
      const isHidden = menu.classList.contains('hidden');
      qsa('.action-menu', root).forEach(m => m.classList.add('hidden')); // close all
      if (isHidden) menu.classList.remove('hidden');
    });
  });

  qsa('.quick-add-stock-btn', grid).forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const item = state.items.find(i => i.id == btn.dataset.id);
      if (item) showQuickAddStockModal(item);
    });
  });

  qsa('.edit-btn', grid).forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const item = state.items.find(i => i.id == btn.dataset.id);
      if (item) showProductModal(item);
    });
  });

  qsa('.delete-btn', grid).forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirm('Are you sure you want to completely delete this product?')) return;
      const item = state.items.find(i => i.id == btn.dataset.id);
      if (item) {
        try {
          const payload = await api('/api/menu/item?id=' + item.id, { method: 'DELETE' });
          if (payload.error) {
            alert(payload.error);
            return;
          }
          state.categories = payload.categories;
          state.items = payload.items;
          renderProductAdmin();
        } catch (err) {
          alert('Could not delete product. It may have sales history tied to it.');
        }
      }
    });
  });
}

// ── Online Image Search Modal ────────────────────────────────────────────────

async function searchOnlineProductImages(query, limit = 6) {
  const q = String(query || '').trim();
  if (!q) return { images: [], results: [] };
  if (!navigator.onLine) throw new Error('Image search needs an internet connection.');

  const url = `https://api.openverse.org/v1/images/?q=${encodeURIComponent(q)}&page_size=${Math.max(1, Math.min(limit, 12))}`;
  let payload;
  if (window.OraforgeHttp?.request) {
    const response = await window.OraforgeHttp.request({
      url,
      method: 'GET',
      headers: { Accept: 'application/json' }
    });
    payload = response.data;
    if (typeof payload === 'string') payload = JSON.parse(payload);
  } else {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Image search failed (${response.status})`);
    payload = await response.json();
  }

  const images = (payload?.results || []).map(item => {
    const thumb = item.thumbnail || item.url;
    const full = item.url || thumb;
    return {
      thumb,
      thumbnail: thumb,
      full,
      url: full,
      title: item.title || q,
      source: 'Openverse'
    };
  }).filter(item => item.thumb && item.full);
  return { query: q, images, results: images };
}

function showImageSearchModal(query, onSelect) {
  const overlay = document.createElement('div');
  overlay.className = 'qty-popup-overlay';
  overlay.style.zIndex = '10000';
  overlay.innerHTML = `
    <div class="qty-popup" style="max-width: 500px; width: 90vw; max-height: 85vh; display:flex; flex-direction:column; text-align: left; padding: 22px; background:var(--panel); border:1px solid var(--line); border-radius:14px;">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
        <div style="display:flex; align-items:center; gap:8px;">
          <span style="font-size:20px;">🔍</span>
          <h3 style="margin:0; font-size:17px; font-weight:700; color:var(--ink);">Search Product Image</h3>
        </div>
        <button class="modal-close" id="imgModalClose" style="background:none; border:none; font-size:24px; color:var(--muted); cursor:pointer; line-height:1;">&times;</button>
      </div>
      <p style="font-size:12px; color:var(--muted); margin:0 0 14px; line-height:1.4;">
        Searches Openverse directly from the phone. Select an image to use its online URL for this product.
      </p>
      
      <div style="display:flex; gap:8px; margin-bottom:14px;">
        <input class="field" id="imgSearchInput" placeholder="Enter product name..." value="${query || ''}" style="flex:1; padding:9px 12px; font-size:13px;">
        <button class="primary" id="doImgSearchBtn" style="padding:9px 16px; font-size:13px; font-weight:700; white-space:nowrap;">Search</button>
      </div>

      <div id="imgSearchResults" style="min-height: 240px; display:flex; flex-direction:column; justify-content:center;">
        <div style="text-align:center; color:var(--muted); padding:30px 0; font-size:13px;">Type a product name and click Search</div>
      </div>

      <div id="imgSearchStatus" style="font-size:12px; color:var(--muted); margin-top:8px; text-align:center;"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#imgModalClose').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });

  const input = overlay.querySelector('#imgSearchInput');
  const resultsBox = overlay.querySelector('#imgSearchResults');
  const statusEl = overlay.querySelector('#imgSearchStatus');
  const searchBtn = overlay.querySelector('#doImgSearchBtn');

  const executeSearch = async () => {
    const q = input.value.trim();
    if (!q) return;
    searchBtn.disabled = true;
    searchBtn.textContent = 'Searching...';
    resultsBox.innerHTML = `
      <div style="text-align:center; padding:40px 0;">
        <span style="font-size:28px; display:inline-block; animation:spin 1s linear infinite;">⏳</span>
        <p style="margin-top:10px; color:var(--muted); font-size:13px;">Finding best product photo for "${q}"...</p>
      </div>
    `;
    statusEl.textContent = '';

    try {
      const data = await searchOnlineProductImages(q, 6);
      searchBtn.disabled = false;
      searchBtn.textContent = 'Search';

      const imagesList = data.images || data.results || [];
      const img = imagesList[0];

      if (!img) {
        resultsBox.innerHTML = `
          <div style="text-align:center; color:var(--muted); padding:35px 0;">
            <div style="font-size:28px; margin-bottom:6px;">📷</div>
            <div>No image found for "${q}".</div>
            <div style="font-size:12px; margin-top:4px;">Try a broader keyword (e.g. "Cetirizine", "Cement", "Burger").</div>
          </div>
        `;
        return;
      }

      const imgUrl = img.full || img.url || img.thumb || img.thumbnail;
      const displayThumb = img.thumb || img.thumbnail || imgUrl;

      resultsBox.innerHTML = `
        <div style="background:var(--bg); border:1px solid var(--line); border-radius:12px; padding:14px; display:flex; flex-direction:column; align-items:center; gap:12px;">
          <div style="width:100%; height:230px; background:var(--panel); border-radius:8px; display:flex; align-items:center; justify-content:center; overflow:hidden; border:1px solid var(--line); position:relative;">
            <img src="${displayThumb}" alt="${img.title || 'Product'}" style="max-height:100%; max-width:100%; object-fit:contain;" onerror="this.src='/static/uploads/default.png';">
            <span style="position:absolute; top:8px; right:8px; font-size:11px; font-weight:700; background:rgba(0,0,0,0.75); color:#cbd5e1; padding:3px 8px; border-radius:6px; text-transform:capitalize;">${img.source || 'web'}</span>
          </div>
          <div style="text-align:center; width:100%;">
            <div style="font-size:13px; font-weight:700; color:var(--ink); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${img.title || ''}">
              ${img.title || q}
            </div>
          </div>
          <button type="button" id="useThisImgBtn" class="primary" style="width:100%; padding:12px 20px; font-size:14px; font-weight:700; border-radius:8px; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 2px 8px rgba(0,0,0,0.15);">
            <span>✓</span> Use This Image
          </button>
        </div>
      `;

      resultsBox.querySelector('#useThisImgBtn')?.addEventListener('click', () => {
        onSelect(imgUrl);
        toast('Online product image selected!', 'success');
        close();
      });

    } catch (err) {
      searchBtn.disabled = false;
      searchBtn.textContent = 'Search';
      resultsBox.innerHTML = `<div style="text-align:center; color:var(--danger); padding:30px 0; font-size:13px;">Search failed: ${err.message}</div>`;
    }
  };

  searchBtn.addEventListener('click', executeSearch);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') executeSearch(); });

  if (query) executeSearch();
}

function showQuickAddStockModal(item) {
  const currentStock = Number(item.stock_qty || 0);
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  const safe = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  overlay.innerHTML = `
    <div class="modal-box" style="width:380px; max-width:92vw; padding:20px;">
      <div class="modal-head" style="margin-bottom:12px; display:flex; justify-content:space-between; align-items:center;">
        <h3 style="margin:0; font-size:17px;">📦 Receive New Stock</h3>
        <button class="modal-close" id="qasClose" type="button" style="background:none; border:none; font-size:20px; cursor:pointer;">&times;</button>
      </div>
      <p style="margin:0 0 12px; font-size:14px; font-weight:600;">${safe(item.name)}</p>
      <div style="background:var(--line); padding:10px 14px; border-radius:8px; margin-bottom:14px; font-size:13px; display:flex; justify-content:space-between; align-items:center;">
        <span>Current Stock</span>
        <strong style="font-size:15px;">${currentStock} ${safe(item.unit || 'pcs')}</strong>
      </div>
      <div class="form-group" style="margin-bottom:14px;">
        <label style="display:block; font-weight:600; font-size:13px; margin-bottom:6px;">New stock arrived</label>
        <input type="number" id="qasNewStock" class="field" placeholder="e.g. 20" min="0.01" step="${item.decimal_qty_enabled || hasCap('decimal_qty') ? '0.01' : '1'}" autofocus style="width:100%; font-size:16px; padding:10px;">
        <div id="qasCalc" style="margin-top:6px; font-size:12px; color:#16a34a; min-height:18px;"></div>
      </div>
      <div class="modal-actions" style="display:flex; justify-content:flex-end; gap:8px;">
        <button type="button" class="secondary" id="qasCancel">Cancel</button>
        <button type="button" class="primary" id="qasConfirm" style="background:#16a34a; border-color:#16a34a;">Update Stock</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#qasNewStock');
  const calc = overlay.querySelector('#qasCalc');
  const confirmBtn = overlay.querySelector('#qasConfirm');
  const close = () => overlay.remove();

  overlay.querySelector('#qasClose').addEventListener('click', close);
  overlay.querySelector('#qasCancel').addEventListener('click', close);

  const updateCalc = () => {
    const addQty = parseFloat(input.value);
    if (!isNaN(addQty) && addQty > 0) {
      const newTotal = Math.round((currentStock + addQty) * 100) / 100;
      calc.innerHTML = `Calculation: ${currentStock} + <strong>${addQty}</strong> = <strong>${newTotal}</strong> ${safe(item.unit || 'pcs')}`;
      confirmBtn.textContent = `Add +${addQty} (Total: ${newTotal})`;
      confirmBtn.disabled = false;
    } else {
      calc.textContent = '';
      confirmBtn.textContent = 'Update Stock';
      confirmBtn.disabled = true;
    }
  };
  confirmBtn.disabled = true;
  input.addEventListener('input', updateCalc);

  const doUpdate = async () => {
    const addQty = parseFloat(input.value);
    if (isNaN(addQty) || addQty <= 0) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Updating…';
    try {
      await api('/api/stock/adjust', {
        method: 'POST',
        body: { product_id: item.id, qty_change: addQty, reason: 'received_stock' }
      });
      item.stock_qty = Math.round((currentStock + addQty) * 100) / 100;
      toast(`Added ${addQty} new stock to ${item.name}! Total: ${item.stock_qty}`, 'success');
      overlay.remove();
      renderProductAdminGrid();
    } catch (err) {
      alert(err.message || 'Failed to update stock');
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Update Stock';
    }
  };

  confirmBtn.addEventListener('click', doUpdate);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doUpdate();
    }
  });
  setTimeout(() => input.focus(), 60);
}

function showProductModal(item = null) {
  document.getElementById('productModal')?.remove();
  
  const isEdit = !!item;
  let defaultSku = '';
  if (!isEdit) {
    const skus = state.items.map(i => parseInt(i.sku) || 0);
    const maxSku = skus.length > 0 ? Math.max(...skus) : 0;
    defaultSku = maxSku + 1;
  }
  const overlay = document.createElement('div');
  overlay.id = 'productModal';
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal-box" style="width:540px; max-width:92vw; max-height:90vh; overflow-y:auto;">
      <div class="modal-head">
        <h3>${isEdit ? 'Edit Product' : 'Add Product'}</h3>
        <button class="modal-close" id="pmClose" type="button">&times;</button>
      </div>
      <form id="pmForm" class="modal-form">
        <div class="form-grid">
          <div class="form-group" style="grid-column: 1 / -1;">
            <label>Product Image</label>
            <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
              <div id="imgPreview" style="width:64px; height:64px; background:#f1f5f9; border-radius:8px; border:1px solid var(--line); display:flex; align-items:center; justify-content:center; overflow:hidden;">
                ${item?.image_url ? `<img src="${item.image_url}" style="width:100%;height:100%;object-fit:contain;padding:4px;box-sizing:border-box;">` : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:24px;height:24px;color:var(--muted)"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>'}
              </div>
              <input type="file" id="imgUpload" accept="image/*" class="field" style="flex:1; min-width:160px; padding:6px;">
              <button type="button" class="secondary" id="searchImgOnlineBtn" style="padding: 7px 12px; font-size: 13px; white-space:nowrap;">🔍 Search Online</button>
              <input type="hidden" name="image_base64" id="imgBase64">
              <input type="hidden" name="image_url" id="imgUrlInput" value="${item?.image_url || ''}">
            </div>
          </div>
          <div class="form-group" style="grid-column: 1 / -1;">
            <label>Product Name *</label>
            <input class="field" name="name" id="productNameInput" value="${item?.name || ''}" required>
          </div>
          <div class="form-group">
            <label>Category</label>
            <select class="field" name="category_id">
              ${state.categories.map(c => `<option value="${c.id}" ${item?.category_id == c.id ? 'selected' : ''}>${String(c.name).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label>SKU</label>
            <input class="field" name="sku" value="${item?.sku || defaultSku}">
          </div>
          ${hasCap('barcode') ? `
            <div class="form-group">
              <label style="display:flex; justify-content:space-between; align-items:center;">
                <span>Barcode</span>
                <span style="display:flex; gap:6px;">
                  <button type="button" class="btn-xs" id="pmScanBarcodeBtn" title="Scan with camera or barcode reader">📷 Scan</button>
                  <button type="button" class="btn-xs" id="pmGenBarcodeBtn" title="Generate random EAN barcode">🎲 Generate</button>
                </span>
              </label>
              <input class="field" id="pmBarcodeInput" name="barcode" value="${item?.barcode || ''}" placeholder="Scan or enter barcode">
            </div>
          ` : ''}
          <div class="form-group">
            <label>Unit of Measure</label>
            ${state.profile?.id === 'garage' ? `<select class="field" name="unit">${garageUnitOptions(item?.unit || 'pcs')}</select>` : `<input class="field" name="unit" placeholder="pcs, kg, m, tin" value="${item?.unit || 'pcs'}">`}
          </div>
          <div class="form-group">
            <label style="display:flex; justify-content:space-between; align-items:center;">
              <span>Stock Qty</span>
              ${isEdit ? `<span style="font-size:11px; color:var(--muted); font-weight:normal;">Current: <strong id="pmCurrentStockBadge">${item?.stock_qty ?? 0}</strong></span>` : ''}
            </label>
            <div style="display:flex; gap:8px; align-items:center;">
              <input class="field" id="pmStockQty" name="stock_qty" type="number" step="${item?.decimal_qty_enabled || hasCap('decimal_qty') ? '0.01' : '1'}" value="${item?.stock_qty !== undefined ? item.stock_qty : 0}" style="flex:1;" title="Total Stock Quantity">
              <input class="field" id="pmAddStock" type="number" min="0" step="${item?.decimal_qty_enabled || hasCap('decimal_qty') ? '0.01' : '1'}" placeholder="+ Add New Stock" style="flex:1; border-color:#16a34a; background:rgba(22,163,74,0.06);" title="Enter quantity of new stock arrived to automatically add to current stock">
            </div>
            <small id="pmStockSummary" style="display:block; margin-top:4px; font-size:11px; color:#16a34a; min-height:16px;"></small>
          </div>
          ${hasCap('reorder_levels') ? `
            <div class="form-group">
              <label>Reorder Level (Min Stock)</label>
              <input class="field" name="reorder_level" type="number" value="${item?.reorder_level || 5}">
            </div>
          ` : ''}
          <div class="form-group">
            <label>Cost Price</label>
            <input class="field" name="cost" type="number" step="0.01" min="0" value="${item ? (item.cost_cents || 0)/100 : ''}">
          </div>
          <div class="form-group">
            <label>Selling Price (Retail) *</label>
            <input class="field" name="price" type="number" step="0.01" min="0" value="${item ? (item.price_cents || 0)/100 : ''}" required>
          </div>
          ${hasCap('wholesale_pricing') ? `
            <div class="form-group">
              <label>Wholesale Price (KES)</label>
              <input class="field" name="wholesale_price" type="number" step="0.01" min="0" value="${item?.wholesale_price_cents ? (item.wholesale_price_cents)/100 : ''}">
            </div>
          ` : ''}
          ${hasCap('batches_expiry') ? `
            <div class="form-group">
              <label>Batch Number</label>
              <input class="field" name="batch_no" value="${item?.batch_no || ''}" placeholder="e.g. BATCH-2024-01">
            </div>
            <div class="form-group">
              <label>Expiry Date</label>
              <input class="field" name="expiry_date" type="date" value="${item?.expiry_date || ''}">
            </div>
          ` : ''}
          ${hasCap('manufacturer_strength') ? `
            <div class="form-group">
              <label>Manufacturer / Brand</label>
              <input class="field" name="manufacturer" value="${item?.manufacturer || ''}" placeholder="e.g. GSK, Bayer, Nike">
            </div>
            <div class="form-group">
              <label>Strength / Dosage</label>
              <input class="field" name="strength" value="${item?.strength || ''}" placeholder="e.g. 500mg, 10ml, 50ml">
            </div>
          ` : ''}
          ${hasCap('decimal_qty') ? `
            <div class="form-group" style="grid-column: 1 / -1; display:flex; align-items:center; gap:8px;">
              <input type="checkbox" id="decimalQtyCheck" name="decimal_qty_enabled" value="1" ${item?.decimal_qty_enabled ? 'checked' : ''}>
              <label for="decimalQtyCheck" style="margin:0; cursor:pointer; font-size:13px; font-weight:600;">Allow Decimal Quantities (e.g. 1.5 kg, 2.75 m)</label>
            </div>
          ` : ''}
          ${hasCap('variants') ? `
            <div class="form-group" style="grid-column: 1 / -1;">
              <label>Product Variants (e.g. Small, Medium, Large or Shade 01, Shade 02)</label>
              <input class="field" name="variants_json" value="${item?.variants_json ? (typeof item.variants_json === 'string' ? item.variants_json : JSON.stringify(item.variants_json)) : ''}" placeholder="e.g. Small, Medium, Large">
            </div>
          ` : ''}
        </div>
        <div class="modal-actions">
          <button type="button" class="secondary" id="pmCancel">Cancel</button>
          <button type="submit" class="primary">${isEdit ? 'Save Changes' : 'Add Product'}</button>
        </div>
      </form>
    </div>
  `;
  document.body.appendChild(overlay);
  
  const close = () => overlay.remove();
  qs('#pmClose', overlay).addEventListener('click', close);
  qs('#pmCancel', overlay).addEventListener('click', close);
  
  window.OraforgeFormControls.searchableSelect(overlay.querySelector('[name=category_id]'),null,'product categories');
  const imgUpload = qs('#imgUpload', overlay);
  const imgPreview = qs('#imgPreview', overlay);
  const imgBase64 = qs('#imgBase64', overlay);
  const imgUrlInput = qs('#imgUrlInput', overlay);

  qs('#searchImgOnlineBtn', overlay)?.addEventListener('click', () => {
    const pName = qs('#productNameInput', overlay)?.value || item?.name || '';
    showImageSearchModal(pName, (localUrl) => {
      imgUrlInput.value = localUrl;
      imgBase64.value = '';
      imgPreview.innerHTML = `<img src="${localUrl}" style="width:100%;height:100%;object-fit:contain;padding:4px;box-sizing:border-box;">`;
    });
  });

  if (imgUpload) {
    imgUpload.addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;

      const reader = new FileReader();
      reader.onload = ev => {
        const img = new Image();
        img.onload = () => {
          const MAX = 400;
          let w = img.width, h = img.height;
          if (w > h) { if (w > MAX) { h = Math.round(h * MAX / w); w = MAX; } }
          else        { if (h > MAX) { w = Math.round(w * MAX / h); h = MAX; } }
          const canvas = document.createElement('canvas');
          canvas.width = w; canvas.height = h;
          canvas.getContext('2d').drawImage(img, 0, 0, w, h);
          const compressed = canvas.toDataURL('image/jpeg', 0.75);
          imgBase64.value = compressed;
          imgPreview.innerHTML = `<img src="${compressed}" style="width:100%;height:100%;object-fit:contain;padding:4px;box-sizing:border-box;">`;
        };
        img.src = ev.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  overlay.querySelector('#pmScanBarcodeBtn')?.addEventListener('click', () => {
    showBarcodeModal('product', (code) => {
      const bInput = overlay.querySelector('#pmBarcodeInput');
      if (bInput) {
        bInput.value = code;
        toast(`Scanned barcode: ${code}`, 'success');
      }
    });
  });

  overlay.querySelector('#pmGenBarcodeBtn')?.addEventListener('click', () => {
    const randomEan = '616' + Math.floor(100000000 + Math.random() * 900000000);
    const bInput = overlay.querySelector('#pmBarcodeInput');
    if (bInput) {
      bInput.value = randomEan;
      toast(`Generated barcode: ${randomEan}`, 'info');
    }
  });

  const pmStockInput = overlay.querySelector('#pmStockQty');
  const pmAddStock = overlay.querySelector('#pmAddStock');
  const pmStockSummary = overlay.querySelector('#pmStockSummary');
  let baseStock = Number(item?.stock_qty !== undefined ? item.stock_qty : 0);

  if (pmAddStock && pmStockInput) {
    const updateSum = () => {
      const added = parseFloat(pmAddStock.value);
      if (!isNaN(added) && added > 0) {
        const total = Math.round((baseStock + added) * 100) / 100;
        pmStockInput.value = total;
        if (pmStockSummary) {
          pmStockSummary.innerHTML = `⚡ Adding <strong>+${added}</strong> new stock: ${baseStock} + ${added} = <strong>${total}</strong>`;
        }
      } else {
        pmStockInput.value = baseStock;
        if (pmStockSummary) pmStockSummary.textContent = '';
      }
    };
    pmAddStock.addEventListener('input', updateSum);
    pmAddStock.addEventListener('change', updateSum);

    pmStockInput.addEventListener('input', () => {
      baseStock = parseFloat(pmStockInput.value) || 0;
      pmAddStock.value = '';
      if (pmStockSummary) pmStockSummary.textContent = '';
      const badge = overlay.querySelector('#pmCurrentStockBadge');
      if (badge) badge.textContent = baseStock;
    });
  }

  qs('#pmForm', overlay).addEventListener('submit', async e => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.target));
    if (isEdit) data.id = item.id;
    if (item) {
      data.color = item.color;
      data.active = item.active;
    }
    const payload = await api('/api/menu/item', { method: 'POST', body: data });
    state.categories = payload.categories;
    state.items = payload.items;
    close();
    renderProductAdmin();
  });
}

// ── Stock Page (replaces Kitchen) ────────────────────────────────────────────
let stockSearch = '';
let stockFilter = 'all'; // all, low, in_stock

async function renderStock() {
  const root = qs('[data-page="stock"]');
  const allItems = (await api('/api/stock')).filter(tracksStock);
  
  const lowStockCount = allItems.filter(i => (i.stock_qty || 0) <= 5).length;
  
  const filteredItems = allItems.filter(item => {
    const matchesSearch = item.name.toLowerCase().includes(stockSearch.toLowerCase()) || 
                          (item.sku && item.sku.toLowerCase().includes(stockSearch.toLowerCase()));
    
    let matchesFilter = true;
    if (stockFilter === 'low') matchesFilter = (item.stock_qty || 0) <= 5;
    if (stockFilter === 'in_stock') matchesFilter = (item.stock_qty || 0) > 5;
    
    return matchesSearch && matchesFilter;
  });

  root.innerHTML = `
    <div class="panel-head">
      <div class="panel-title-group">
        <h2>Stock Levels</h2>
      </div>
      <button class="primary" id="refreshStock">Refresh</button>
    </div>
    
    <div class="toolbar stock-toolbar">
      <div class="filter-pills">
        <button class="pill ${stockFilter === 'all' ? 'active' : ''}" data-filter="all">All Inventory</button>
        <button class="pill alert-pill ${stockFilter === 'low' ? 'active' : ''}" data-filter="low">
          Low Stock Alert <span class="pill-badge">${lowStockCount}</span>
        </button>
        <button class="pill ${stockFilter === 'in_stock' ? 'active' : ''}" data-filter="in_stock">In Stock</button>
      </div>
      <div class="search-bar">
        <span class="search-icon">🔍</span>
        <input type="text" class="field search-field" id="stockSearchInput" placeholder="Search by name or SKU..." value="${stockSearch}">
      </div>
    </div>

    <div class="content-grid stock-grid">
      ${filteredItems.map(item => {
        const low = (item.stock_qty || 0) <= 5;
        return `
          <article class="stock-card ${low ? 'low-stock' : 'in-stock'}" data-id="${item.id}">
            <div class="card-header">
              <span class="badge status-badge">${low ? 'LOW STOCK' : 'In Stock'}</span>
              <span class="category-text">${categoryName(item.category_id)}</span>
            </div>
            <strong>${item.name}</strong>
            ${item.sku ? `<small class="sku-text">SKU: ${item.sku}</small>` : '<small class="sku-text">No SKU</small>'}
            
            <div class="stock-display">
              <span class="stock-value">${item.stock_qty || 0}</span>
              <span class="stock-unit">${item.unit || 'pcs'}</span>
            </div>
            
            <div class="card-footer">
              ${low ? `
                <button class="danger restock-btn" data-id="${item.id}">Restock / Reorder</button>
              ` : `
                <div class="inline-adjust">
                  <button class="adjust-btn minus" data-id="${item.id}">−</button>
                  <span class="adjust-label">Adjust</span>
                  <button class="adjust-btn plus" data-id="${item.id}">+</button>
                </div>
              `}
            </div>
          </article>
        `;
      }).join('') || '<div class="empty">No products match your criteria</div>'}
    </div>
  `;
  
  qs('#refreshStock')?.addEventListener('click', renderStock);
  
  const stInp = qs('#stockSearchInput');
  if (stInp) {
    stInp.addEventListener('input', e => {
      stockSearch = e.target.value;
      renderStock();
      const inp = qs('#stockSearchInput');
      inp.focus();
      inp.selectionStart = inp.selectionEnd = inp.value.length;
    });
  }

  qsa('.pill', root).forEach(btn => {
    btn.addEventListener('click', () => {
      stockFilter = btn.dataset.filter;
      renderStock();
    });
  });

  // Adjust actions
  qsa('.adjust-btn', root).forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const isPlus = btn.classList.contains('plus');
      const change = isPlus ? 1 : -1;
      
      try {
        await api('/api/stock/adjust', {
          method: 'POST',
          body: { product_id: id, qty_change: change, reason: 'inline_adjustment' }
        });
        await bootstrap(); // refresh global catalog
        renderStock();
      } catch (err) {
        alert('Failed to adjust stock. Ensure you have manager privileges.');
      }
    });
  });

  qsa('.restock-btn', root).forEach(btn => {
    btn.addEventListener('click', () => {
      alert('Restock request recorded for product ID: ' + btn.dataset.id);
    });
  });
}

// ── Reports ───────────────────────────────────────────────────────────────────
async function renderReports(period = 'today') {
  const root = qs('[data-page="reports"]');
  const report = await api(`/api/reports?period=${period}`);
  
  const profit = report.totals.sales - report.totals.costs;
  const margin = report.totals.sales > 0 ? Math.round((profit / report.totals.sales) * 100) : 0;
  
  let mpesaTotal = 0;
  let cashTotal = 0;
  if (report.payments) {
    report.payments.forEach(p => {
      if (p.method === 'mpesa') mpesaTotal += p.amount;
      else cashTotal += p.amount;
    });
  }

  root.innerHTML = `
    <div class="panel-title-group" style="margin: 0 24px 20px; padding-top: 24px; display: flex; justify-content: space-between; align-items: center;">
      <div><h2 style="margin:0">Business Analytics</h2><div style="font-size:12px;color:var(--muted);margin-top:4px;">${report.range?.label || 'Selected period'} · ${state.profile?.name || 'POS'}</div></div>
      <div style="display:flex; gap: 8px;">
        <select id="reportPeriod" class="field" style="padding: 6px 12px; height: 36px;">
          <option value="today" ${period === 'today' ? 'selected' : ''}>Today</option>
          <option value="yesterday" ${period === 'yesterday' ? 'selected' : ''}>Yesterday</option>
          <option value="week" ${period === 'week' ? 'selected' : ''}>Last 7 Days</option>
          <option value="month" ${period === 'month' ? 'selected' : ''}>Last 30 Days</option>
        </select>
        <button class="add-btn" id="printReportBtn">Print Z-Report</button>
      </div>
    </div>
    
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 20px; margin: 0 24px 24px;">
      <div class="report-stat-card">
        <div style="font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase;">Gross Revenue</div>
        <div style="font-size: 28px; font-weight: 800; color: var(--ink); margin-top: 8px;">${money(report.totals.sales)}</div>
        <div style="font-size: 13px; color: var(--muted); margin-top: 4px;">From ${report.totals.orders} sales</div>
      </div>
      <div class="report-stat-card">
        <div style="font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase;">Gross Profit</div>
        <div style="font-size: 28px; font-weight: 800; color: var(--ok); margin-top: 8px;">${money(profit)}</div>
        <div style="font-size: 13px; color: var(--muted); margin-top: 4px;">Realized Margin: ${margin}%</div>
      </div>
      <div class="report-stat-card">
        <div style="font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase;">Inventory Value</div>
        <div style="font-size: 28px; font-weight: 800; color: var(--info); margin-top: 8px;">${money(report.stock?.inventory_value || 0)}</div>
        <div style="font-size: 13px; color: var(--muted); margin-top: 4px;">Potential Profit: ${money(report.stock?.potential_profit || 0)}</div>
      </div>
      <div class="report-stat-card">
        <div style="font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase;">Cash Sales</div>
        <div style="font-size: 28px; font-weight: 800; color: var(--ok); margin-top: 8px;">${money(cashTotal)}</div>
      </div>
      <div class="report-stat-card">
        <div style="font-size: 12px; font-weight: 700; color: var(--muted); text-transform: uppercase;">M-Pesa Sales</div>
        <div style="font-size: 28px; font-weight: 800; color: var(--ok); margin-top: 8px;">${money(mpesaTotal)}</div>
      </div>
    </div>
    
    <div class="sales-table-container">
      <div style="padding: 16px 20px; font-weight: 700; font-size: 12px; color: var(--muted); text-transform: uppercase; border-bottom: 1px solid var(--line); background: var(--surface-soft);">TOP MOVERS (BY REVENUE)</div>
      <table class="sales-table" style="border-top: none;">
        <thead>
          <tr>
            <th>Product Name</th>
            <th style="text-align: right">Qty Sold</th>
            <th style="text-align: right">Revenue Generated</th>
            <th style="text-align: right">Current Stock Left</th>
          </tr>
        </thead>
        <tbody>
          ${(report.top_items || []).map(item => `
            <tr class="sales-row">
              <td><strong>${item.name}</strong></td>
              <td style="text-align: right">${item.qty}</td>
              <td style="text-align: right; font-weight: 700; color: var(--primary-dark)">${money(item.sales)}</td>
              <td style="text-align: right">
                <span class="pay-badge report-stock-status ${item.current_stock > 10 ? '' : 'low'}">
                  ${item.current_stock || 0} left
                </span>
              </td>
            </tr>
          `).join('') || `<tr><td colspan="4" class="empty" style="text-align:center; padding: 40px;">No sales data for this period</td></tr>`}
        </tbody>
      </table>
    </div>
  `;
  
  qs('#reportPeriod').addEventListener('change', (e) => renderReports(e.target.value));
  qs('#printReportBtn').addEventListener('click', () => {
    const printWindow = window.open('', '_blank');
    printWindow.document.write(`
      <html><head><style>
        body { font-family: monospace; font-size: 12px; margin: 0; padding: 20px; width: 300px; }
        .text-center { text-align: center; }
        .flex { display: flex; justify-content: space-between; margin-bottom: 4px; }
        h2 { margin: 0 0 5px 0; font-size: 16px; }
        hr { border-top: 1px dashed black; border-bottom: none; margin: 10px 0; }
      </style></head><body>
        <div class="text-center">
          <h2>${state.settings?.business_name || state.profile?.name || 'POS'}</h2>
          <p style="margin:0">Z-REPORT · ${report.range?.label || period.toUpperCase()}</p>
        </div>
        <hr>
        <div class="flex"><span>TOTAL SALES:</span> <strong>${money(report.totals.sales)}</strong></div>
        <div class="flex"><span>GROSS PROFIT:</span> <strong>${money(profit)}</strong></div>
        <div class="flex"><span>PROFIT MARGIN:</span> <strong>${margin}%</strong></div>
        <hr>
        <div class="flex"><span>M-PESA TOTAL:</span> <span>${money(mpesaTotal)}</span></div>
        <div class="flex"><span>CASH TOTAL:</span> <span>${money(cashTotal)}</span></div>
        <hr>
        <div class="text-center"><p>Printed: ${new Date().toLocaleString()}</p></div>
        <script>window.print(); window.close();</script>
      </body></html>
    `);
  });
}

function categoryName(id) {
  return state.categories.find(c => c.id === id)?.name || 'Products';
}

// ── Settings Page ─────────────────────────────────────────────────────────────
async function renderSettings() {
  const root = qs('[data-page="settings"]');
  if (!root) return;

  const settingsText = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const activeType = state.settings?.business_type || 'bar';
  const curTheme = document.documentElement.getAttribute('data-theme') || localStorage.getItem('pos_theme') || 'light';

  root.innerHTML = `
    <div class="settings-container" style="max-width: 1040px; margin: 0 auto; padding: 24px;">
      <div class="settings-header" style="margin-bottom: 24px;">
        <h2 style="font-size:26px; font-weight:800; color:var(--ink); margin:0 0 6px;">Business Settings</h2>
        <p style="color:var(--muted); font-size:14px; margin:0;">
          Manage this shop's appearance, receipt and business details. The shop category is selected only when you log in.
        </p>
      </div>

      <!-- ── Appearance & Theme Preference ────────────────────────────────── -->
      <div class="settings-section" style="background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:24px; margin-bottom:24px;">
        <div class="section-title" style="display:flex; align-items:center; justify-content:space-between; margin-bottom:14px;">
          <div style="display:flex; align-items:center; gap:8px;">
            <span style="font-size:24px;">🎨</span>
            <div>
              <h3 style="margin:0; font-size:18px; color:var(--ink); font-weight:700;">Appearance & Theme</h3>
              <span style="font-size:13px; color:var(--muted);">Select your preferred display theme</span>
            </div>
          </div>
          <span style="background:var(--bg); color:var(--ink); font-size:12px; font-weight:700; padding:4px 12px; border-radius:20px; border:1px solid var(--line);">
            Active: ${curTheme === 'dark' ? '🌙 Dark Mode' : '☀️ Light Mode'}
          </span>
        </div>

        <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:16px;">
          <!-- Light Theme Card -->
          <div id="themeCardLight" class="theme-card ${curTheme === 'light' ? 'selected' : ''}" style="background:#ffffff; border:2px solid ${curTheme === 'light' ? '#18181b' : '#e4e4e7'}; border-radius:12px; padding:18px; cursor:pointer; transition:all 0.2s ease; box-shadow: ${curTheme === 'light' ? '0 0 0 1px #18181b, 0 4px 12px rgba(0,0,0,0.06)' : '0 1px 3px rgba(0,0,0,0.05)'};">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:30px;">☀️</span>
                <div>
                  <h4 style="margin:0; font-size:16px; font-weight:700; color:#09090b;">Light Theme (Default)</h4>
                  <span style="font-size:12px; color:#71717a;">Clean, high-contrast, modern POS</span>
                </div>
              </div>
              ${curTheme === 'light' ? '<span style="background:#18181b; color:#ffffff; font-size:11px; font-weight:800; padding:3px 9px; border-radius:12px;">ACTIVE</span>' : ''}
            </div>
            <p style="font-size:12px; color:#71717a; margin:4px 0 14px; line-height:1.4;">
              Crisp white surfaces, deep solid black typography, and neutral grey borders. Clean, fast, and high-contrast.
            </p>
            <button type="button" style="width:100%; font-size:12px; font-weight:700; padding:10px; border-radius:8px; cursor:pointer; border:1px solid ${curTheme === 'light' ? '#18181b' : '#e4e4e7'}; background:${curTheme === 'light' ? '#18181b' : '#f4f4f5'}; color:${curTheme === 'light' ? '#ffffff' : '#09090b'}; transition:all 0.15s ease;">
              ${curTheme === 'light' ? '✓ Currently Active' : 'Switch to Light Theme'}
            </button>
          </div>

          <!-- Dark Theme Card -->
          <div id="themeCardDark" class="theme-card ${curTheme === 'dark' ? 'selected' : ''}" style="background:#18181b; border:2px solid ${curTheme === 'dark' ? '#ffffff' : '#27272a'}; border-radius:12px; padding:18px; cursor:pointer; transition:all 0.2s ease; box-shadow: ${curTheme === 'dark' ? '0 0 0 1px #ffffff, 0 8px 24px rgba(0,0,0,0.5)' : '0 4px 12px rgba(0,0,0,0.3)'};">
            <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
              <div style="display:flex; align-items:center; gap:10px;">
                <span style="font-size:30px;">🌙</span>
                <div>
                  <h4 style="margin:0; font-size:16px; font-weight:700; color:#fafafa;">Dark Theme</h4>
                  <span style="font-size:12px; color:#a1a1aa;">Zinc & charcoal dark mode</span>
                </div>
              </div>
              ${curTheme === 'dark' ? '<span style="background:#ffffff; color:#09090b; font-size:11px; font-weight:800; padding:3px 9px; border-radius:12px;">ACTIVE</span>' : ''}
            </div>
            <p style="font-size:12px; color:#a1a1aa; margin:4px 0 14px; line-height:1.4;">
              Deep zinc and pure black surfaces with crisp white text. No purple tints, built for low-light night shifts.
            </p>
            <button type="button" style="width:100%; font-size:12px; font-weight:700; padding:10px; border-radius:8px; cursor:pointer; border:1px solid ${curTheme === 'dark' ? '#ffffff' : '#3f3f46'}; background:${curTheme === 'dark' ? '#ffffff' : '#27272a'}; color:${curTheme === 'dark' ? '#09090b' : '#fafafa'}; transition:all 0.15s ease;">
              ${curTheme === 'dark' ? '✓ Currently Active' : 'Switch to Dark Theme'}
            </button>
          </div>
        </div>
      </div>

      <form id="settingsForm" class="settings-section" style="background:var(--panel); border:1px solid var(--line); border-radius:12px; padding:24px; margin-bottom:24px;">
        <div class="section-title" style="display:flex; align-items:center; gap:8px; margin-bottom:16px;">
          <span style="font-size:22px;">🏪</span>
          <h3 style="margin:0; font-size:18px; color:var(--ink); font-weight:700;">Store Information & Receipt Settings</h3>
        </div>

        <input type="hidden" name="business_type" id="settingsBusinessType" value="${activeType}">

        <div class="form-grid" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:16px;">
          <div class="form-group">
            <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--muted);">Store / Business Name *</label>
            <input class="field" name="business_name" id="settingsBusinessName" value="${settingsText(state.settings?.business_name || '')}" required style="width:100%;">
          </div>
          <div class="form-group">
            <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--muted);">Tagline / Subtitle</label>
            <input class="field" name="business_tagline" value="${settingsText(state.settings?.business_tagline || '')}" style="width:100%;">
          </div>
          <div class="form-group">
            <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--muted);">Mobile / Contact Number</label>
            <input class="field" name="phone" value="${settingsText(state.settings?.phone || '')}" style="width:100%;">
          </div>
          <div class="form-group">
            <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--muted);">Store Address</label>
            <input class="field" name="address" value="${settingsText(state.settings?.address || '')}" autocomplete="street-address" maxlength="180" style="width:100%;">
          </div>
          <div class="form-group">
            <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--muted);">Business Email</label>
            <input class="field" name="email" type="email" autocomplete="email" maxlength="120" placeholder="e.g. hello@yourshop.co.ke" value="${settingsText(state.settings?.email || '')}" style="width:100%;">
          </div>
          <div class="form-group">
            <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--muted);">Business KRA PIN (optional)</label>
            <input class="field" name="kra_pin" maxlength="20" autocapitalize="characters" placeholder="Enter your registered business PIN" value="${settingsText(state.settings?.kra_pin || '')}" style="width:100%;">
          </div>
          <p style="grid-column:1/-1; margin:0; font-size:12px; line-height:1.5; color:var(--muted);">These details appear on printed receipts when provided. A PIN does not make a POS receipt an eTIMS tax invoice.</p>
          <div class="form-group">
            <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--muted);">Currency Code</label>
            <input class="field" name="currency" value="${settingsText(state.settings?.currency || 'KES')}" style="width:100%;">
          </div>
          <div class="form-group">
            <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--muted);">Tax Rate % (VAT)</label>
            <input class="field" name="tax_rate" type="number" step="0.1" value="${state.settings?.tax_rate ?? 0}" style="width:100%;">
          </div>
          <div class="form-group" style="grid-column: 1 / -1;">
            <label style="display:block; font-size:13px; font-weight:600; margin-bottom:6px; color:var(--muted);">Receipt Footer Note</label>
            <textarea class="field" name="receipt_footer" rows="2" style="width:100%; padding:8px;">${settingsText(state.settings?.receipt_footer || '')}</textarea>
          </div>
        </div>

        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:24px; padding-top:16px; border-top:1px solid var(--line); flex-wrap:wrap; gap:12px;">
          <button type="submit" class="primary" id="saveSettingsBtn" style="padding:10px 24px; font-weight:700;">
            Save Store Info
          </button>
        </div>
      </form>
    </div>
  `;

  await window.OraforgeOperations.backupUI(root.querySelector(".settings-container"));

  // Theme switch handlers
  const setTheme = (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('pos_theme', theme);
    const themeBtn = qs('#themeToggleBtn');
    if (themeBtn) {
      themeBtn.textContent = theme === 'dark' ? '☀️' : '🌙';
      themeBtn.title = theme === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme';
    }
    renderSettings();
  };

  qs('#themeCardLight', root)?.addEventListener('click', () => setTheme('light'));
  qs('#themeCardDark', root)?.addEventListener('click', () => setTheme('dark'));

  // Settings form submission
  qs('#settingsForm', root)?.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = qs('#saveSettingsBtn', root);
    btn.disabled = true;
    btn.textContent = 'Saving...';

    const fd = new FormData(e.target);
    const data = Object.fromEntries(fd.entries());

    try {
      const updated = await api('/api/settings', { method: 'POST', body: data });
      state.settings = updated.settings;
      state.profile = updated.profile;
      state.capabilities = updated.capabilities;
      toast('Store settings saved successfully!', 'success');
      await bootstrap();
      updateHeaderAndNav();
      await renderSettings();
    } catch (err) {
      toast(err.message, 'error');
      btn.disabled = false;
      btn.textContent = 'Save Store Info';
    }
  });
}

let bootstrapped = false;

async function renderPage(pageDef) {
  // Swap the <main> content
  const main = qs('main');
  if (!main) return;
  main.innerHTML = `<section class="${pageDef.shell}" data-page="${pageDef.page}"></section>`;

  // Update page title
  const storeName = state.settings?.business_name || 'POS System';
  document.title = `${pageDef.title} — ${storeName}`;

  // Update active nav link
  qsa('.nav-link').forEach(link => {
    const rawHref = link.getAttribute('href') || '';
    const linkPath = new URL(rawHref, window.location.origin).pathname.replace(/\/+$/, '') || '/';
    const active = linkPath === `/${pageDef.page}` || (pageDef.page === 'pos' && (linkPath === '/pos' || linkPath === '/' || linkPath === '/index.html'));
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  // Bootstrap data once (categories, items, user)
  if (!bootstrapped) {
    await bootstrap();
    bootstrapped = true;
  }

  // Render the page content
  const p = pageDef.page;
  if (p === 'pos')       posLayout();
  if (p === 'suppliers') await renderSuppliers();
  if (p === 'sales')     await renderSales();
  if (p === 'cashier')   await renderCashier();
  if (p === 'products')  renderProductAdmin();
  if (p === 'stock')     await renderStock();
  if (p === 'reports')   await renderReports();
  if (p === 'settings')  await renderSettings();
}

async function navigateTo(path, pushState = true) {
  if (typeof window.closeMobileNav === 'function') {
    window.closeMobileNav();
  }
  const pageDef = SPA_PAGES[path];
  if (!pageDef) { location.href = path; return; }
  if (pushState) history.pushState(null, '', path);
  await renderPage(pageDef);
}

function initSPARouter() {
  // Intercept all nav-link clicks
  document.addEventListener('click', (e) => {
    const link = e.target.closest('a.nav-link, a.brand');
    if (!link) return;
    const href = link.getAttribute('href');
    if (href && SPA_PAGES[href]) {
      e.preventDefault();
      navigateTo(href);
    }
  });

  // Handle browser back/forward
  window.addEventListener('popstate', () => {
    const path = location.pathname;
    if (SPA_PAGES[path]) {
      navigateTo(path, false);
    }
  });
}


// ── Staff Login Screen (Category Selection & PIN Verification) ─────────────────
function showLoginScreen() {
  let screen = qs('#posLoginScreen');
  if (screen) screen.remove();

  let selectedShop = localStorage.getItem('pos_active_business_type') || 'retail';

  const renderChips = () => {
    return SHOP_PROFILES.map(p => {
      const isSel = p.id === selectedShop;
      return `
        <button type="button" class="login-shop-chip" data-id="${p.id}" style="${isSel ? 'background:var(--primary); color:var(--primary-fg); border:1px solid var(--primary); font-weight:700; box-shadow:0 1px 3px rgba(0,0,0,0.15);' : 'background:var(--panel); color:var(--ink); border:1px solid var(--line);'} padding:10px 12px; border-radius:8px; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:8px; text-align:left; transition:all 0.15s ease;">
          <span style="font-size:20px;">${p.icon}</span>
          <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${p.name}${isSel ? ' ✓' : ''}</span>
        </button>
      `;
    }).join('');
  };

  const activeProf = SHOP_PROFILES.find(p => p.id === selectedShop) || SHOP_PROFILES[0];

  screen = document.createElement('div');
  screen.id = 'posLoginScreen';
  screen.className = 'login-body';
  screen.style.cssText = 'position:fixed; inset:0; z-index:999999; background:var(--login-bg); display:grid; place-items:center; overflow-y:auto; padding:16px;';
  screen.innerHTML = `
    <div style="position:fixed; top:18px; right:18px; z-index:1000000;">
      <button id="loginThemeToggle" class="theme-toggle-btn" style="width:40px; height:40px; font-size:18px;" title="Toggle Light / Dark theme">☀️</button>
    </div>

    <div class="login-panel" style="width:min(440px, 100%); background:var(--panel); border:1px solid var(--line); border-radius:14px; box-shadow:var(--shadow-lg); padding:24px; display:grid; gap:12px;">
      <div style="display:flex; align-items:center; gap:12px; margin-bottom:4px;">
        <div id="loginHeaderIcon" style="width:48px; height:48px; border-radius:12px; background:var(--ink); display:grid; place-items:center; font-size:26px; flex-shrink:0; box-shadow:0 2px 8px rgba(0,0,0,0.15); color:var(--panel);">
          ${activeProf.icon}
        </div>
        <div>
          <h1 id="loginHeaderTitle" style="margin:0; font-size:21px; font-weight:800; color:var(--ink);">${activeProf.name} POS</h1>
          <p id="loginHeaderTag" style="margin:2px 0 0; color:var(--muted); font-size:12px;">${activeProf.tagline}</p>
        </div>
      </div>

      <div style="background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:12px;">
        <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
          <span style="font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">🏢 Select Shop Category</span>
          <span style="font-size:11px; color:var(--muted); font-weight:600;">Choose before login</span>
        </div>
        <div id="loginChipsContainer" style="display:grid; grid-template-columns:repeat(2, 1fr); gap:6px;">
          ${renderChips()}
        </div>
      </div>

      <p id="loginErrorMsg" style="display:none; color:var(--danger); font-size:12px; font-weight:700; margin:0; text-align:center;"></p>

      <button type="button" id="loginDemoBtn" style="width:100%; padding:12px; background:var(--primary); color:var(--primary-fg); border-radius:8px; font-weight:700; font-size:14px; border:1px solid var(--primary); cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 2px 8px rgba(0,0,0,0.1);">
        <span>⚡</span> 1-Click Demo Login (PIN: 1234)
      </button>

      <div style="display:flex; align-items:center; gap:10px; margin:2px 0;">
        <div style="flex:1; height:1px; background:var(--line);"></div>
        <span style="font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">or enter pin on keypad</span>
        <div style="flex:1; height:1px; background:var(--line);"></div>
      </div>

      <input id="loginPinInput" type="password" inputmode="numeric" pattern="[0-9]*" value="" placeholder="Staff PIN" style="text-align:center; font-size:22px; letter-spacing:4px; font-weight:700; width:100%; padding:11px 12px; border:1px solid var(--line); border-radius:6px; background:var(--panel); color:var(--ink);">

      <div class="pin-pad" id="loginPinPad" style="display:grid; grid-template-columns:repeat(3, 1fr); gap:9px;">
        <button type="button" data-key="1">1</button>
        <button type="button" data-key="2">2</button>
        <button type="button" data-key="3">3</button>
        <button type="button" data-key="4">4</button>
        <button type="button" data-key="5">5</button>
        <button type="button" data-key="6">6</button>
        <button type="button" data-key="7">7</button>
        <button type="button" data-key="8">8</button>
        <button type="button" data-key="9">9</button>
        <button type="button" data-key="clear">Clear</button>
        <button type="button" data-key="0">0</button>
        <button type="button" data-key="enter" style="background:var(--primary); color:var(--primary-fg); border-color:var(--primary); font-size:16px;">Enter</button>
      </div>

      <div style="border-top:1px solid var(--line); margin-top:6px; padding-top:10px; display:flex; justify-content:space-between; align-items:center;">
        <small style="color:var(--muted); font-size:12px;">Staff PIN: <strong>1234</strong></small>
        <a href="admin.html" style="display:inline-flex; align-items:center; gap:6px; font-size:12px; font-weight:700; color:var(--ink); background:var(--bg); border:1px solid var(--line); padding:6px 12px; border-radius:6px; text-decoration:none;">
          <span>👑</span> Admin Portal →
        </a>
      </div>
    </div>
  `;
  document.body.appendChild(screen);

  // Setup theme toggle
  const loginTheme = qs('#loginThemeToggle', screen);
  if (loginTheme) {
    const curTheme = document.documentElement.getAttribute('data-theme') || 'light';
    loginTheme.textContent = curTheme === 'dark' ? '☀️' : '🌙';
    loginTheme.onclick = () => {
      const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('pos_theme', next);
      loginTheme.textContent = next === 'dark' ? '☀️' : '🌙';
    };
  }

  // Setup category chip selection
  const bindChips = () => {
    qsa('.login-shop-chip', screen).forEach(btn => {
      btn.onclick = () => {
        selectedShop = btn.dataset.id;
        localStorage.setItem('pos_active_business_type', selectedShop);
        const prof = SHOP_PROFILES.find(p => p.id === selectedShop);
        if (prof) {
          qs('#loginHeaderIcon', screen).textContent = prof.icon;
          qs('#loginHeaderTitle', screen).textContent = prof.name + ' POS';
          qs('#loginHeaderTag', screen).textContent = prof.tagline;
        }
        qs('#loginChipsContainer', screen).innerHTML = renderChips();
        bindChips();
      };
    });
  };
  bindChips();

  const pinInput = qs('#loginPinInput', screen);
  const doLogin = async (pin) => {
    const errEl = qs('#loginErrorMsg', screen);
    if (pin !== '1234' && pin.length < 4) {
      if (errEl) { errEl.textContent = 'Invalid PIN. Use default: 1234'; errEl.style.display = 'block'; }
      return;
    }

    localStorage.setItem('pos_logged_in', 'true');
    localStorage.setItem('pos_active_business_type', selectedShop);

    await LocalPOS.switchProfile(selectedShop);

    screen.remove();
    await bootstrap();
    updateHeaderAndNav();
    posLayout();
    initSPARouter();
  };

  qs('#loginDemoBtn', screen).onclick = () => doLogin('1234');

  qsa('#loginPinPad button', screen).forEach(b => {
    b.onclick = () => {
      const k = b.dataset.key;
      if (k === 'clear') pinInput.value = '';
      else if (k === 'enter') doLogin(pinInput.value);
      else if (pinInput.value.length < 8) pinInput.value += k;
      pinInput.focus();
    };
  });

  pinInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      doLogin(pinInput.value);
    }
  });
}

// ── Entry Point ───────────────────────────────────────────────────────────────
async function start() {
  if (location.pathname.replace(/\/+$/, '') === '/shifts') history.replaceState(null, '', '/pos');
  if (localStorage.getItem('pos_logged_in') !== 'true') {
    showLoginScreen();
    return;
  }
  const currentPath = (location.pathname || '').replace(/\/+$/, '') || '/pos';
  const initialPageDef = SPA_PAGES[currentPath];
  if (initialPageDef) {
    const main = qs('main');
    if (main) main.innerHTML = `<section class="${initialPageDef.shell}" data-page="${initialPageDef.page}"></section>`;
    syncActiveTopNav(currentPath);
  }
  const page = initialPageDef ? initialPageDef.page : (pageName() || 'pos');
  await bootstrap();
  bootstrapped = true;
  if (page === 'pos')       posLayout();
  if (page === 'suppliers') await renderSuppliers();
  if (page === 'sales')     await renderSales();
  if (page === 'cashier')   await renderCashier();
  if (page === 'products')  renderProductAdmin();
  if (page === 'stock')     await renderStock();
  if (page === 'reports')   await renderReports();
  if (page === 'settings')  await renderSettings();

  // Initialize SPA router after first page render
  initSPARouter();
}

start().catch(renderShellError);

function operationsDialog(title) {
  const d = document.createElement('dialog');
  d.style = 'width:min(560px,90vw);max-height:85vh;overflow:auto;background:var(--panel);color:var(--text);border:1px solid var(--line);border-radius:12px;padding:24px';
  const heading = document.createElement('h2'); heading.textContent = title; d.append(heading);
  const close = document.createElement('button'); close.textContent = 'Close'; close.className = 'secondary'; close.onclick = () => d.close(); d.append(close);
  d.addEventListener('close', () => d.remove()); document.body.append(d); d.showModal(); return d;
}
function showDiscountEditor() {
  const d = operationsDialog('Sale discount'), form = document.createElement('form');
  form.style = 'display:grid;gap:12px;margin-top:16px';
  form.innerHTML = '<label>Discount type<select name="type" class="field"><option value="percent">Percentage (%)</option><option value="fixed">Amount (KES)</option></select></label><label>Discount value (0 removes discount)<input name="value" class="field" type="number" min="0" step="0.01" required></label><button class="primary">Apply discount</button><p role="alert"></p>';
  form.elements.type.value = state.order.discount_type || 'percent'; form.elements.value.value = state.order.discount_value || 0;
  const orderId = state.order.id;
  form.onsubmit = async e => { e.preventDefault(); const button = form.querySelector('button'); button.disabled = true;
    try { state.order = await api('/api/order/discount', {method:'POST',body:{order_id:orderId,type:form.elements.type.value,value:form.elements.value.value}}); d.close(); renderTicket(); }
    catch(err) {form.querySelector('p').textContent = err.message;} finally {button.disabled = false;}
  }; d.append(form);
}
function showCategoryManager() {
  const d = operationsDialog('Manage categories');
  const body = document.createElement('div'); d.append(body);
  const draw = () => {
    body.replaceChildren();
    const explanation = document.createElement('p'); explanation.textContent = 'Create your shop categories here, then select them when adding products. Move products before deleting a category.'; body.append(explanation);
    const error = document.createElement('p'); error.setAttribute('role','alert');
    for (const category of [...state.categories, {id:null,name:''}]) {
      const form = document.createElement('form'); form.style = 'display:flex;gap:8px;flex-wrap:wrap;margin:12px 0';
      const input = document.createElement('input'); input.className = 'field'; input.value = category.name; input.placeholder = 'New category name'; input.required = true; input.maxLength = 80; input.setAttribute('aria-label', category.id ? 'Category name' : 'New category name'); form.append(input);
      const save = document.createElement('button'); save.className='primary'; save.textContent = category.id ? 'Rename' : 'Add'; form.append(save);
      const update = async payload => { save.disabled=true; try { const result=await api('/api/menu/category',{method:'POST',body:payload}); state.categories=result.categories; productCategoryFilter=''; renderProductAdmin(); draw(); } catch(err){error.textContent=err.message;} finally{save.disabled=false;} };
      form.onsubmit=e=>{e.preventDefault();update({id:category.id,name:input.value});};
      if(category.id){const del=document.createElement('button');del.type='button';del.className='danger';del.textContent='Delete';del.onclick=()=>{if(confirm('Delete category "'+category.name+'"?'))update({id:category.id,action:'delete'});};form.append(del);}
      body.append(form);
    }
    body.append(error);
  }; draw();
}

