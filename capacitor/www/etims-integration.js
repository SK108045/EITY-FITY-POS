/* POS side of the Windows localhost companion. The durable POS ledger is authoritative. */
(() => {
  'use strict';
  const core = window.OraforgeEtimsCore, ledgerKey = 'oraforge:etims:v1';
  const scope = () => window.OraforgeShops?.activeShopId() || localStorage.getItem('pos_active_business_type') || 'retail';
  const identity = (order, shop = scope()) => JSON.stringify([shop, Number(order.id), String(order.ticket_no)]);
  const now = () => new Date().toISOString();
  async function db() {
    await window.OraforgeDBReady;
    if (!window.OraforgeDB?.update) throw Error('Update the POS database bridge to save eTIMS records safely.');
    return window.OraforgeDB;
  }
  async function ledger() { return (await db()).get(ledgerKey, {}); }
  async function update(fn) {
    const value = await (await db()).update(ledgerKey, fn, {});
    window.dispatchEvent(new CustomEvent('oraforge-etims-changed'));
    window.OraforgeAutoBackup?.check();
    return value;
  }
  async function request(route, body) {
    const headers = { 'X-Oraforge-Shop': scope() };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      headers['X-Oraforge-Etims'] = '2';
    }
    const response = await fetch('/api/etims' + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const result = await response.json();
    if (!response.ok) {
      const error = Error(result.error || 'Windows eTIMS helper is unavailable.');
      error.status = response.status;
      throw error;
    }
    return result;
  }
  async function bridge(action,data={}) {
    if(action==='ping')return request('/health');
    if(action==='recorded' || action==='ack')return true;
    throw Error('The Chrome portal bridge has been replaced by the Windows helper.');
  }
  function sha256Pure(str) {
    const utf8 = unescape(encodeURIComponent(str));
    const rightRotate = (v, a) => (v >>> a) | (v << (32 - a));
    const mathPow = Math.pow;
    const maxWord = mathPow(2, 32);
    let i, j, result = '';
    const words = [];
    const asciiBitLength = utf8.length * 8;
    const hash = [];
    const k = [];
    let primeCounter = 0;
    const isComposite = {};
    for (let candidate = 2; primeCounter < 64; candidate++) {
      if (!isComposite[candidate]) {
        for (i = 0; i < 313; i += candidate) isComposite[i] = candidate;
        hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
        k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
      }
    }
    let s = utf8 + '\x80';
    while (s.length % 64 - 56) s += '\x00';
    for (i = 0; i < s.length; i++) {
      words[i >> 2] |= s.charCodeAt(i) << ((3 - i) % 4) * 8;
    }
    words[words.length] = ((asciiBitLength / maxWord) | 0);
    words[words.length] = asciiBitLength | 0;
    for (j = 0; j < words.length;) {
      const w = words.slice(j, j += 16);
      const oldHash = hash.slice(0);
      for (i = 0; i < 64; i++) {
        const w15 = w[i - 15], w2 = w[i - 2];
        const a = hash[0], e = hash[4];
        const temp1 = (hash[7]
          + (rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25))
          + ((e & hash[5]) ^ ((~e) & hash[6]))
          + k[i]
          + (w[i] = (i < 16) ? (w[i] || 0) : (
            w[i - 16]
            + (rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3))
            + w[i - 7]
            + (rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10))
          ) | 0)) | 0;
        const temp2 = ((rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22))
          + ((a & hash[1]) ^ (a & hash[2]) ^ (hash[1] & hash[2]))) | 0;
        hash.pop();
        hash.unshift((temp1 + temp2) | 0);
        hash[4] = (hash[4] + temp1) | 0;
      }
      for (i = 0; i < 8; i++) hash[i] = (hash[i] + oldHash[i]) | 0;
    }
    for (i = 0; i < 8; i++) {
      for (j = 3; j >= 0; j--) {
        const b = (hash[i] >> (j * 8)) & 255;
        result += (b < 16 ? '0' : '') + b.toString(16);
      }
    }
    return result;
  }

  async function sha256Hex(str) {
    if (typeof crypto !== 'undefined' && crypto && crypto.subtle && typeof crypto.subtle.digest === 'function') {
      try {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
        return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
      } catch (_) {}
    }
    return sha256Pure(str);
  }

  function getUuid() {
    if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
      try { return crypto.randomUUID(); } catch (_) {}
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
  }

  async function helperId(record) {
    return sha256Hex(JSON.stringify([record.shop_id, Number(record.sale_id), String(record.receipt_no)]));
  }
  async function queue(order, details = {}, settings = {}, shop = order.etims_shop_id || scope()) {
    if (order.etims_shop_id && shop !== order.etims_shop_id) throw Error('This invoice belongs to another shop.');
    const old=(await ledger())[identity(order,shop)];
    if(old) {
      const original=old.snapshot.version===2?core.windowsSnapshot(order,shop,settings,details):core.snapshot(order,shop,settings,details);
      if(JSON.stringify(original)!==JSON.stringify(old.snapshot))throw Error('The sale differs from its original saved fiscal snapshot.');
      return old;
    }
    const payload = core.windowsSnapshot(order, shop, settings, details);
    const digest = await sha256Hex(JSON.stringify(payload));
    const id = identity(order, shop);
    const rows = await update(rows => {
      if (rows[id] && rows[id].digest!==digest) throw Error('This sale differs from its saved fiscal snapshot. Check the original transaction before invoicing.');
      if (!rows[id]) rows[id] = {id, shop_id:shop, sale_id:order.id, receipt_no:order.ticket_no, snapshot:payload, digest, status:'pending', created_at:now(), updated_at:now(), history:[]};
      return rows;
    });
    return rows[id];
  }
  async function get(order) { return (await ledger())[identity(order)] || null; }
  async function attach(orders) {
    // Read-only join: sales APIs expose the linked invoice without rewriting sales.
    try {
      const records=await ledger();
      return orders.map(order=>records[identity(order)] ? {...order,etims:records[identity(order)]} : order);
    } catch(error) { console.warn('eTIMS sale details unavailable:',error.message); return orders; }
  }
  async function change(id, action) {
    const rows = await update(rows => {
      const next = core.transition(rows[id], action, now());
      const cu = next.fiscal?.cu_invoice_number?.toUpperCase();
      if (cu && Object.values(rows).some(r => r.id !== id && r.fiscal?.cu_invoice_number?.toUpperCase() === cu)) throw Error('This CU Invoice Number is already assigned to another POS sale.');
      rows[id] = next;
      return rows;
    });
    return rows[id];
  }
  async function start(id, recovery = false) {
    let record=(await ledger())[id];
    if(!record || record.shop_id!==scope()) throw Error('Select the original shop before issuing its invoice.');
    if(record.fiscal?.cu_invoice_number || record.status==='generated') throw Error('This sale already has a CU Invoice Number. Duplicate generation is blocked.');
    if(record.snapshot.version!==2) throw Error('This is an existing portal request. Verify its original KRA invoice before migrating it; it will not be reissued automatically.');
    const orders=await (await db()).get(`shop:${record.shop_id}:orders`,[]);
    const sale=orders.find(o=>Number(o.id)===Number(record.sale_id) && o.ticket_no===record.receipt_no);
    if(!sale || JSON.stringify(core.windowsSnapshot(sale,record.shop_id,{kra_pin:record.snapshot.seller_pin},record.snapshot.customer))!==JSON.stringify(record.snapshot)) throw Error('The POS sale differs from its saved fiscal snapshot.');
    await bridge('ping');
    const job=record.helper_job_id || await helperId(record);
    if(record.status==='pending') {
      record=await change(id,{type:'start',attempt_id:getUuid()});
      await update(rows=>{rows[id]={...rows[id],helper_job_id:job,helper_state:'queued'};return rows;});
      await request('/jobs',{sale:record.snapshot,details:sale.etims_registration_details || {},confirmed_new_sale:true});
    } else if(recovery) {
      let existing;
      try{existing=await request('/jobs/'+job);}catch(error){if(error.status!==404)throw error;}
      if(existing?.state==='needs_details') {
        let details=sale.etims_registration_details || {};
        const plan=await request('/preflight',{sale:record.snapshot,details});
        if(!plan.ready)details=await registrationDetails(plan.requirements,plan,details);
        await (await db()).update(`shop:${record.shop_id}:orders`,orders=>{const original=orders.find(o=>o.id===sale.id && o.ticket_no===sale.ticket_no);if(!original)throw Error('Original paid sale missing');original.etims_registration_details=details;return orders;},[]);
        await request('/jobs/'+job+'/details',{details});
      }else if(existing)await request('/jobs/'+job+'/recover',{});
      else await request('/jobs',{sale:record.snapshot,details:sale.etims_registration_details || {},confirmed_new_sale:true});
    }
    else throw Error('This request has already started. Recover the same sale in the eTIMS workspace.');
    await sync();
    return (await ledger())[id];
  }
  async function sync() {
    const current=await ledger();
    for(const record of Object.values(current)) {
      if(record.snapshot?.version!==2 || !record.helper_job_id || record.status==='generated')continue;
      let job;try{job=await request('/jobs/'+record.helper_job_id);}catch{continue;}
      if(job.state==='complete') {
        await change(record.id,{type:'capture',source:'windows',fiscal:job.result.fiscal,
          attempt_id:record.attempt_id,digest:record.digest,total_cents:job.result.total_cents});
      }
      if(record.helper_state===job.state && (record.helper_error || '')===(job.error || '') && job.state!=='complete')continue;
      await update(rows=>{rows[record.id]={...rows[record.id],helper_state:job.state,helper_error:job.error || '',
        local_issuance_status:job.result?.local_issuance_status || (job.state==='complete'?'issued':'pending'),
        kra_acceptance_status:job.result?.kra_acceptance_status || 'unverified'};return rows;});
    }
  }
  async function afterPayment(order, settings) {
    if (!order.etims_requested) return;
    try {
      const record = await queue(order, order.etims_customer, settings);
      // Each completed checkout submits its own durable Windows job.
      await start(record.id);
    } catch (error) {
      window.alert('Sale paid successfully. eTIMS: '+error.message+' Your normal receipt is available; continue from Admin → eTIMS.');
    }
  }
  async function manual(record) {
    const f = record.fiscal || {}, e = core.escape;
    const overlay = document.createElement('div'); overlay.className = 'qty-popup-overlay etims-dialog-overlay';
    overlay.innerHTML = `<form class="qty-popup etims-dialog"><h3>Record official KRA invoice</h3><p>POS receipt ${e(record.receipt_no)}. Copy only genuine details from the official invoice. Saving a CU blocks duplicate generation.</p>${[['cu_invoice_number','CU Invoice Number (required)'],['scu_id','SCU ID'],['receipt_signature','Receipt Signature'],['invoice_number','Invoice Number'],['invoice_date','Invoice Date']].map(([k,label])=>`<label>${label}<input name="${k}" class="field" maxlength="160" value="${e(f[k])}" ${k==='cu_invoice_number'?'required':''}></label>`).join('')}<label>Official QR image (PNG / JPEG / WebP)<input name="qr" type="file" accept="image/png,image/jpeg,image/webp"></label><p>Optional fields can be completed later. A CU entered manually is marked as manually recorded.</p><p role="status" data-msg></p><div class="qty-popup-actions"><button type="button" class="ghost" data-close>Cancel</button><button class="primary" type="submit">Save KRA details</button></div></form>`;
    document.body.append(overlay);
    overlay.querySelector('[data-close]').onclick = () => overlay.remove();
    overlay.querySelector('form').onsubmit = async event => {
      event.preventDefault(); const form = event.target, button = form.querySelector('[type=submit]');
      button.disabled = true;
      try {
        const data = Object.fromEntries(new FormData(form)); delete data.qr;
        const file = form.elements.qr.files[0];
        if (file) {
          if (!['image/png','image/jpeg','image/webp'].includes(file.type) || file.size > 350000) throw Error('Choose a QR image smaller than 350 KB.');
          data.qr_image = await new Promise((resolve,reject) => { const reader=new FileReader(); reader.onload=()=>resolve(reader.result); reader.onerror=reject; reader.readAsDataURL(file); });
        } else data.qr_image = f.qr_image || '';
        await change(record.id, {type:'capture', source:'manual', fiscal:data, actor:localStorage.getItem('pos_employee_id') || 'cashier'});
        // The extension also keeps a duplicate block, including after a stale POS restore.
        try { await bridge('recorded', {record:(await ledger())[record.id]}, 1500); } catch (_) {}
        overlay.remove();
      } catch (error) { form.querySelector('[data-msg]').textContent = error.message; }
      finally { button.disabled = false; }
    };
  }
  async function checkedAbsent(record) {
    throw Error('Automatic reset is disabled. Recover the same Windows job or record the existing genuine invoice manually.');
  }
  async function list() { return Object.values(await ledger()).filter(r=>r.shop_id===scope()).sort((a,b)=>b.created_at.localeCompare(a.created_at)); }
  function checkoutMarkup() {
    return `<fieldset class="etims-checkout"><label style="display:flex;align-items:center;gap:8px;font-weight:600;cursor:pointer;"><input type="checkbox" id="generateEtims"> Generate eTIMS Invoice</label><div id="etimsCustomerOptions" hidden style="margin-top:12px;"><label style="display:block;margin-bottom:6px;font-weight:600;font-size:12px;">Customer Option</label><div class="etims-cust-type-group" style="display:flex;gap:16px;margin-bottom:10px;"><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-weight:600;"><input type="radio" name="etimsCustomerType" id="etimsTypeWalkIn" value="walkin" checked> Walk-In</label><label style="display:inline-flex;align-items:center;gap:6px;cursor:pointer;font-weight:600;"><input type="radio" name="etimsCustomerType" id="etimsTypeRegistered" value="registered"> Registered</label></div><div id="etimsWalkInNotice" style="padding:8px 12px;background:var(--card,#f3f4f6);border:1px solid var(--line,#e5e7eb);border-radius:6px;margin-bottom:10px;font-size:12px;color:var(--muted,#4b5563);">⚡ Customer Name: <strong>Walk-In</strong> · PIN: <strong>NA</strong></div><div id="etimsCustomerFields" hidden><label>Buyer name *<input id="etimsName" class="field" type="text" maxlength="120" autocomplete="name" placeholder="Customer or business name"></label><label>Buyer KRA PIN *<input id="etimsPin" class="field" maxlength="11" autocapitalize="characters" placeholder="e.g. A012345678Z"></label><details style="margin-top:8px;"><summary style="cursor:pointer;font-size:12px;">Optional buyer details</summary><label>Phone<input id="etimsPhone" class="field" type="tel" maxlength="40" autocomplete="tel"></label><label>Email<input id="etimsEmail" class="field" type="email" maxlength="120" autocomplete="email"></label><label>Address<input id="etimsAddress" class="field" maxlength="240"></label><label>Remarks<input id="etimsRemarks" class="field" maxlength="500"></label></details></div></div></fieldset>`;
  }
  function enrich(order,products) {
    for(const item of order.items || []) {
      const product=products.find(p=>p.id===item.menu_item_id);
      item.etims_product_key=item.etims_product_key || (product?'catalog:'+product.id:'manual:'+String(item.name).trim().toLowerCase());
      if(product) {
        if(product.expiry_date)item.expiry_date=product.expiry_date;
        if(product.batch_no && !item.batch_no)item.batch_no=product.batch_no;
        item.etims_registration={...(product.etims_registration || {}),...(item.etims_registration || {})};
        if(Number.isSafeInteger(product.cost_cents) && item.etims_registration.unit_cost_cents===undefined) item.etims_registration.unit_cost_cents=product.cost_cents;
        const variant=Array.isArray(product.variants)?product.variants.find(v=>v.name===item.variant_info):null;
        const stock=variant?.stock_qty ?? product.stock_qty;
        if(order.status!=='paid' && stock!==undefined && product.unit!=='service')item.etims_inventory={inventory_before_sale:Number(stock),inventory_confirmed:true};
      }
    }
    return order;
  }
  async function registrationDetails(requirements,options,previous={}) {
    const e=core.escape;
    const labels={class_code:'Verified item classification',item_type:'Item type',origin:'Country of origin',package_unit:'Packaging unit',quantity_unit:'Quantity unit',tax_code:'Tax category',unit_cost_cents:'Actual unit purchase cost (KES)',inventory_before_sale:'Actual inventory immediately BEFORE this sale',stock_reason:'Reason for stock adjustment (at least 10 characters)',existing_code:'Existing eTIMS product code',verified:'I confirm the classification, origin, units and tax category are correct',inventory_confirmed:'I confirm the inventory quantity reflects actual stock'};
    const groups={item_type:'24',origin:'05',package_unit:'17',quantity_unit:'10',tax_code:'04'};
    return new Promise((resolve,reject)=>{
      const overlay=document.createElement('div');overlay.className='qty-popup-overlay etims-dialog-overlay';
      overlay.innerHTML=`<form class="qty-popup etims-dialog"><h3>Complete product details</h3><p>These details are missing from the POS and saved eTIMS mappings. They will be remembered for future sales. Stock quantities apply to this sale.</p>${requirements.map((r,index)=>`<fieldset><legend>${e(r.name)}</legend>${r.missing.map(key=>{
        const name=index+':'+key,value=previous[r.product_key]?.[key] ?? r.values?.[key] ?? '';
        if(['verified','inventory_confirmed'].includes(key))return `<label><input type="checkbox" name="${name}" required ${value===true?'checked':''}> ${labels[key]}</label>`;
        let choices=key==='class_code'?(options.classes || []).map(c=>({value:c.ITEM_CLS_CD,label:c.ITEM_CLS_NM})):groups[key]?(options.codes || []).filter(c=>c.CD_CLS===groups[key]).map(c=>({value:c.CD,label:c.CD_NM})):key==='existing_code'?(r.candidates || []).map(c=>({value:c.code,label:c.name})):[];
        if(key==='class_code')return `<label>${labels[key]}<select class="field" name="${name}" data-class-search data-selected="${e(value)}" required><option value="">Select the correct value</option></select></label>`;
        if(choices.length)return `<label>${labels[key]}<select class="field" name="${name}" required><option value="">Select the correct value</option>${choices.map(c=>`<option value="${e(c.value)}" ${String(value)===c.value?'selected':''}>${e(c.value)} - ${e(c.label)}</option>`).join('')}</select></label>`;
        return `<label>${labels[key]}<input class="field" name="${name}" required ${key==='unit_cost_cents'||key==='inventory_before_sale'?'type="number" min="0" step="0.01"':''} ${key==='stock_reason'?'minlength="10"':''} value="${e(key==='unit_cost_cents' && value!==''?Number(value)/100:value)}"></label>`;
      }).join('')}</fieldset>`).join('')}<p data-msg></p><div class="qty-popup-actions"><button type="button" data-cancel>Cancel</button><button class="primary">Confirm details</button></div></form>`;
      document.body.append(overlay);
      overlay.querySelectorAll('[data-class-search]').forEach(select=>window.OraforgeFormControls.searchableSelect(select,
        (options.classes || []).map(row=>({value:row.ITEM_CLS_CD,label:row.ITEM_CLS_NM})), 'classifications by name or code'));
      overlay.querySelector('[data-cancel]').onclick=()=>{overlay.remove();reject(Error('Product registration details were not confirmed.'));};
      overlay.querySelector('form').onsubmit=event=>{
        event.preventDefault();const details=structuredClone(previous);
        try {
          requirements.forEach((r,index)=>{details[r.product_key]={...(r.values || {}),...(details[r.product_key] || {})};r.missing.forEach(key=>{
            const input=event.target.elements[index+':'+key];let value=input.type==='checkbox'?input.checked:input.value.trim();
            if(key==='unit_cost_cents'){const number=Number(value)*100;if(!Number.isSafeInteger(Math.round(number)) || Math.abs(number-Math.round(number))>0.000001)throw Error('Enter purchase cost to two decimal places.');value=Math.round(number);}
            details[r.product_key][key]=value;
          });});
          overlay.remove();resolve(details);
        }catch(error){overlay.querySelector('[data-msg]').textContent=error.message;}
      };
    });
  }
  async function beforePayment(order,settings,customer,payment,products,taxRate) {
    if(!customer.pin || !customer.name)throw Error('Enter the buyer KRA PIN and name.');
    const preview=enrich(structuredClone(order),products || []);
    preview.status='paid';preview.payment_method=payment;
    const rate=Number(settings.tax_rate);
    preview.tax_rate=taxRate!==undefined?Number(taxRate):settings.tax_rate_confirmed===true && Number.isFinite(rate) && rate>0 && rate<=100?rate:0;
    preview.tax_cents=preview.tax_rate?Math.round(Number(preview.total_cents)*preview.tax_rate/(100+preview.tax_rate)):0;
    const sale=core.windowsSnapshot(preview,scope(),settings,customer);
    let details=order.etims_registration_details || {};
    for(let round=0;round<4;round++){
      const result=await request('/preflight',{sale,details});
      if(result.ready)return details;
      details=await registrationDetails(result.requirements,result,details);
    }
    throw Error('Product registration still needs review.');
  }
  async function refreshReceipt() {
    const overlay = document.getElementById('receiptModal');
    if (!overlay?.dataset.etimsId) return;
    const record = (await ledger())[overlay.dataset.etimsId];
    const target = overlay.querySelector('[data-etims-receipt]');
    if (target) target.innerHTML = core.receipt(record);
    // A paid sale is NOT a completed KRA invoice. Wait until the actual issued
    // invoice, all its official fields and original QR are linked to this sale.
    if (overlay.dataset.etimsRequested === 'true' || record) {
      const fiscal = record?.fiscal;
      const ready = record?.status === 'generated' && ['portal','windows'].includes(fiscal?.source) &&
        ['cu_invoice_number','scu_id','receipt_signature','invoice_number','invoice_date','qr_image'].every(key => Boolean(fiscal[key]));
      if (ready && overlay.dataset.etimsConfirmed !== 'true') {
        try { window.focus(); } catch (_) {}
      }
      overlay.dataset.etimsConfirmed = String(ready);
      const button = overlay.querySelector('#receiptPrintBtn');
      if (button) {
        button.disabled = !ready;
        button.textContent = ready ? 'Print final KRA receipt' : 'Waiting for KRA invoice…';
        button.title = ready ? 'Official KRA details and QR captured.' : 'The POS payment is saved. The Windows helper is processing its invoice.';
        if(ready && overlay.dataset.etimsAutoPrint==='true') {
          overlay.dataset.etimsAutoPrint='done';
          setTimeout(()=>{if(overlay.isConnected)button.click();},0);
        }
      }
    }
  }
  function mountReceipt(overlay, order) {
    overlay.dataset.etimsId = identity(order);
    overlay.dataset.etimsRequested = String(Boolean(order.etims_requested || order.etims?.status));
    if (overlay.dataset.etimsRequested === 'true') {
      const button = overlay.querySelector('#receiptPrintBtn');
      if (button) { button.disabled = true; button.textContent = 'Waiting for KRA invoice…'; }
    }
    overlay.etimsReady = refreshReceipt().catch(error => {
      if (order.etims_requested) overlay.querySelector('[data-etims-receipt]').textContent = 'eTIMS details unavailable. Open the eTIMS workspace before reprinting.';
      console.warn(error);
    });
    if (order.status === 'paid') {
      const button=document.createElement('button'); button.type='button';button.className='etims-manage-receipt';button.textContent='Manage eTIMS invoice';
      button.onclick=()=>manage(order).catch(error=>window.alert(error.message));
      overlay.querySelector('.receipt-modal').append(button);
    }
  }
  async function manage(order) {
    const settings = await (await db()).get(`shop:${scope()}:settings`, {});
    let record=await get(order);
    if(!record && !order.etims_requested) return preparePaidSale(order,settings);
    record=record || await queue(order, order.etims_customer, settings);
    const overlay=document.createElement('div'); overlay.className='qty-popup-overlay etims-dialog-overlay';
    overlay.innerHTML=`<section class="qty-popup etims-dialog"><h3>eTIMS ? ${core.escape(record.receipt_no)}</h3><p>${core.escape(record.fiscal?.cu_invoice_number || record.helper_state || record.status)}</p><p>${core.escape(record.helper_error || '')}</p><p data-msg role="status"></p><div class="qty-popup-actions" style="flex-wrap:wrap">${record.status==='pending' && record.snapshot.version===2?'<button data-action="start" class="primary">Issue with Windows helper</button>':''}${record.status==='review_required' && record.snapshot.version===2?'<button data-action="recover" class="primary">Recover this sale</button>':''}<button data-action="manual" class="ghost">${record.status==='generated'?'Complete KRA details':'Enter existing CU manually'}</button><button data-action="close" class="ghost">Close</button></div></section>`;
    document.body.append(overlay);
    overlay.querySelectorAll('[data-action]').forEach(button=>button.onclick=async()=>{
      button.disabled=true;
      try {
        if (button.dataset.action==='start') await start(record.id);
        if (button.dataset.action==='resume') await start(record.id,'resume');
        if (button.dataset.action==='recover') await start(record.id,true);
        if (button.dataset.action==='manual') await manual(record);
        if (button.dataset.action==='absent') await checkedAbsent(record);
        overlay.remove();
      } catch(error) {overlay.querySelector('[data-msg]').textContent=error.message;button.disabled=false;}
    });
  }
  async function preparePaidSale(order,settings) {
    if(order.status!=='paid' || order.is_quote)throw Error('Select a completed genuine sale.');
    const overlay=document.createElement('div');overlay.className='qty-popup-overlay etims-dialog-overlay';
    overlay.innerHTML=`<form class="qty-popup etims-dialog"><h3>Invoice existing POS sale</h3><p>Receipt ${core.escape(order.ticket_no)} · KES ${(order.total_cents/100).toFixed(2)}. Payment and POS stock will remain as recorded.</p>${checkoutMarkup()}<label><input name="newSaleConfirmed" type="checkbox" required> I confirm this real sale has no existing eTIMS invoice.</label><p data-msg role="status"></p><div class="qty-popup-actions"><button type="button" data-cancel>Cancel</button><button class="primary">Issue this sale with eTIMS</button></div></form>`;
    document.body.append(overlay);overlay.querySelector('.etims-checkout > label').remove();
    overlay.querySelector('#etimsCustomerOptions').hidden=false;
    const walkInRadio = overlay.querySelector('#etimsTypeWalkIn');
    const regRadio = overlay.querySelector('#etimsTypeRegistered');
    const walkInNotice = overlay.querySelector('#etimsWalkInNotice');
    const custFields = overlay.querySelector('#etimsCustomerFields');
    const updateCustomerMode = () => {
      const isWalkIn = walkInRadio.checked;
      walkInNotice.hidden = !isWalkIn;
      custFields.hidden = isWalkIn;
      overlay.querySelector('#etimsName').required = !isWalkIn;
      overlay.querySelector('#etimsPin').required = !isWalkIn;
    };
    walkInRadio.onchange = updateCustomerMode;
    regRadio.onchange = updateCustomerMode;
    updateCustomerMode();
    overlay.querySelector('[data-cancel]').onclick=()=>overlay.remove();
    overlay.querySelector('form').onsubmit=async event=>{
      event.preventDefault();const button=event.target.querySelector('button.primary');button.disabled=true;
      try {
        const isWalkIn = walkInRadio.checked;
        const name = isWalkIn ? 'Walk-In' : overlay.querySelector('#etimsName').value.trim();
        const pin = isWalkIn ? 'NA' : overlay.querySelector('#etimsPin').value.trim().toUpperCase();
        if(!name) throw Error('Customer name is required.');
        if(!pin) throw Error('Customer KRA PIN is required.');
        const customer=core.customer({name,pin,
          phone:isWalkIn ? '' : overlay.querySelector('#etimsPhone').value,email:isWalkIn ? '' : overlay.querySelector('#etimsEmail').value,
          billing_address:isWalkIn ? '' : overlay.querySelector('#etimsAddress').value,remarks:isWalkIn ? '' : overlay.querySelector('#etimsRemarks').value});
        const products=await (await db()).get(`shop:${scope()}:items`,[]);
        const details=await beforePayment(order,settings,customer,order.payment_method,products);
        const key=`shop:${scope()}:orders`;
        let prepared;
        await (await db()).update(key,orders=>{
          const current=orders.find(o=>Number(o.id)===Number(order.id) && o.ticket_no===order.ticket_no);
          if(!current || current.status!=='paid' || current.total_cents!==order.total_cents || JSON.stringify(current.items)!==JSON.stringify(order.items))throw Error('The original paid sale changed. Reopen its receipt.');
          if(current.etims_requested)throw Error('This paid sale already has an invoice request. Recover it from the workspace.');
          enrich(current,products);current.etims_requested=true;current.etims_customer=customer;
          if (customer.name) current.customer_name = customer.name;
          if (customer.phone) current.customer_phone = customer.phone;
          if (customer.pin) current.customer_kra_pin = customer.pin;
          if (customer.email) current.customer_email = customer.email;
          if (customer.billing_address) current.customer_billing_address = customer.billing_address;
          if (customer.remarks) current.customer_remarks = customer.remarks;
          current.etims_registration_details=details;current.etims_shop_id=scope();prepared=structuredClone(current);return orders;
        },[]);
        const record=await queue(prepared,customer,settings);overlay.remove();await start(record.id);
      } catch(error){overlay.querySelector('[data-msg]').textContent=error.message;button.disabled=false;}
    };
  }
  window.addEventListener('oraforge-etims-changed', () => { refreshReceipt().catch(console.warn); });
  window.OraforgeEtims = {scope, identity, queue, get, attach, list, start, sync, manual, checkedAbsent, checkoutMarkup, beforePayment, enrich, afterPayment, bridge, mountReceipt, manage, request};
  let syncing = false;
  const refresh = async () => {
    // Continue pending fiscal capture while the native eTIMS window has focus.
    if (syncing) return;
    syncing = true; try { await sync(); } catch (_) {} finally { syncing = false; }
  };
  window.addEventListener('focus', () => refresh());
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refresh();});
  setInterval(() => refresh(), 1500);
  setTimeout(() => refresh(), 1000);
})();
