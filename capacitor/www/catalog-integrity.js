(() => {
  const DEFAULT_SHOP_ID = 'shop_eity_fit_hardware';

  const textKey = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');

  function productKey(name) {
    let key = textKey(name);

    // Known EITY FIT spelling / formatting aliases that are the same product.
    if (key === 'rowl bolts m10') key = 'rawl bolts m10';
    if (key === 'ppr pain socket 20mm') key = 'ppr plain socket 20mm';
    if (key === 'adpt socket 32mmx3/4" f') key = 'adpt socket 32x3/4 f';

    if (/^pvc cup plugs 11\/4"?$/.test(key)) key = 'pvc plug 1 1/4';
    if (/^pvc cup plugs 11\/2"?$/.test(key)) key = 'pvc plug 1 1/2';
    if (/^pvc cup plugs 2"?$/.test(key)) key = 'pvc plug 2';
    if (/^pvc cup plugs 3"?$/.test(key)) key = 'pvc plug 3';
    if (/^pvc cup plugs 4"?$/.test(key)) key = 'pvc plug 4';
    if (/^pvc plug 3"?$/.test(key)) key = 'pvc plug 3';
    if (/^pvc plug 4"?$/.test(key)) key = 'pvc plug 4';

    if (key === 'pvc bends 2') key = 'pvc bends 2 x 90';
    if (key === 'tower bolt 4') key = 'tower bolt 4" - alluminium';
    if (key === 'wall plugs 12mm') key = 'wall plugs 12mm - big';

    return key;
  }

  function preferredName(key, fallback) {
    return ({
      'rawl bolts m10': 'Rawl Bolts M10',
      'ppr plain socket 20mm': 'Ppr Plain socket 20mm',
      'adpt socket 32x3/4 f': 'Adpt Socket 32x3/4 F',
      'pvc plug 1 1/4': 'Pvc Plug 1 1/4',
      'pvc plug 1 1/2': 'Pvc Plug 1 1/2',
      'pvc plug 2': 'Pvc Plug 2',
      'pvc plug 3': 'Pvc Plug 3"',
      'pvc plug 4': 'Pvc Plug 4"',
      'pvc bends 2 x 90': 'Pvc Bends 2 X 90',
      'tower bolt 4" - alluminium': 'Tower Bolt 4" - Alluminium',
      'wall plugs 12mm - big': 'Wall Plugs 12mm - big',
    })[key] || fallback;
  }

  function countRefs(orders) {
    const refs = new Map();
    for (const order of orders || []) {
      for (const line of (order && Array.isArray(order.items) ? order.items : [])) {
        const id = Number(line.menu_item_id);
        if (Number.isFinite(id)) refs.set(id, (refs.get(id) || 0) + 1);
      }
    }
    return refs;
  }

  function assertUnique(items, candidate, excludeId = null) {
    const active = Number(candidate?.active ?? 1) === 1;
    if (!active) return;

    const name = productKey(candidate?.name);
    const sku = String(candidate?.sku || '').trim();
    const barcode = String(candidate?.barcode || '').trim();

    for (const row of items || []) {
      if (excludeId != null && Number(row.id) === Number(excludeId)) continue;
      if (Number(row.active ?? 1) !== 1) continue;

      if (name && productKey(row.name) === name) {
        throw new Error('Another active product already uses this product name.');
      }
      if (sku && String(row.sku || '').trim() === sku) {
        throw new Error('Another active product already uses this SKU.');
      }
      if (barcode && String(row.barcode || '').trim() === barcode) {
        throw new Error('Another active product already uses this barcode.');
      }
    }
  }

  async function run() {
    if (!window.OraforgeShops) return { skipped: true, reason: 'shop registry unavailable' };
    if (window.OraforgeDBReady) await window.OraforgeDBReady;

    // Ensure the default hardware shop and its seeded local collections exist.
    await window.OraforgeShops.list();

    const itemKey = `shop:${DEFAULT_SHOP_ID}:items`;
    const orderKey = `shop:${DEFAULT_SHOP_ID}:orders`;
    let items = await window.OraforgeShops.getGlobal(itemKey, []);
    let orders = await window.OraforgeShops.getGlobal(orderKey, []);

    if (!Array.isArray(items) || items.length === 0) {
      return { skipped: true, reason: 'no hardware items' };
    }
    if (!Array.isArray(orders)) orders = [];

    const refs = countRefs(orders);
    const groups = new Map();

    for (const row of items) {
      const key = productKey(row.name);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const remap = new Map();
    const cleaned = [];
    let removed = 0;

    for (const [key, group] of groups.entries()) {
      if (group.length === 1) {
        cleaned.push({ ...group[0] });
        continue;
      }

      group.sort((a, b) => {
        const refDiff = (refs.get(Number(b.id)) || 0) - (refs.get(Number(a.id)) || 0);
        if (refDiff) return refDiff;
        return Number(a.id || 0) - Number(b.id || 0);
      });

      const winner = { ...group[0] };
      winner.name = preferredName(key, winner.name);
      winner.stock_qty = Math.max(...group.map(row => Number(row.stock_qty || 0)));
      cleaned.push(winner);

      for (const loser of group.slice(1)) {
        remap.set(Number(loser.id), Number(winner.id));
        removed += 1;
      }
    }

    if (remap.size) {
      orders = orders.map(order => ({
        ...order,
        items: Array.isArray(order.items)
          ? order.items.map(line => {
              const replacement = remap.get(Number(line.menu_item_id));
              return replacement ? { ...line, menu_item_id: replacement } : line;
            })
          : order.items,
      }));
    }

    // Reassign duplicate SKUs only when the rows are different products.
    const refsAfterMerge = countRefs(orders);
    const usedSkus = new Set();
    let maxNumericSku = 0;

    for (const row of cleaned) {
      const sku = String(row.sku || '').trim();
      if (sku) usedSkus.add(sku);
      if (/^\d+$/.test(sku)) maxNumericSku = Math.max(maxNumericSku, Number(sku));
    }

    const skuGroups = new Map();
    for (const row of cleaned) {
      const sku = String(row.sku || '').trim();
      if (!sku) continue;
      if (!skuGroups.has(sku)) skuGroups.set(sku, []);
      skuGroups.get(sku).push(row);
    }

    let skuFixed = 0;
    for (const group of skuGroups.values()) {
      if (group.length < 2) continue;

      group.sort((a, b) => {
        const refDiff = (refsAfterMerge.get(Number(b.id)) || 0) - (refsAfterMerge.get(Number(a.id)) || 0);
        if (refDiff) return refDiff;
        return Number(a.id || 0) - Number(b.id || 0);
      });

      for (const row of group.slice(1)) {
        let nextSku;
        do {
          maxNumericSku += 1;
          nextSku = String(maxNumericSku);
        } while (usedSkus.has(nextSku));

        row.sku = nextSku;
        usedSkus.add(nextSku);
        skuFixed += 1;
      }
    }

    // Duplicate real-world barcodes are unsafe. Keep the first and clear repeats.
    const seenBarcodes = new Set();
    let barcodeFixed = 0;
    for (const row of cleaned) {
      const barcode = String(row.barcode || '').trim();
      if (!barcode) continue;
      if (seenBarcodes.has(barcode)) {
        row.barcode = '';
        barcodeFixed += 1;
      } else {
        seenBarcodes.add(barcode);
      }
    }

    await window.OraforgeShops.setGlobal(itemKey, cleaned);
    if (remap.size) await window.OraforgeShops.setGlobal(orderKey, orders);
    await window.OraforgeShops.setGlobal(`shop:${DEFAULT_SHOP_ID}:catalog_integrity`, {
      version: 2,
      checked_at: Date.now(),
      active_items: cleaned.length,
      removed_duplicates: removed,
      reassigned_skus: skuFixed,
      cleared_duplicate_barcodes: barcodeFixed,
    });

    console.info('[catalog-integrity]', {
      before: items.length,
      after: cleaned.length,
      removed,
      skuFixed,
      barcodeFixed,
    });

    return {
      before: items.length,
      after: cleaned.length,
      removed,
      skuFixed,
      barcodeFixed,
    };
  }

  window.OraforgeCatalogIntegrity = { run, assertUnique, productKey };
  window.OraforgeCatalogIntegrityReady = run().catch(err => {
    console.error('Catalog integrity repair failed', err);
    return { error: err.message };
  });
})();
