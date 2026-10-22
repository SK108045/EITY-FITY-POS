const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const money = c => `KES ${(c/100).toLocaleString('en-KE', {minimumFractionDigits:2})}`;
const fmt = n => Number(n).toLocaleString('en-KE');

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

function garageUnitOptions(currentUnit = 'pcs') {
  const units = [...new Set(['pcs', 'btl', 'set', 'litre', 'service', currentUnit])];
  const escape = value => String(value).replace(/[&<>"]/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;'}[c]));
  return units.map(unit => `<option value="${escape(unit)}" ${currentUnit === unit ? 'selected' : ''}>${unit === 'service' ? 'Service / Labour (no stock)' : escape(unit)}</option>`).join('');
}

// ── STATE ──
let state = { user: null, summary: null, users: [], suppliers: [], menu: null };

// ── API ──
const ADMIN_PROFILES = {
  garage: { id:'garage', name:'Garage & Auto Spares', icon:'🚗', item_label:'Parts & Services', tagline:'Auto Parts, Repairs & Workshop POS' },
  retail: { id:'retail', name:'Retail / Mini-Mart', icon:'🛒', item_label:'Products', tagline:'Supermarket, Grocery & General Retail POS' },
  pharmacy: { id:'pharmacy', name:'Pharmacy', icon:'💊', item_label:'Medicines', tagline:'Pharmacy & Chemist POS' },
  restaurant: { id:'restaurant', name:'Restaurant / Café', icon:'🍽️', item_label:'Menu Items', tagline:'Food, Dining & Kitchen POS' },
  hardware: { id:'hardware', name:'Hardware', icon:'🔧', item_label:'Hardware Items', tagline:'Hardware, Building Materials & Tools POS' },
  boutique: { id:'boutique', name:'Boutique / Cosmetics', icon:'👗', item_label:'Apparel & Beauty', tagline:'Fashion, Beauty & Cosmetics POS' },
  bar: { id:'bar', name:'Bar / Nightclub', icon:'🍸', item_label:'Drinks & Snacks', tagline:'Bar, Lounge & Club POS' }
};

const CLOUD_API_BASE = (localStorage.getItem('pos_cloud_api_base') || 'http://3.87.19.244:5000').replace(/\/$/, '');

const LocalAdmin = {
  type() { return localStorage.getItem('pos_active_business_type') || 'retail'; },
  key(name) { return `shop:${this.type()}:${name}`; },
  async get(name, fallback) {
    const key = this.key(name);
    try {
      if (window.OraforgeDBReady) await window.OraforgeDBReady;
      if (window.OraforgeDB) return await window.OraforgeDB.get(key, fallback);
    } catch (err) { console.warn('Admin DB read fallback', err); }
    try {
      const raw = localStorage.getItem('fallback_' + key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) { return fallback; }
  },
  async set(name, value) {
    const key = this.key(name);
    try {
      if (window.OraforgeDBReady) await window.OraforgeDBReady;
      if (window.OraforgeDB) { await window.OraforgeDB.set(key, value); return; }
    } catch (err) { console.warn('Admin DB write fallback', err); }
    localStorage.setItem('fallback_' + key, JSON.stringify(value));
  },
  nextId(rows) { return (rows || []).reduce((m, r) => Math.max(m, Number(r.id || 0)), 0) + 1; },
  profile() { return ADMIN_PROFILES[this.type()] || ADMIN_PROFILES.retail; },
  async settings() {
    const p = this.profile();
    let settings = await this.get('settings', {
      business_name: p.name + ' POS', business_tagline: p.tagline, business_type: p.id,
      currency: 'KES', tax_rate: 0, tax_rate_confirmed: false,
      receipt_footer: 'Thank you for your business!'
    });
    // Older stores inherited an assumed 16% rate; only preserve explicitly
    // confirmed VAT. Do not touch products, order history, or sales totals.
    if (Number(settings.tax_rate) === 16 && settings.tax_rate_confirmed !== true) {
      settings = { ...settings, tax_rate: 0, tax_rate_confirmed: false };
      await this.set('settings', settings);
    }
    return settings;
  },
  async handle(path, opts = {}) {
    const url = new URL(path, 'https://local.pos');
    const cleanPath = url.pathname;
    const method = (opts.method || 'GET').toUpperCase();
    const body = opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body) : {};
    const profile = this.profile();
    const items = await this.get('items', []);
    const cats = await this.get('categories', []);
    const orders = await this.get('orders', []);

    if (cleanPath === '/api/bootstrap') {
      return {
        user: { id:2, username:'admin', name:'The Owner', full_name:'The Owner', role:'manager', business_type:this.type() },
        settings: await this.settings(),
        profile,
        capabilities: {},
        menu: { categories: cats, items }
      };
    }

    // Same shop-scoped orders collection used by the POS Sales History page.
    // This is intentionally read-only: viewing receipts never changes sales data.
    if (cleanPath === '/api/orders' && method === 'GET') {
      let orderList = orders;
      const shopScope = window.OraforgeShops?.activeShopId() || this.type() || 'retail';

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
              orderList = cloudOrders;
              await this.set('orders', orderList);
            }
          }
        } catch (_) {}
      }

      const status = url.searchParams.get('status');
      let rows = status ? orderList.filter(order => order.status === status) : orderList;
      rows = [...rows].sort((a, b) => parseOrderDate(b).getTime() - parseOrderDate(a).getTime());
      return window.OraforgeEtims ? window.OraforgeEtims.attach(rows) : rows;
    }
    if (cleanPath === '/api/order' && method === 'GET') {
      const orderId = Number(url.searchParams.get('id'));
      if (!Number.isSafeInteger(orderId) || orderId <= 0) throw new Error('Invalid receipt number.');
      let order = orders.find(row => Number(row.id) === orderId);

      if (!order && typeof fetch === 'function') {
        try {
          const res = await fetch(`/api/order?id=${orderId}`, { cache: 'no-store' });
          if (res.ok) order = await res.json();
        } catch (_) {}
      }

      if (!order) throw new Error('Receipt could not be found in this shop.');
      return window.OraforgeEtims ? (await window.OraforgeEtims.attach([order]))[0] : order;
    }

    if (cleanPath === '/api/admin/summary') {
      const paid = orders.filter(o => o.status === 'paid');
      const now = new Date();
      const todayKey = now.toISOString().slice(0,10);
      const dayKey = ts => new Date(Number(ts || 0) * 1000).toISOString().slice(0,10);
      const paidToday = paid.filter(o => dayKey(o.paid_at || o.updated_at) === todayKey);
      const salesToday = paidToday.reduce((s,o) => s + Number(o.total_cents || 0), 0);
      const weekStart = Math.floor((Date.now() - 6*86400000) / 1000);
      const paidWeek = paid.filter(o => Number(o.paid_at || o.updated_at || 0) >= weekStart);
      const salesWeek = paidWeek.reduce((s,o) => s + Number(o.total_cents || 0), 0);
      const itemMap = new Map();
      const employeeMap = new Map();
      const methodMap = new Map();
      for (const order of paidWeek) {
        const employee = order.employee_name || 'POS Terminal';
        const er = employeeMap.get(employee) || { employee, orders:0, sales:0 };
        er.orders += 1; er.sales += Number(order.total_cents || 0); employeeMap.set(employee, er);
        const method = order.payment_method || 'cash';
        const mr = methodMap.get(method) || { method, count:0, sales:0 };
        mr.count += 1; mr.sales += Number(order.total_cents || 0); methodMap.set(method, mr);
        for (const row of order.items || []) {
          const ir = itemMap.get(row.menu_item_id) || { name:row.name, qty:0, sales:0 };
          ir.qty += Number(row.qty || 0); ir.sales += Number(row.line_total_cents || 0); itemMap.set(row.menu_item_id, ir);
        }
      }
      const salesTrend = [];
      for (let i=6; i>=0; i--) {
        const d = new Date(); d.setDate(d.getDate()-i); const key = d.toISOString().slice(0,10);
        salesTrend.push({ day:key, sales: paidWeek.filter(o => dayKey(o.paid_at || o.updated_at) === key).reduce((s,o)=>s+Number(o.total_cents||0),0) });
      }
      const users = await this.get('users', [
        { id:1, username:'terminal', full_name:'POS Terminal', role:'cashier', active:1 },
        { id:2, username:'admin', full_name:'The Owner', role:'manager', active:1 }
      ]);
      const suppliers = await this.get('suppliers', []);
      return {
        totals: { paid_today:paidToday.length, sales_today:salesToday, unpaid_orders:orders.filter(o=>o.status==='open').length, unpaid_total:orders.filter(o=>o.status==='open').reduce((s,o)=>s+Number(o.total_cents||0),0), sales_week:salesWeek },
        counts: { active_users:users.filter(u=>Number(u.active ?? 1)).length, active_items:items.length, active_suppliers:suppliers.filter(s=>Number(s.active ?? 1)).length },
        by_employee:[...employeeMap.values()].sort((a,b)=>b.sales-a.sales),
        by_method:[...methodMap.values()],
        top_items:[...itemMap.values()].sort((a,b)=>b.sales-a.sales).slice(0,5),
        sales_trend:salesTrend
      };
    }

    if (cleanPath === '/api/admin/users' && method === 'GET') {
      return await this.get('users', [
        { id:1, username:'terminal', full_name:'POS Terminal', role:'cashier', active:1 },
        { id:2, username:'admin', full_name:'The Owner', role:'manager', active:1 }
      ]);
    }
    if (cleanPath === '/api/admin/user' && method === 'POST') {
      if (window.OraforgeShops?.activeShopId()) return window.OraforgeShops.saveUser(window.OraforgeShops.activeShopId(), body);
      const users = await this.get('users', [
        { id:1, username:'terminal', full_name:'POS Terminal', role:'cashier', active:1 },
        { id:2, username:'admin', full_name:'The Owner', role:'manager', active:1 }
      ]);
      let user = body.id ? users.find(u => u.id === Number(body.id)) : null;
      if (!user) { user = { id:this.nextId(users) }; users.push(user); }
      Object.assign(user, { username:body.username || user.username || 'staff', full_name:body.full_name || body.name || user.full_name || 'Staff', role:body.role || 'cashier', active:Number(body.active ?? 1) });
      await this.set('users', users); return users;
    }

    if (cleanPath === '/api/menu' || cleanPath === '/api/admin/menu') return { categories:cats, items };
    if (cleanPath === '/api/menu/item' && method === 'POST') {
      const products = [...items];
      let item = body.id ? products.find(i => i.id === Number(body.id)) : null;
      if (!item) { item = { id:this.nextId(products), active:1 }; products.push(item); }
      Object.assign(item, {
        category_id:Number(body.category_id || item.category_id || cats[0]?.id || 1),
        name:body.name || item.name || 'Product',
        price_cents:Math.round(Number(body.price || (Number(item.price_cents||0)/100)) * 100),
        cost_cents:Math.round(Number(body.cost || (Number(item.cost_cents||0)/100)) * 100),
        stock_qty:Number(body.stock_qty ?? item.stock_qty ?? 0),
        sku:body.sku || item.sku || '', barcode:body.barcode || item.barcode || '',
        color:body.color || item.color || '#334155', active:Number(body.active ?? item.active ?? 1),
        unit:body.unit || item.unit || 'pcs', image_url:body.image_url || item.image_url || ''
      });
      await this.set('items', products); return { categories:cats, items:products };
    }

    if (cleanPath === '/api/admin/customers' && method === 'GET') return await this.get('customers', []);
    if (cleanPath === '/api/admin/customer' && method === 'POST') {
      const customers = await this.get('customers', []);
      let customer = body.id ? customers.find(c => c.id === Number(body.id)) : null;
      if (!customer) { customer = { id:this.nextId(customers) }; customers.push(customer); }
      Object.assign(customer, { name:body.name || customer.name || 'Customer', phone:body.phone || '', email:body.email || '', notes:body.notes || '' });
      await this.set('customers', customers); return customers;
    }

    if (cleanPath === '/api/admin/suppliers' || cleanPath === '/api/suppliers') return await this.get('suppliers', []);
    if (cleanPath === '/api/admin/supplier' && method === 'POST') {
      const suppliers = await this.get('suppliers', []);
      let supplier = body.id ? suppliers.find(s => s.id === Number(body.id)) : null;
      if (!supplier) { supplier = { id:this.nextId(suppliers) }; suppliers.push(supplier); }
      Object.assign(supplier, { name:body.name || supplier.name || 'Supplier', phone:body.phone || '', email:body.email || '', address:body.address || '', active:Number(body.active ?? 1) });
      await this.set('suppliers', suppliers); return suppliers;
    }

    if (cleanPath === '/api/stock') return items.filter(i => i.unit !== 'service');
    if (cleanPath === '/api/stock/adjust' && method === 'POST') {
      const product = items.find(i => i.id === Number(body.product_id));
      if (!product) throw new Error('Product not found');
      product.stock_qty = Math.max(0, Number(product.stock_qty || 0) + Number(body.qty_change || 0));
      await this.set('items', items); return { ok:true, item:product };
    }

    if (cleanPath === '/api/settings' && method === 'GET') return { settings:await this.settings(), profile };
    if (cleanPath === '/api/admin/promotions') return { promotions:[], campaigns:[] };
    if (cleanPath === '/api/admin/sms/config') return { configured:false, online:true, message:'Secure SMS cloud connection not configured for this APK yet.' };
    if (cleanPath === '/api/admin/sms/send') throw new Error('SMS requires the secure cloud API connection; the Sozuri key is intentionally not stored in the APK.');

    throw new Error(`Admin feature not implemented locally: ${cleanPath}`);
  }
};

async function cloudApi(path, opts = {}) {
  if (!navigator.onLine) throw new Error('This feature needs an internet connection.');
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body ? (typeof opts.body === 'string' ? JSON.parse(opts.body) : opts.body) : null;
  if (window.OraforgeNative && path.startsWith('/api/admin/sms/')) {
    return window.OraforgeProviders.sms(path, body || {});
  }
  const localSms = path.startsWith('/api/admin/sms/') && ['localhost', '127.0.0.1'].includes(location.hostname);
  const url = localSms ? new URL(path, location.origin).href : CLOUD_API_BASE + path;
  if (window.OraforgeHttp?.request) {
    const response = await window.OraforgeHttp.request({ url, method, headers:{'Content-Type':'application/json','Accept':'application/json'}, data:body });
    return typeof response.data === 'string' ? JSON.parse(response.data) : response.data;
  }
  const response = await fetch(url, { method, headers:{'Content-Type':'application/json'}, body:body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || payload.message || `Cloud service failed (${response.status})`);
  return payload;
}

async function api(path, opts = {}) {
  if (path.startsWith('/api/admin/sms/')) {
    if (path === '/api/admin/sms/config') {
      try { return await cloudApi(path, opts); }
      catch (err) { return { configured:false, online:navigator.onLine, message:err.message }; }
    }
    return cloudApi(path, opts);
  }
  return LocalAdmin.handle(path, opts);
}

// ── TOAST ──
function toast(msg, type = 'success') {
  const icons = { success: '✓', error: '✕', info: 'ℹ' };
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${icons[type]||'•'}</span><span>${msg}</span>`;
  $('#toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

// ── MODAL ──
function openModal(html, onOpen) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `<div class="modal-box">${html}</div>`;
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
  if (onOpen) onOpen(overlay);
  return overlay;
}

// ── NAV ──
function navigate(section) {
  if (section === 'pos') { location.href = 'index.html'; return; }
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.section === section));
  $$('.content-section').forEach(el => el.classList.toggle('active', el.id === `sec-${section}`));
  if (section === 'dashboard') renderDashboard();
  if (section === 'users') renderUsers();
  if (section === 'menu') renderMenu();
  if (section === 'sales') renderAdminSales();
  if (section === 'suppliers') renderSuppliers();
  if (section === 'customers') renderCustomers();
  if (section === 'promotions') renderPromotions();
  if (section === 'etims') window.renderEtims();
  if (section === 'stock') renderStockAdmin();
  if (window.innerWidth <= 860) document.querySelector('.admin-shell')?.classList.add('collapsed');
}

// ── SALES HISTORY (same transaction records and receipt template as POS) ──

const moneyRaw = cents => (Number(cents || 0) / 100).toFixed(2);
let adminSalesSearch = '';
let adminSalesRows = [];

function adminSalesTime(ts, order) {
  const d = parseOrderDate(order || { updated_at: ts });
  return d.toLocaleString('en-GB', {day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'});
}

function adminSalesDrawRows() {
  const body = document.querySelector('#adminSalesTableBody');
  const count = document.querySelector('#adminSalesFilterCount');
  if (!body) return;
  const query = adminSalesSearch.toLocaleLowerCase().trim();
  const visible = adminSalesRows.filter(o => [o.ticket_no,o.customer_name,o.employee_name,o.payment_method,o.payment_ref].map(v=>String(v||'')).join(' ').toLocaleLowerCase().includes(query));
  if (count) count.textContent = query ? `${visible.length} of ${adminSalesRows.length} paid sales` : `${adminSalesRows.length} paid sales`;
  body.innerHTML = visible.map(o => `
    <tr class="admin-sales-row">
      <td class="admin-sales-ref">${receiptEscape(o.ticket_no || o.id || '—')}</td>
      <td>${receiptEscape(adminSalesTime(o.paid_at || o.updated_at || o.created_at, o))}</td>
      <td>${receiptEscape(o.employee_name || 'POS Terminal')}</td>
      <td>
        <span class="admin-sales-payment ${String(o.payment_method || '').toLowerCase() === 'mpesa' ? 'mpesa' : 'cash'}">${receiptEscape(String(o.payment_method||'cash').toLowerCase()==='mpesa'?'M-Pesa':String(o.payment_method||'cash').toLowerCase()==='cash'?'Cash':String(o.payment_method).toUpperCase())}</span>
        ${o.payment_ref ? `<div class="admin-sales-sub">${receiptEscape(o.payment_ref)}</div>` : ''}
      </td>
      <td class="admin-sales-amount">${money(o.total_cents || 0)}</td>
      <td class="admin-sales-action"><button type="button" class="btn btn-ghost admin-sales-view" data-order-id="${Number(o.id)}" aria-label="View receipt ${receiptEscape(o.ticket_no || o.id)}">View Receipt</button></td>
    </tr>`).join('') || `<tr><td colspan="6" class="admin-sales-empty">${query ? 'No sales match your search.' : 'No paid sales yet. Completed checkouts will appear here.'}</td></tr>`;
}

async function renderAdminSales() {
  const root = document.querySelector('#sec-sales');
  if (!root) return;
  root.innerHTML = '<div class="admin-sales-loading" role="status">Loading sales history…</div>';
  try {
    const orders = await api('/api/orders?status=paid');
    if (!Array.isArray(orders)) throw new Error('Unable to read the shop sales history.');
    adminSalesRows = orders.filter(o=>o.status==='paid').sort((a,b)=>
      parseOrderDate(b).getTime() - parseOrderDate(a).getTime());
    const total = adminSalesRows.reduce((sum,o)=>sum+Number(o.total_cents||0),0);
    root.innerHTML = `
      <header class="page-header admin-sales-header">
        <div class="page-header-left">
          <h1>Sales History</h1>
          <p>Paid transactions from ${receiptEscape(state.settings?.business_name || state.profile?.name || 'this shop')}. Select a receipt to view or print.</p>
        </div>
        <button type="button" id="adminSalesRefresh" class="btn btn-ghost">↻ Refresh</button>
      </header>
      <div class="admin-sales-overview">
        <div class="admin-sales-summary"><span>Completed Sales</span><strong>${fmt(adminSalesRows.length)}</strong></div>
        <div class="admin-sales-summary"><span>Total Collected</span><strong>${money(total)}</strong></div>
      </div>
      <div class="admin-sales-panel">
        <div class="admin-sales-toolbar">
          <div><h2>Sales Records</h2><p id="adminSalesFilterCount"></p></div>
          <label class="admin-sales-search-label">
            <span class="sr-only">Search sales</span>
            <input type="search" id="adminSalesSearch" class="form-input" placeholder="Search receipt, cashier, payment…" value="${receiptEscape(adminSalesSearch)}" autocomplete="off">
          </label>
        </div>
        <div class="admin-sales-scroll">
          <table class="admin-sales-table">
            <thead><tr>
              <th>Receipt No.</th><th>Date</th><th>Cashier</th><th>Payment</th>
              <th class="admin-sales-right">Total</th><th class="admin-sales-right">Action</th>
            </tr></thead>
            <tbody id="adminSalesTableBody"></tbody>
          </table>
        </div>
      </div>`;
    root.querySelector('#adminSalesRefresh').addEventListener('click', renderAdminSales);
    root.querySelector('#adminSalesSearch').addEventListener('input', e => {
      adminSalesSearch = e.target.value;
      adminSalesDrawRows();
    });
    root.querySelector('#adminSalesTableBody').addEventListener('click', async e => {
      const button = e.target.closest('[data-order-id]');
      if (!button) return;
      const id = Number(button.dataset.orderId);
      if (!Number.isSafeInteger(id) || id<=0) return;
      button.disabled = true;
      try {
        const order = await api(`/api/order?id=${id}`);
        if (order.status !== 'paid') throw new Error('Only completed sales have receipts here.');
        showAdminSalesReceipt(order);
      } catch (err) {
        toast(err.message || 'Could not load the receipt.', 'error');
      } finally { button.disabled = false; }
    });
    adminSalesDrawRows();
  } catch (err) {
    root.innerHTML = '<div class="empty-state"><p>Unable to load sales history.</p><button type="button" class="btn btn-ghost" id="adminSalesRetry">Try Again</button></div>';
    root.querySelector('#adminSalesRetry')?.addEventListener('click',renderAdminSales);
    toast(err.message || 'Failed to load sales.', 'error');
  }
}

const receiptEscape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
function showAdminSalesReceipt(order, isKot = false) {
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


// ── DASHBOARD ──
async function renderDashboard() {
  const sec = $('#sec-dashboard');
  sec.innerHTML = `<div class="loading-overlay"><div class="loading-spinner"></div> Loading analytics…</div>`;
  try {
    state.summary = await api('/api/admin/summary');
    buildDashboard(state.summary);
  } catch(e) { sec.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>${e.message}</p></div>`; }
}

function generateLineChart(data) {
  if (!data || data.length === 0) return '<div class="empty-state"><p>No sales data yet</p></div>';
  const width = 800;
  const height = 150;
  const padding = 20;
  const maxVal = Math.max(...data.map(d => d.sales), 1);
  const minVal = 0;
  
  const stepX = (width - padding * 2) / Math.max(data.length - 1, 1);
  
  const points = data.map((d, i) => {
    const x = padding + i * stepX;
    const y = height - padding - ((d.sales - minVal) / (maxVal - minVal)) * (height - padding * 2);
    return `${x},${y}`;
  }).join(' ');
  
  const areaPath = `M ${padding},${height - padding} L ${points} L ${padding + (data.length - 1) * stepX},${height - padding} Z`;
  
  const labels = data.map((d, i) => {
    const x = padding + i * stepX;
    const date = new Date(d.day).toLocaleDateString('en-US', {weekday:'short'});
    return `<text x="${x}" y="${height - 2}" font-size="10" fill="var(--muted)" text-anchor="middle">${date}</text>`;
  }).join('');
  
  const circles = data.map((d, i) => {
    const x = padding + i * stepX;
    const y = height - padding - ((d.sales - minVal) / (maxVal - minVal)) * (height - padding * 2);
    return `<circle cx="${x}" cy="${y}" r="4" fill="white" stroke="var(--primary)" stroke-width="2"><title>${d.day}: ${money(d.sales)}</title></circle>`;
  }).join('');

  return `
    <svg viewBox="0 0 ${width} ${height}" style="width:100%; height:auto; overflow:visible; display:block">
      <defs>
        <linearGradient id="chartGradient" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stop-color="var(--primary)" stop-opacity="0.3" />
          <stop offset="100%" stop-color="var(--primary)" stop-opacity="0" />
        </linearGradient>
      </defs>
      <path d="${areaPath}" fill="url(#chartGradient)" />
      <polyline points="${points}" fill="none" stroke="var(--primary)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" />
      ${circles}
      ${labels}
    </svg>
  `;
}

function buildDashboard(s) {
  const t = s.totals, c = s.counts;
  const sec = $('#sec-dashboard');
  sec.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1>Dashboard</h1>
        <p><strong>${state.profile?.icon || '🏪'} ${state.profile?.name || 'Business'} Workspace</strong> · Only this shop category's sales and customers are shown here.</p>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="renderDashboard()">Refresh</button>
    </div>

    <div class="stats-grid">
      <div class="stat-card primary">
        <div class="stat-label">Today's Sales</div>
        <div class="stat-value">${money(t.sales_today)}</div>
        <div class="stat-sub">${fmt(t.paid_today)} paid orders</div>
      </div>
      <div class="stat-card success">
        <div class="stat-label">Week Revenue</div>
        <div class="stat-value">${money(t.sales_week)}</div>
        <div class="stat-sub">Last 7 days</div>
      </div>

      <div class="stat-card info">
        <div class="stat-label">Active Staff</div>
        <div class="stat-value">${fmt(c.active_users)}</div>
        <div class="stat-sub">${fmt(c.active_users)} users · ${fmt(c.active_items)} products · ${fmt(c.active_suppliers)} suppliers</div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:20px">
      <div class="panel-header">
        <div>
          <div class="panel-title">Revenue Trend</div>
          <div class="panel-subtitle">Daily sales over the last 7 days</div>
        </div>
      </div>
      <div class="panel-body" style="padding-top:20px; padding-bottom:10px;">
        ${generateLineChart(s.sales_trend)}
      </div>
    </div>

    <div class="two-col">
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Top Selling Items</div>
            <div class="panel-subtitle">By revenue — last 7 days</div>
          </div>
        </div>
        <div class="panel-body" id="topItemsArea"></div>
      </div>
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Staff Performance</div>
            <div class="panel-subtitle">Sales by employee — last 7 days</div>
          </div>
        </div>
        <div class="panel-body" id="employeeArea"></div>
      </div>
    </div>

    <div class="panel" style="margin-bottom:20px">
      <div class="panel-header">
        <div>
          <div class="panel-title">Payment Methods</div>
          <div class="panel-subtitle">Last 7 days breakdown</div>
        </div>
      </div>
      <div class="panel-body" id="methodArea"></div>
    </div>
  `;

  // Top items chart
  const maxSales = Math.max(...s.top_items.map(i=>i.sales), 1);
  $('#topItemsArea').innerHTML = s.top_items.length ? `
    <div class="chart-area" id="barChart"></div>
    <div style="display:flex;justify-content:space-between;margin-top:8px;gap:4px;align-items:flex-start;">
      ${s.top_items.map(i=>`<div style="flex:1;text-align:center;font-size:11px;font-weight:700;color:var(--ink);word-wrap:break-word;line-height:1.3;">${i.name}</div>`).join('')}
    </div>
  ` : `<div class="empty-state"><p>No sales data yet</p></div>`;

  if (s.top_items.length) {
    const chart = $('#barChart');
    const colors = [
      'linear-gradient(to top, #0f766e, #14b8a6)', // Teal (primary)
      'linear-gradient(to top, #ea580c, #f97316)', // Orange
      'linear-gradient(to top, #2563eb, #3b82f6)', // Blue
      'linear-gradient(to top, #475569, #64748b)', // Slate / Grey
      'linear-gradient(to top, #db2777, #ec4899)', // Pink
      'linear-gradient(to top, #059669, #10b981)', // Emerald
      'linear-gradient(to top, #d97706, #f59e0b)', // Amber
      'linear-gradient(to top, #4f46e5, #6366f1)', // Indigo
    ];
    chart.innerHTML = s.top_items.map((i, idx) => {
      const pct = Math.round((i.sales / maxSales) * 100);
      const bg = colors[idx % colors.length];
      return `
        <div class="chart-bar-wrap" title="${i.name} — ${i.qty} sold" onclick="this.classList.toggle('show-val')">
          <div class="chart-val">${money(i.sales)}</div>
          <div class="chart-bar" style="height:${Math.max(pct,4)}%; background:${bg}"></div>
        </div>`;
    }).join('');
  }

  // Employees leaderboard
  $('#employeeArea').innerHTML = s.by_employee.length ? s.by_employee.map((e,i)=>`
    <div class="leaderboard-row">
      <div class="leaderboard-rank ${i===0?'gold':''}">${i+1}</div>
      <div>
        <div class="leaderboard-name">${e.employee}</div>
        <div class="leaderboard-sub">${fmt(e.orders)} orders</div>
      </div>
      <div class="leaderboard-val">${money(e.sales)}</div>
    </div>
  `).join('') : `<div class="empty-state"><p>No employee sales yet</p></div>`;

  // Payment methods
  const maxMethod = Math.max(...s.by_method.map(m=>m.sales), 1);
  $('#methodArea').innerHTML = s.by_method.length ? `<div class="method-grid">${s.by_method.map(m=>`
    <div class="method-row">
      <div class="method-label">${m.method}</div>
      <div class="method-bar-track">
        <div class="method-bar-fill" style="width:${Math.round(m.sales/maxMethod*100)}%"></div>
      </div>
      <div class="method-val">${money(m.sales)}</div>
    </div>
  `).join('')}</div>` : `<div class="empty-state"><p>No payment data yet</p></div>`;
}

// ── USERS ──
async function renderUsers() {
  const sec = $('#sec-users');
  sec.innerHTML = `<div class="loading-overlay"><div class="loading-spinner"></div> Loading…</div>`;
  try {
    state.users = await api('/api/admin/users');
    buildUsers();
  } catch(e) { sec.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
}

function buildUsers() {
  const roleBadge = r => `<span class="badge badge-${r}">${r}</span>`;
  const sec = $('#sec-users');
  sec.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1>Staff Management</h1>
        <p>${state.users.length} total accounts</p>
      </div>
      <button class="btn btn-primary" id="addUserBtn">Add Staff</button>
    </div>
    <div class="toolbar">
      <div class="search-wrap">
        <span class="search-icon">🔍</span>
        <input class="form-input" id="userSearch" placeholder="Search name or username…">
      </div>
      <select class="form-select" id="roleFilter" style="width:140px">
        <option value="">All Roles</option>
        <option value="manager">Manager</option>
        <option value="cashier">Cashier</option>
        <option value="staff">Staff</option>
      </select>
    </div>
    <div class="panel">
      <table class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Username</th>
            <th>Role</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="userTableBody"></tbody>
      </table>
    </div>
  `;
  const renderRows = (filter='', role='') => {
    const rows = state.users.filter(u =>
      (!filter || u.full_name.toLowerCase().includes(filter) || u.username.toLowerCase().includes(filter)) &&
      (!role || u.role === role)
    );
    $('#userTableBody').innerHTML = rows.length ? rows.map(u=>`
      <tr>
        <td><strong>${u.full_name}</strong></td>
        <td style="color:var(--muted);font-family:monospace">${u.username}</td>
        <td>${roleBadge(u.role)}</td>
        <td><span class="badge badge-${u.active?'active':'inactive'}">${u.active?'Active':'Inactive'}</span></td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="editUser(${u.id})">Edit</button>
        </td>
      </tr>
    `).join('') : `<tr><td colspan="5"><div class="empty-state"><p>No staff found</p></div></td></tr>`;
  };
  renderRows();
  $('#userSearch').addEventListener('input', e => renderRows(e.target.value.toLowerCase(), $('#roleFilter').value));
  $('#roleFilter').addEventListener('change', e => renderRows($('#userSearch').value.toLowerCase(), e.target.value));
  $('#addUserBtn').addEventListener('click', () => openUserModal(null));
}

function editUser(id) {
  const u = state.users.find(x => x.id === id);
  if (u) openUserModal(u);
}

function openUserModal(user) {
  const isNew = !user;
  const overlay = openModal(`
    <div class="modal-header">
      <div class="modal-title">${isNew ? 'Add Staff Member' : 'Edit Staff'}</div>
      <button class="modal-close" id="modalClose">✕</button>
    </div>
    <div class="form-grid">
      <div class="form-group">
        <label class="form-label">Full Name</label>
        <input class="form-input" id="mFullName" value="${user?.full_name||''}" placeholder="e.g. Jane Mwangi" required>
      </div>
      <div class="form-group">
        <label class="form-label">Username</label>
        <input class="form-input" id="mUsername" value="${user?.username||''}" placeholder="e.g. waiter7" required>
      </div>
      <div class="form-group">
        <label class="form-label">Role</label>
        <select class="form-select" id="mRole">
          <option value="staff" ${user?.role==='staff'?'selected':''}>Staff</option>
          <option value="cashier" ${user?.role==='cashier'?'selected':''}>Cashier</option>
          <option value="manager" ${user?.role==='manager'?'selected':''}>Manager</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <select class="form-select" id="mActive">
          <option value="1" ${(!user||user.active)?'selected':''}>Active</option>
          <option value="0" ${user&&!user.active?'selected':''}>Inactive</option>
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">${isNew ? 'Password / PIN' : 'New Password (leave blank to keep)'}</label>
        <input class="form-input" id="mPassword" type="password" placeholder="${isNew?'Staff: 4–6 digits; manager: 8+ characters':'Leave blank to keep current'}">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-primary" id="mSave">Save</button>
    </div>
  `);
  overlay.querySelector('#modalClose').onclick = () => overlay.remove();
  overlay.querySelector('#mCancel').onclick = () => overlay.remove();
  overlay.querySelector('#mSave').onclick = async () => {
    const payload = {
      full_name: overlay.querySelector('#mFullName').value.trim(),
      username: overlay.querySelector('#mUsername').value.trim(),
      role: overlay.querySelector('#mRole').value,
      active: overlay.querySelector('#mActive').value,
      password: overlay.querySelector('#mPassword').value,
    };
    if (user) payload.id = user.id;
    try {
      state.users = await api('/api/admin/user', { method: 'POST', body: payload });
      toast(`Staff ${isNew ? 'added' : 'updated'} successfully`);
      overlay.remove();
      buildUsers();
    } catch(e) { toast(e.message, 'error'); }
  };
}

// ── MENU ──
async function renderMenu() {
  const sec = $('#sec-menu');
  sec.innerHTML = `<div class="loading-overlay"><div class="loading-spinner"></div> Loading…</div>`;
  try {
    state.menu = await api('/api/menu');
    buildMenu();
  } catch(e) { sec.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
}

function buildMenu() {
  const cats = state.menu.categories;
  const items = state.menu.items;
  const catName = id => cats.find(c=>c.id===id)?.name || '?';
  const sec = $('#sec-menu');
  sec.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1>Products</h1>
        <p>${items.length} active products across ${cats.length} categories</p>
      </div>
      <button class="btn btn-primary" id="addItemBtn">Add Product</button>
    </div>
    <div class="toolbar">
      <div class="search-wrap">
        <span class="search-icon">🔍</span>
        <input class="form-input" id="menuSearch" placeholder="Search products or SKU…">
      </div>
      <select class="form-select" id="catFilter" style="width:160px">
        <option value="">All Categories</option>
        ${cats.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}
      </select>
    </div>
    <div class="panel">
      <table class="data-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Category</th>
            <th>SKU</th>
            <th>Price</th>
            <th>Stock</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody id="menuTableBody"></tbody>
      </table>
    </div>
  `;
  const renderRows = (filter='', catId='') => {
    const filtered = items.filter(i =>
      (!filter || i.name.toLowerCase().includes(filter) || (i.sku||'').toLowerCase().includes(filter)) &&
      (!catId || i.category_id === Number(catId))
    );
    $('#menuTableBody').innerHTML = filtered.length ? filtered.map(i=>`
      <tr>
        <td>
          <span class="color-swatch" style="background:${i.color}"></span>
          <strong>${i.name}</strong>
        </td>
        <td style="color:var(--muted)">${catName(i.category_id)}</td>
        <td style="color:var(--muted);font-family:monospace">${i.sku||'—'}</td>
        <td style="font-weight:700">${money(i.price_cents)}</td>
        <td><span class="badge" style="${i.unit !== 'service' && (i.stock_qty||0)<=5?'background:#fee2e2;color:#dc2626':'background:#dcfce7;color:#16a34a'}">${i.unit === 'service' ? 'Service' : `${i.stock_qty||0} ${i.unit||'pcs'}`} </span></td>
        <td>
          <button class="btn btn-ghost btn-sm" onclick="editItem(${i.id})">Edit</button>
        </td>
      </tr>
    `).join('') : `<tr><td colspan="6"><div class="empty-state"><p>No products found</p></div></td></tr>`;
  };
  renderRows();
  $('#menuSearch').addEventListener('input', e => renderRows(e.target.value.toLowerCase(), $('#catFilter').value));
  $('#catFilter').addEventListener('change', e => renderRows($('#menuSearch').value.toLowerCase(), e.target.value));
  $('#addItemBtn').addEventListener('click', () => openItemModal(null));
}

function editItem(id) {
  const all = [...state.menu.items];
  const item = all.find(i => i.id === id);
  if (item) openItemModal(item);
}

function openItemModal(item) {
  const cats = state.menu.categories;
  const isNew = !item;
  let defaultSku = '';
  if (isNew) {
    const skus = state.menu.items.map(i => parseInt(i.sku) || 0);
    const maxSku = skus.length > 0 ? Math.max(...skus) : 0;
    defaultSku = maxSku + 1;
  }
  const overlay = openModal(`
    <div class="modal-header">
      <div class="modal-title">${isNew ? 'Add Product' : 'Edit Product'}</div>
      <button class="modal-close" id="modalClose">✕</button>
    </div>
    <div class="form-grid form-grid-2">
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">Product Name</label>
        <input class="form-input" id="mName" value="${item?.name||''}" placeholder="e.g. 13A Socket" required>
      </div>
      <div class="form-group">
        <label class="form-label">Category</label>
        <select class="form-select" id="mCat">
          ${cats.map(c=>`<option value="${c.id}" ${item?.category_id===c.id?'selected':''}>${c.name}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label class="form-label">SKU</label>
        <input class="form-input" id="mSku" value="${item?.sku || defaultSku}" placeholder="e.g. 17">
      </div>
      <div class="form-group">
        <label class="form-label">Price (KES)</label>
        <input class="form-input" id="mPrice" type="number" min="0" step="1" value="${item?item.price_cents/100:''}" placeholder="e.g. 350">
      </div>
      <div class="form-group">
        <label class="form-label">Cost Price (KES)</label>
        <input class="form-input" id="mCost" type="number" min="0" step="1" value="${item?item.cost_cents/100:''}" placeholder="e.g. 200">
      </div>
      <div class="form-group">
        <label class="form-label">Unit</label>
        ${(state.profile?.id || state.menu?.profile?.id || localStorage.getItem('pos_active_business_type')) === 'garage' ? `<select class="form-select" id="mUnit">${garageUnitOptions(item?.unit || 'pcs')}</select>` : `<input class="form-input" id="mUnit" value="${item?.unit||'pcs'}" placeholder="pcs / kg / m / box">`}
      </div>
      <div class="form-group">
        <label class="form-label">Barcode</label>
        <input class="form-input" id="mBarcode" value="${item?.barcode||''}" placeholder="Optional barcode">
      </div>
      <div class="form-group">
        <label class="form-label">Button Color</label>
        <input class="form-input" id="mColor" type="color" value="${item?.color||'#334155'}" style="height:44px;padding:4px 8px;cursor:pointer">
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <select class="form-select" id="mActive">
          <option value="1" ${(!item||item.active)?'selected':''}>Active</option>
          <option value="0" ${item&&!item.active?'selected':''}>Hidden</option>
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-primary" id="mSave">Save Product</button>
    </div>
  `);
  overlay.querySelector('#modalClose').onclick = () => overlay.remove();
  overlay.querySelector('#mCancel').onclick = () => overlay.remove();
  window.OraforgeFormControls.searchableSelect(overlay.querySelector('#mCat'),null,'product categories');
  overlay.querySelector('#mSave').onclick = async () => {
    const payload = {
      name: overlay.querySelector('#mName').value.trim(),
      category_id: overlay.querySelector('#mCat').value,
      price: overlay.querySelector('#mPrice').value,
      cost: overlay.querySelector('#mCost')?.value || '0',
      sku: overlay.querySelector('#mSku')?.value || '',
      barcode: overlay.querySelector('#mBarcode')?.value || '',
      unit: overlay.querySelector('#mUnit')?.value || 'pcs',
      color: overlay.querySelector('#mColor').value,
      active: overlay.querySelector('#mActive').value,
    };
    if (item) payload.id = item.id;
    try {
      const updated = await api('/api/menu/item', { method:'POST', body: payload });
      state.menu = updated;
      toast(`Item ${isNew?'added':'updated'} successfully`);
      overlay.remove();
      buildMenu();
    } catch(e) { toast(e.message, 'error'); }
  };
}

// ── SUPPLIERS (replaces TABLES) ──
async function renderSuppliers() {
  const sec = $('#sec-suppliers');
  sec.innerHTML = `<div class="loading-overlay"><div class="loading-spinner"></div> Loading…</div>`;
  try {
    state.suppliers = await api('/api/admin/suppliers');
    buildSuppliers();
  } catch(e) { sec.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
}

function buildSuppliers() {
  const sec = $('#sec-suppliers');
  sec.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1>Suppliers</h1>
        <p>${state.suppliers.length} suppliers on record</p>
      </div>
      <button class="btn btn-primary" id="addSupplierBtn">Add Supplier</button>
    </div>
    <div class="panel">
      <table class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${state.suppliers.map(s=>`
            <tr>
              <td><strong>${s.name}</strong></td>
              <td style="color:var(--muted)">${s.phone||'—'}</td>
              <td style="color:var(--muted)">${s.email||'—'}</td>
              <td><span class="badge badge-${s.active?'active':'inactive'}">${s.active?'Active':'Disabled'}</span></td>
              <td>
                <button class="btn btn-ghost btn-sm" onclick="editSupplier(${s.id})">Edit</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  $('#addSupplierBtn').addEventListener('click', () => openSupplierModal(null));
}

function editSupplier(id) {
  const s = state.suppliers.find(x => x.id === id);
  if (s) openSupplierModal(s);
}

function openSupplierModal(supplier) {
  const isNew = !supplier;
  const overlay = openModal(`
    <div class="modal-header">
      <div class="modal-title">${isNew ? 'Add Supplier' : 'Edit Supplier'}</div>
      <button class="modal-close" id="modalClose">✕</button>
    </div>
    <div class="form-grid form-grid-2">
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">Supplier Name</label>
        <input class="form-input" id="mName" value="${supplier?.name||''}" placeholder="e.g. Crown Paints Kenya">
      </div>
      <div class="form-group">
        <label class="form-label">Phone</label>
        <input class="form-input" id="mPhone" value="${supplier?.phone||''}" placeholder="+254 700 000 000">
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input class="form-input" id="mEmail" type="email" value="${supplier?.email||''}" placeholder="orders@supplier.com">
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">Address</label>
        <input class="form-input" id="mAddress" value="${supplier?.address||''}" placeholder="Physical address">
      </div>
      <div class="form-group">
        <label class="form-label">Status</label>
        <select class="form-select" id="mActive">
          <option value="1" ${(!supplier||supplier.active)?'selected':''}>Active</option>
          <option value="0" ${supplier&&!supplier.active?'selected':''}>Disabled</option>
        </select>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-primary" id="mSave">Save</button>
    </div>
  `);
  overlay.querySelector('#modalClose').onclick = () => overlay.remove();
  overlay.querySelector('#mCancel').onclick = () => overlay.remove();
  overlay.querySelector('#mSave').onclick = async () => {
    const payload = {
      name: overlay.querySelector('#mName').value.trim(),
      phone: overlay.querySelector('#mPhone').value.trim(),
      email: overlay.querySelector('#mEmail').value.trim(),
      address: overlay.querySelector('#mAddress').value.trim(),
      active: overlay.querySelector('#mActive').value,
    };
    if (supplier) payload.id = supplier.id;
    try {
      state.suppliers = await api('/api/admin/supplier', { method:'POST', body: payload });
      toast(`Supplier ${isNew?'added':'updated'}`);
      overlay.remove();
      buildSuppliers();
    } catch(e) { toast(e.message, 'error'); }
  };
}

// ── STOCK ADMIN ──
async function renderStockAdmin() {
  const sec = $('#sec-stock');
  sec.innerHTML = `<div class="loading-overlay"><div class="loading-spinner"></div> Loading…</div>`;
  try {
    const items = await api('/api/stock');
    buildStockAdmin(items);
  } catch(e) { sec.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
}

function buildStockAdmin(items) {
  items = items.filter(i => i.unit !== 'service');
  const sec = $('#sec-stock');
  const low = items.filter(i => i.stock_qty <= 5);
  sec.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1>Stock Management</h1>
        <p>${items.length} products · <span style="color:#dc2626">${low.length} low stock</span></p>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="renderStockAdmin()">Refresh</button>
    </div>
    <div class="panel">
      <table class="data-table">
        <thead>
          <tr>
            <th>Product</th>
            <th>SKU</th>
            <th>Stock</th>
            <th>Unit</th>
            <th>Adjust</th>
          </tr>
        </thead>
        <tbody>
          ${items.map(i => {
            const isLow = i.stock_qty <= 5;
            return `
              <tr style="${isLow?'background:#fff5f5':''}}">
                <td><strong>${i.name}</strong></td>
                <td style="color:var(--muted);font-family:monospace">${i.sku||'—'}</td>
                <td><span class="badge" style="${isLow?'background:#fee2e2;color:#dc2626':'background:#dcfce7;color:#16a34a'}">${i.stock_qty}</span></td>
                <td style="color:var(--muted)">${i.unit}</td>
                <td>
                  <div style="display:flex;gap:6px;align-items:center">
                    <input type="number" class="form-input" id="adj_${i.id}" value="1" min="-9999" style="width:70px;padding:6px 8px">
                    <button class="btn btn-primary btn-sm" onclick="adjustStock(${i.id},'add')">+Add</button>
                    <button class="btn btn-ghost btn-sm" onclick="adjustStock(${i.id},'remove')">−Sub</button>
                  </div>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function adjustStock(productId, direction) {
  const inp = $(`#adj_${productId}`);
  const qty = Math.abs(parseInt(inp.value) || 1);
  const qty_change = direction === 'add' ? qty : -qty;
  try {
    await api('/api/stock/adjust', { method:'POST', body: { product_id: productId, qty_change, reason: 'manual' } });
    toast(`Stock ${direction === 'add' ? 'added' : 'removed'}: ${qty}`);
    renderStockAdmin();
  } catch(e) { toast(e.message, 'error'); }
}


// ── WHATSAPP PROMOTIONS ──────────────────────────────────────────────────────
const PROMO_PROFILE_COPY = {
  retail: {
    general: 'Thanks for shopping with us. We have fresh stock and great deals available in store. Visit us again soon.',
    stock: 'New stock is in. Drop by and check out what is available.',
    offer: 'We have a special offer running in store. Visit us and enjoy the deal while it lasts.',
    comeback: 'We would love to see you again. Drop by whenever you are around.'
  },
  pharmacy: {
    general: 'Thanks for choosing us. We are here for your pharmacy and wellness needs. Visit us again whenever you need us.',
    stock: 'Fresh pharmacy and wellness stock is available. Visit us or message us to check availability.',
    offer: 'We have offers on selected wellness and personal-care items. Visit us for the current deals.',
    comeback: 'We would be happy to serve you again whenever you need your pharmacy and wellness essentials.'
  },
  restaurant: {
    general: 'Thanks for dining with us. We would love to serve you again. Visit us soon and enjoy your favourite meals.',
    stock: 'Your favourite meals are waiting. Come by and enjoy a fresh meal with us.',
    offer: 'We have a special food offer available. Come by and enjoy it while it lasts.',
    comeback: 'We would love to have you back. Come by for another meal soon.'
  },
  hardware: {
    general: 'Thanks for shopping with us. We are ready to help with your next project. Visit us or message us for stock and quotations.',
    stock: 'New hardware and building-material stock is in. Visit us or message us to check availability.',
    offer: 'We have a special deal on selected hardware and building supplies. Visit us for the current prices.',
    comeback: 'Planning another project? Visit us or send your list and we will help with stock and quotations.'
  },
  boutique: {
    general: 'Thanks for shopping with us. New styles and beauty picks are always coming in. Visit us again soon.',
    stock: 'New arrivals are in. Come by and check out the latest styles, colours and beauty picks.',
    offer: 'We have a special offer on selected fashion and beauty items. Visit us while the deal lasts.',
    comeback: 'We would love to see you again. Come by and check out the latest arrivals.'
  },
  bar: {
    general: 'Thanks for visiting us. Come through again soon for good vibes, drinks and a great time.',
    stock: 'Come through and enjoy good vibes, refreshments and a great time with us.',
    offer: 'We have a special offer at the venue. Come through and enjoy it while it lasts.',
    comeback: 'Come through again soon. We would love to have you back.'
  }
};

function promoEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function normalizePromoPhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10 && digits.startsWith('0')) digits = `254${digits.slice(1)}`;
  else if (digits.length === 9 && (digits.startsWith('7') || digits.startsWith('1'))) digits = `254${digits}`;
  return digits;
}

function promoTemplateBody(type, campaign) {
  const profileCopy = PROMO_PROFILE_COPY[type] || PROMO_PROFILE_COPY.retail;
  return profileCopy[campaign] || profileCopy.general;
}

function makePromoTemplate(type, campaign, businessName) {
  return `${businessName}: ${promoTemplateBody(type, campaign)}`;
}

function personalizePromoMessage(template, customer) {
  const businessName = state.promoSettings?.business_name || 'Our business';
  return String(template || '').replaceAll('{business_name}', businessName);
}

async function renderPromotions() {
  const sec = $('#sec-promotions');
  sec.innerHTML = `<div class="loading-overlay"><div class="loading-spinner"></div> Loading customers…</div>`;
  try {
    const [customers, settingsPayload, smsConfig] = await Promise.all([
      api('/api/admin/customers'),
      api('/api/settings'),
      api('/api/admin/sms/config')
    ]);
    state.promoCustomers = (customers || []).filter(c => String(c.phone || '').trim());
    state.promoSettings = settingsPayload?.settings || {};
    state.promoProfile = settingsPayload?.profile || {};
    state.smsConfig = smsConfig || {};
    state.promoSelected = new Set();
    buildPromotions();
  } catch (e) {
    sec.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>${promoEscape(e.message)}</p></div>`;
  }
}

function buildPromotions() {
  const sec = $('#sec-promotions');
  const businessType = state.promoSettings?.business_type || 'retail';
  const businessName = state.promoSettings?.business_name || 'Our business';
  const profileName = state.promoProfile?.name || businessType;
  const initial = makePromoTemplate(businessType, 'general', businessName);

  sec.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1>Customer Marketing</h1>
        <p>WhatsApp and SMS promotions tailored for ${promoEscape(profileName)}</p>
      </div>
      <button class="btn btn-ghost btn-sm" id="promoRefreshBtn">Refresh Customers</button>
    </div>

    <div class="promo-consent-note">
      <strong>Customer privacy:</strong> only send promotions to customers who have agreed to receive marketing messages. A saved phone number alone does not necessarily mean marketing consent.
    </div>

    <div class="promo-grid">
      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Campaign Message</div>
            <div class="panel-subtitle">The default wording changes automatically with the active business type.</div>
          </div>
        </div>
        <div class="panel-body">
          <label class="form-label">Campaign type</label>
          <select class="form-select" id="promoCampaignType">
            <option value="general">General Promotion</option>
            <option value="stock">New Stock / New Arrivals</option>
            <option value="offer">Special Offer</option>
            <option value="comeback">We Miss You / Come Back</option>
          </select>

          <label class="form-label" style="margin-top:14px">Message</label>
          <textarea class="form-input promo-message-editor" id="promoMessageEditor">${promoEscape(initial)}</textarea>
          <div class="promo-hint">Edit the message however you like. The same campaign text can be used for WhatsApp or SMS.</div>

          <div class="promo-hint" id="promoSmsCharCount" style="margin-top:8px">0 characters · 1 SMS segment</div>
          <div class="promo-actions">
            <button class="btn btn-ghost" id="promoResetBtn">Reset Template</button>
            <button class="btn btn-primary" id="promoPrepareBtn">Prepare WhatsApp Messages</button>
          </div>
        </div>
      </div>

      <div class="panel">
        <div class="panel-header">
          <div>
            <div class="panel-title">Customers</div>
            <div class="panel-subtitle"><span id="promoCustomerCount">${state.promoCustomers.length}</span> customers have a phone number saved</div>
          </div>
        </div>
        <div class="panel-body">
          <div class="promo-customer-toolbar">
            <input class="form-input" id="promoCustomerSearch" placeholder="Search customer or phone…">
            <label class="promo-select-all"><input type="checkbox" id="promoSelectAll"> Select all shown</label>
          </div>
          <div class="promo-customer-list" id="promoCustomerList"></div>
        </div>
      </div>
    </div>

    <div class="panel" style="margin-top:20px">
      <div class="panel-header">
        <div>
          <div class="panel-title">SMS Marketing · Sozuri</div>
          <div class="panel-subtitle">Send the campaign above to the same customers you select for WhatsApp.</div>
        </div>
        <span class="badge badge-active">LIVE</span>
      </div>
      <div class="panel-body">
        <div class="promo-sms-layout" style="display:grid;grid-template-columns:minmax(0,1fr) auto;gap:16px;align-items:end">
          <div>
            <div class="form-label">Selected customers</div>
            <div style="font-size:16px;font-weight:800;margin-top:4px"><span id="promoSmsSelectedCount">${state.promoSelected?.size || 0}</span> selected</div>
            <div class="promo-hint" style="margin-top:8px">SMS uses the message in the campaign editor above and the phone numbers saved on the selected customer records.</div>
            <div class="promo-hint" style="margin-top:5px">Provider status: <strong>${state.smsConfig?.configured ? 'Configured' : promoEscape(state.smsConfig?.message || 'SMS provider unavailable')}</strong></div>
          </div>
          <button class="btn btn-primary" id="promoSmsSendBtn" ${state.promoSelected?.size ? '' : 'disabled'}>Send SMS to Selected (${state.promoSelected?.size || 0})</button>
        </div>
        <div id="promoSmsStatus" style="margin-top:12px"></div>
      </div>
    </div>

    <div class="panel promo-queue-panel" id="promoQueuePanel" style="display:none">
      <div class="panel-header">
        <div>
          <div class="panel-title">Ready to Send</div>
          <div class="panel-subtitle">Open each chat, review the personalized message, then tap Send in WhatsApp.</div>
        </div>
      </div>
      <div class="panel-body" id="promoQueueBody"></div>
    </div>
  `;

  renderPromoCustomerRows();

  $('#promoRefreshBtn').addEventListener('click', renderPromotions);
  $('#promoCustomerSearch').addEventListener('input', e => renderPromoCustomerRows(e.target.value));
  $('#promoCampaignType').addEventListener('change', resetPromoTemplate);
  $('#promoResetBtn').addEventListener('click', resetPromoTemplate);
  $('#promoPrepareBtn').addEventListener('click', preparePromoQueue);
  $('#promoMessageEditor').addEventListener('input', updatePromoSmsCounter);
  $('#promoSmsSendBtn')?.addEventListener('click', sendPromoSmsSelected);
  updatePromoSmsCounter();
  $('#promoSelectAll').addEventListener('change', e => {
    $$('.promo-customer-check').forEach(cb => {
      cb.checked = e.target.checked;
      const id = Number(cb.value);
      if (cb.checked) state.promoSelected.add(id);
      else state.promoSelected.delete(id);
    });
    updatePromoSelectionCount();
  });
}

function resetPromoTemplate() {
  const type = state.promoSettings?.business_type || 'retail';
  const businessName = state.promoSettings?.business_name || 'Our business';
  const campaign = $('#promoCampaignType')?.value || 'general';
  const editor = $('#promoMessageEditor');
  if (editor) editor.value = makePromoTemplate(type, campaign, businessName);
  updatePromoSmsCounter();
}

function brandedSmsMessage(text) {
  const name=String(state.promoSettings?.business_name || '').trim();
  const body=String(text || '').trim().replaceAll('{business_name}',name);
  return name && !body.toLowerCase().startsWith((name+':').toLowerCase()) ? `${name}: ${body}` : body;
}

function updatePromoSmsCounter() {
  const editor = $('#promoMessageEditor');
  const label = $('#promoSmsCharCount');
  if (!editor || !label) return;
  const length = brandedSmsMessage(editor.value).length;
  const segments = Math.max(1, Math.ceil(length / 160));
  label.textContent = `${length} characters · ${segments} SMS segment${segments === 1 ? '' : 's'}`;
}

async function sendPromoSmsSelected() {
  const editor = $('#promoMessageEditor');
  const button = $('#promoSmsSendBtn');
  const status = $('#promoSmsStatus');
  const rawMessage = editor?.value?.trim() || '';
  const message = brandedSmsMessage(rawMessage);
  const ids = [...(state.promoSelected || [])];

  if (!state.smsConfig?.configured) {
    const error = state.smsConfig?.message || 'SMS provider is not configured.';
    if (status) status.textContent = error;
    toast(error, 'error');
    return;
  }
  if (!ids.length) {
    toast('Select at least one customer first.', 'info');
    return;
  }
  if (!rawMessage) {
    toast('Write a promotion message first.', 'error');
    return;
  }

  if (!state.promoSettings?.business_name?.trim()) { toast('Set your business name in Settings before sending SMS.', 'error'); return; }
  const customers = ids.map(id => state.promoCustomers.find(c => Number(c.id) === Number(id))).filter(Boolean);
  if (!confirm(`Send this SMS campaign through Sozuri to ${customers.length} selected customer${customers.length === 1 ? '' : 's'}?`)) return;

  const oldText = button?.textContent;
  if (button) { button.disabled = true; button.textContent = 'Sending…'; }
  if (status) status.innerHTML = `<span style="color:var(--muted)">Sending SMS to ${customers.length} customer${customers.length === 1 ? '' : 's'}…</span>`;

  try {
    const result = await api('/api/admin/sms/send', { method:'POST', body:{ message, customer_ids: ids, recipients: customers.map(c => c.phone) } });
    if (!result.sent) throw new Error((result.results || []).map(r => `${r.number}: ${r.status}`).join('; ') || result.message || 'Provider accepted no recipients.');
    if (Number(result.sent) < Number(result.total) || !result.sent) {
      throw new Error('Some messages could not be sent. Please check the selected recipients.');
    }
    if (status) status.textContent = '';
    openModal(`
      <div role="dialog" aria-modal="true" aria-label="SMS sent successfully" style="padding:28px;text-align:center;background:#dcfce7;color:#166534;border-radius:12px;">
        <div aria-hidden="true" style="font-size:40px;margin-bottom:12px;">✓</div>
        <h3 style="margin:0 0 20px;color:#166534;">Sent successfully</h3>
        <button type="button" class="btn btn-primary" data-sms-close style="background:#16a34a;border-color:#16a34a;color:white;">OK</button>
      </div>
    `, overlay => {
      const closeButton = overlay.querySelector('[data-sms-close]');
      closeButton.addEventListener('click', () => overlay.remove());
      overlay.addEventListener('keydown', event => { if (event.key === 'Escape') overlay.remove(); });
      closeButton.focus();
    });
  } catch (e) {
    if (status) status.innerHTML = `<div style="padding:10px 12px;border-radius:8px;background:#fee2e2;color:#991b1b;font-weight:700">${promoEscape(e.message)}</div>`;
    toast(e.message, 'error');
  } finally {
    updatePromoSelectionCount();
    if (button && !oldText) button.textContent = 'Send SMS to Selected';
  }
}

function renderPromoCustomerRows(filter = '') {
  const root = $('#promoCustomerList');
  if (!root) return;
  const q = String(filter || '').trim().toLowerCase();
  const rows = state.promoCustomers.filter(c =>
    !q || String(c.name || '').toLowerCase().includes(q) || String(c.phone || '').toLowerCase().includes(q)
  );

  root.innerHTML = rows.length ? rows.map(c => {
    const valid = normalizePromoPhone(c.phone).length >= 10;
    const checked = state.promoSelected.has(Number(c.id));
    return `
      <label class="promo-customer-row ${valid ? '' : 'invalid'}">
        <input type="checkbox" class="promo-customer-check" value="${Number(c.id)}" ${checked ? 'checked' : ''} ${valid ? '' : 'disabled'}>
        <div class="promo-customer-info">
          <strong>${promoEscape(c.name || 'Unnamed customer')}</strong>
          <span>${promoEscape(c.phone || '')}${valid ? '' : ' · Invalid phone number'}</span>
        </div>
      </label>`;
  }).join('') : `<div class="empty-state"><p>No customers with phone numbers match your search.</p></div>`;

  $$('.promo-customer-check', root).forEach(cb => cb.addEventListener('change', () => {
    const id = Number(cb.value);
    if (cb.checked) state.promoSelected.add(id);
    else state.promoSelected.delete(id);
    updatePromoSelectionCount();
  }));

  updatePromoSelectionCount();
}

function updatePromoSelectionCount() {
  const count = state.promoSelected?.size || 0;
  const btn = $('#promoPrepareBtn');
  if (btn) btn.textContent = `Prepare WhatsApp Messages (${count})`;

  const smsCount = $('#promoSmsSelectedCount');
  if (smsCount) smsCount.textContent = String(count);

  const smsBtn = $('#promoSmsSendBtn');
  if (smsBtn) {
    smsBtn.textContent = `Send SMS to Selected (${count})`;
    smsBtn.disabled = count === 0;
  }
}

function preparePromoQueue() {
  const ids = [...(state.promoSelected || [])];
  if (!ids.length) {
    toast('Select at least one customer first.', 'info');
    return;
  }

  if (!confirm('Send only to customers who agreed to receive promotional WhatsApp messages. Continue preparing this campaign?')) return;

  const template = $('#promoMessageEditor')?.value?.trim();
  if (!template) {
    toast('Write a promotion message first.', 'error');
    return;
  }

  const customers = ids.map(id => state.promoCustomers.find(c => Number(c.id) === Number(id))).filter(Boolean);
  const queue = $('#promoQueuePanel');
  const body = $('#promoQueueBody');
  queue.style.display = 'block';
  body.innerHTML = customers.map(c => `
    <div class="promo-queue-row">
      <div>
        <strong>${promoEscape(c.name || 'Customer')}</strong>
        <div class="promo-queue-phone">${promoEscape(c.phone)}</div>
      </div>
      <button class="btn btn-primary btn-sm" data-promo-open="${Number(c.id)}">Open WhatsApp</button>
    </div>
  `).join('');

  $$('[data-promo-open]', body).forEach(btn => btn.addEventListener('click', () => openPromoWhatsApp(Number(btn.dataset.promoOpen))));
  queue.scrollIntoView({behavior: 'smooth', block: 'start'});
}

function openPromoWhatsApp(customerId) {
  const customer = state.promoCustomers.find(c => Number(c.id) === Number(customerId));
  if (!customer) return;
  const phone = normalizePromoPhone(customer.phone);
  if (phone.length < 10 || phone.length > 15) {
    toast(`Invalid WhatsApp number for ${customer.name || 'customer'}.`, 'error');
    return;
  }
  const template = $('#promoMessageEditor')?.value || '';
  const message = personalizePromoMessage(template, customer);
  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank', 'noopener,noreferrer');
}


// ── BOOT ──

// ── CUSTOMERS ──
async function renderCustomers() {
  const sec = $('#sec-customers');
  sec.innerHTML = `<div class="loading-overlay"><div class="loading-spinner"></div> Loading…</div>`;
  try {
    state.customers = await api('/api/admin/customers');
    buildCustomers();
  } catch(e) { sec.innerHTML = `<div class="empty-state"><p>${e.message}</p></div>`; }
}

function buildCustomers() {
  const sec = $('#sec-customers');
  sec.innerHTML = `
    <div class="page-header">
      <div class="page-header-left">
        <h1>Customers</h1>
        <p>${state.customers.length} customers registered</p>
      </div>
      <button class="btn btn-primary" id="addCustomerBtn">Add Customer</button>
    </div>
    <div class="panel">
      <table class="data-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Phone</th>
            <th>Email</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${state.customers.map(c=>`
            <tr>
              <td><strong>${c.name}</strong></td>
              <td style="color:var(--muted)">${c.phone||'—'}</td>
              <td style="color:var(--muted)">${c.email||'—'}</td>
              <td>
                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                  <button class="btn btn-ghost btn-sm" onclick="editCustomer(${c.id})">Edit</button>
                </div>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  $('#addCustomerBtn').addEventListener('click', () => openCustomerModal(null));
}

function editCustomer(id) {
  const c = state.customers.find(x => x.id === id);
  if (c) openCustomerModal(c);
}

function openCustomerModal(customer) {
  const isNew = !customer;
  const overlay = openModal(`
    <div class="modal-header">
      <div class="modal-title">${isNew ? 'Add Customer' : 'Edit Customer'}</div>
      <button class="modal-close" id="modalClose">✕</button>
    </div>
    <div class="form-grid form-grid-2">
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">Customer Name</label>
        <input class="form-input" id="mName" value="${customer?.name||''}" placeholder="e.g. John Doe">
      </div>
      <div class="form-group">
        <label class="form-label">Phone</label>
        <input class="form-input" id="mPhone" value="${customer?.phone||''}" placeholder="e.g. 07... or +254...">
      </div>
      <div class="form-group">
        <label class="form-label">Email</label>
        <input class="form-input" id="mEmail" type="email" value="${customer?.email||''}" placeholder="Optional">
      </div>
      <div class="form-group" style="grid-column:1/-1">
        <label class="form-label">Notes</label>
        <input class="form-input" id="mNotes" value="${customer?.notes||''}" placeholder="Preferences, address, etc.">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-ghost" id="mCancel">Cancel</button>
      <button class="btn btn-primary" id="mSave">Save</button>
    </div>
  `);
  overlay.querySelector('#modalClose').onclick = () => overlay.remove();
  overlay.querySelector('#mCancel').onclick = () => overlay.remove();
  overlay.querySelector('#mSave').onclick = async () => {
    const payload = {
      name: overlay.querySelector('#mName').value.trim(),
      phone: overlay.querySelector('#mPhone').value.trim(),
      email: overlay.querySelector('#mEmail').value.trim(),
      notes: overlay.querySelector('#mNotes').value.trim(),
    };
    if (!payload.name) {
      toast('Customer Name is required', 'error');
      return;
    }
    if (customer) payload.id = customer.id;
    try {
      state.customers = await api('/api/admin/customer', { method:'POST', body: payload });
      toast(`Customer ${isNew?'added':'updated'} successfully`);
      overlay.remove();
      buildCustomers();
    } catch(e) { toast(e.message, 'error'); }
  };
}

// ── BOOT ──

async function ensureAdminLogin() {
  if (sessionStorage.getItem('pos_admin_logged_in') === 'true') return true;
  return await new Promise(resolve => {
    const profile = ADMIN_PROFILES[localStorage.getItem('pos_active_business_type') || 'retail'] || ADMIN_PROFILES.retail;
    const overlay = document.createElement('div');
    overlay.id = 'adminLoginOverlay';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:var(--bg);display:grid;place-items:center;padding:16px;box-sizing:border-box;overflow-x:hidden;';
    overlay.innerHTML = `
      <div style="width:min(390px,100%);max-width:100%;box-sizing:border-box;background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:24px;box-shadow:var(--shadow-lg);">
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:22px;">
          <div style="width:48px;height:48px;border-radius:12px;background:var(--primary);color:var(--primary-fg);display:grid;place-items:center;font-size:24px;">${profile.icon}</div>
          <div><h2 style="margin:0;font-size:20px;">${profile.name} Admin</h2><div style="color:var(--muted);font-size:12px;margin-top:3px;">Manager access · local device</div></div>
        </div>
        <label class="form-label" for="adminPinInput">Manager PIN</label>
        <input id="adminPinInput" class="form-input" type="password" inputmode="numeric" pattern="[0-9]*" placeholder="Enter PIN" style="font-size:22px;text-align:center;letter-spacing:5px;padding:13px;">
        <div id="adminLoginError" style="min-height:20px;color:var(--danger);font-size:12px;font-weight:700;text-align:center;margin:8px 0;"></div>
        <button id="adminLoginBtn" class="btn btn-primary" style="width:100%;padding:12px;">Login to Admin</button>
        <a href="index.html" style="display:block;text-align:center;margin-top:14px;color:var(--muted);font-size:13px;text-decoration:none;">← Back to POS</a>
        <div style="margin-top:18px;padding-top:12px;border-top:1px solid var(--line);font-size:12px;color:var(--muted);text-align:center;">Demo manager PIN: <strong>1234</strong></div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#adminPinInput');
    const error = overlay.querySelector('#adminLoginError');
    const submit = () => {
      if (input.value !== '1234') { error.textContent = 'Invalid manager PIN.'; input.select(); return; }
      sessionStorage.setItem('pos_admin_logged_in','true');
      overlay.remove(); resolve(true);
    };
    overlay.querySelector('#adminLoginBtn').addEventListener('click', submit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    setTimeout(() => input.focus(), 50);
  });
}

async function boot() {
  await ensureAdminLogin();
  const data = await api('/api/bootstrap');
  if (!data) return;
  state.user = data.user;
  state.settings = data.settings || {};
  state.profile = data.profile || {};
  if (!state.user || state.user.role !== 'manager') throw new Error('Manager login required');

  const businessName = state.settings.business_name || state.profile.name || 'POS';
  const profileName = state.profile.name || 'Business';
  const businessIcon = state.profile.icon || '🏪';
  const itemLabel = state.profile.item_label || 'Products';
  const businessNameEl = $('#adminBusinessName');
  const businessIconEl = $('#adminBusinessIcon');
  const portalTagEl = $('#adminPortalTag');
  const productsLabelEl = $('#adminProductsLabel');
  if (businessNameEl) businessNameEl.textContent = businessName;
  if (businessIconEl) businessIconEl.textContent = businessIcon;
  if (portalTagEl) portalTagEl.textContent = `${profileName} Admin`;
  if (productsLabelEl) productsLabelEl.textContent = itemLabel;
  document.title = `${businessName} — Admin Portal`;
  // render user info in sidebar
  $('#userDisplayName').textContent = state.user.name;
  $('#userAvatarLetter').textContent = (state.user.name||'A')[0].toUpperCase();
  // nav wiring
  $$('.nav-item').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.section));
  });
  navigate('dashboard');
}

boot().catch(e => { console.error(e); const sec = $('#sec-dashboard'); if (sec) sec.innerHTML = `<div class="empty-state"><div class="empty-state-icon">⚠️</div><p>${e.message}</p></div>`; });

