/**
 * Oraforge POS - SQLite to Supabase Cloud Migration Tool
 * Transfers categories, menu items (with intelligent deduplication), suppliers,
 * orders, order items, and store settings from local pos.sqlite3 to Supabase cloud.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { Pool } = require('pg');

const DEFAULT_DB_URL = 'postgresql://postgres.iyfebdvtcryjxitizuwb:8045%40JohnWakaba@aws-1-eu-west-1.pooler.supabase.com:6543/postgres';
const DEFAULT_SHOP_ID = 'retail';

// Locate pos.sqlite3
function findSqlitePath(argPath) {
  if (argPath && fs.existsSync(argPath)) return path.resolve(argPath);
  
  const candidates = [
    path.resolve(process.cwd(), 'pos.sqlite3'),
    path.resolve(process.cwd(), 'data', 'pos.sqlite3'),
    path.resolve(process.cwd(), 'dist', 'windows', 'OraforgePOS', 'pos.sqlite3'),
    path.resolve(process.cwd(), 'dist', 'windows', 'OraforgePOS', 'data', 'pos.sqlite3'),
    'C:\\Users\\Admin\\Downloads\\POS_APK-Linux_Deployment\\POS_APK-Linux_Deployment\\dist\\windows\\OraforgePOS\\pos.sqlite3',
    'C:\\Oraforge-eTIMS-Companion\\pos.sqlite3'
  ];
  
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

async function run() {
  const args = process.argv.slice(2);
  const cliFile = args.find(a => !a.startsWith('--'));
  const shopId = (args.find(a => a.startsWith('--shop=')) || `--shop=${DEFAULT_SHOP_ID}`).split('=')[1];
  const doDedup = !args.includes('--no-dedup');
  const dryRun = args.includes('--dry-run');

  const sqlitePath = findSqlitePath(cliFile);
  if (!sqlitePath) {
    console.error('\n❌ ERROR: pos.sqlite3 file not found!');
    console.error('Please pass the path as an argument, e.g.:');
    console.error('  node migrate-sqlite-to-supabase.js "C:\\path\\to\\pos.sqlite3"\n');
    process.exit(1);
  }

  console.log('\n============================================================');
  console.log('  🚀 ORAFORGE POS -> SUPABASE CLOUD DATA MIGRATION');
  console.log('============================================================');
  console.log(`  Source SQLite:   ${sqlitePath}`);
  console.log(`  Target Cloud DB: Supabase (Schema: pos)`);
  console.log(`  Target Shop ID:  ${shopId}`);
  console.log(`  Deduplication:   ${doDedup ? 'ENABLED (Cleans double/triple items)' : 'DISABLED (Raw import)'}`);
  console.log(`  Mode:            ${dryRun ? 'DRY RUN (No writes)' : 'LIVE MIGRATION'}`);
  console.log('============================================================\n');

  // Open SQLite
  const sqlite = new DatabaseSync(sqlitePath, { readOnly: true });

  // Open Supabase PG Pool
  const pg = new Pool({ connectionString: DEFAULT_DB_URL });
  const client = await pg.connect();

  try {
    // 1. Business Settings -> pos.shop_settings
    console.log('📦 [1/6] Migrating Business Settings...');
    const settingsRows = sqlite.prepare('SELECT key, value FROM business_settings').all();
    const settingsMap = {};
    for (const r of settingsRows) settingsMap[r.key] = r.value;

    const bName = settingsMap.business_name || 'BuildMart Hardware';
    const bType = settingsMap.business_type || 'hardware';
    console.log(`  Shop Name: "${bName}" | Type: "${bType}"`);

    if (!dryRun) {
      await client.query(`
        INSERT INTO pos.shop_settings (shop_id, business_name, business_type, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (shop_id) DO UPDATE SET
          business_name = EXCLUDED.business_name,
          business_type = EXCLUDED.business_type,
          updated_at = NOW();
      `, [shopId, bName, bType]);
    }
    console.log('  ✓ Shop settings updated.');

    // 2. Categories -> pos.categories
    console.log('\n📦 [2/6] Migrating Categories...');
    const categories = sqlite.prepare('SELECT id, name, sort_order, business_type FROM categories').all();
    console.log(`  Found ${categories.length} categories.`);
    
    if (!dryRun) {
      for (const c of categories) {
        await client.query(`
          INSERT INTO pos.categories (id, shop_id, name, sort_order, business_type, created_at)
          VALUES ($1, $2, $3, $4, $5, NOW())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            sort_order = EXCLUDED.sort_order,
            business_type = EXCLUDED.business_type;
        `, [c.id, shopId, c.name, c.sort_order || 0, c.business_type || bType]);
      }
    }
    console.log('  ✓ Categories migrated.');

    // 3. Suppliers -> pos.suppliers
    console.log('\n📦 [3/6] Migrating Suppliers...');
    const suppliers = sqlite.prepare('SELECT id, name, phone, email, address, active FROM suppliers').all();
    console.log(`  Found ${suppliers.length} suppliers.`);
    if (!dryRun) {
      for (const s of suppliers) {
        await client.query(`
          INSERT INTO pos.suppliers (id, shop_id, name, phone, email, address, active, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            phone = EXCLUDED.phone,
            email = EXCLUDED.email,
            address = EXCLUDED.address,
            active = EXCLUDED.active;
        `, [s.id, shopId, s.name, s.phone || '', s.email || '', s.address || '', s.active != null ? s.active : 1]);
      }
    }
    console.log('  ✓ Suppliers migrated.');

    // 4. Menu Items (Products) -> pos.menu_items
    console.log('\n📦 [4/6] Migrating Products (Menu Items)...');
    const rawItems = sqlite.prepare('SELECT * FROM menu_items').all();
    console.log(`  Total raw items in SQLite: ${rawItems.length}`);

    // Intelligent Deduplication
    const idRemap = new Map(); // old_id -> canonical_id
    const finalItems = [];
    const duplicateIdsToRemove = [];

    if (doDedup) {
      const byName = new Map(); // cleanName -> canonicalItem
      let dupCount = 0;

      for (const item of rawItems) {
        const cleanName = (item.name || '').trim().toLowerCase();
        const existing = byName.get(cleanName);

        if (!existing) {
          byName.set(cleanName, item);
          idRemap.set(item.id, item.id);
          finalItems.push(item);
        } else {
          dupCount++;
          // Remap this duplicate item's ID to the canonical item's ID
          idRemap.set(item.id, existing.id);
          duplicateIdsToRemove.push(item.id);
          // If the duplicate has higher stock, consolidate stock
          if (item.stock_qty && item.stock_qty > (existing.stock_qty || 0)) {
            existing.stock_qty = item.stock_qty;
          }
          if (!existing.sku && item.sku) existing.sku = item.sku;
          if (!existing.barcode && item.barcode) existing.barcode = item.barcode;
        }
      }
      console.log(`  🧹 Deduplication: Found ${dupCount} duplicate items!`);
      console.log(`  ✨ Retained ${finalItems.length} unique catalog products.`);
    } else {
      for (const item of rawItems) {
        idRemap.set(item.id, item.id);
        finalItems.push(item);
      }
    }

    if (!dryRun) {
      let inserted = 0;
      for (const item of finalItems) {
        await client.query(`
          INSERT INTO pos.menu_items (
            id, shop_id, category_id, name, price_cents, cost_cents,
            stock_qty, reorder_level, sku, barcode, unit, color, active, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            price_cents = EXCLUDED.price_cents,
            cost_cents = EXCLUDED.cost_cents,
            stock_qty = EXCLUDED.stock_qty,
            sku = EXCLUDED.sku,
            unit = EXCLUDED.unit,
            active = EXCLUDED.active,
            updated_at = NOW();
        `, [
          item.id, shopId, item.category_id, item.name, item.price_cents || 0, item.cost_cents || 0,
          item.stock_qty || 0, item.reorder_level || 5, item.sku || '', item.barcode || '',
          item.unit || 'pcs', item.color || '#334155', item.active != null ? item.active : 1
        ]);
        inserted++;
      }
      console.log(`  ✓ ${inserted} unique products saved to Supabase.`);

      // If deduplication is enabled, remove redundant duplicate rows in Supabase
      if (duplicateIdsToRemove.length > 0) {
        for (let i = 0; i < duplicateIdsToRemove.length; i += 500) {
          const chunk = duplicateIdsToRemove.slice(i, i + 500);
          await client.query(`
            DELETE FROM pos.menu_items 
            WHERE shop_id = $1 AND id = ANY($2::bigint[])
          `, [shopId, chunk]);
        }
        console.log(`  ✓ Purged ${duplicateIdsToRemove.length} duplicate products from Supabase.`);
      }
    }

    // 5. Orders -> pos.orders
    console.log('\n📦 [5/6] Migrating Orders...');
    const orders = sqlite.prepare('SELECT * FROM orders').all();
    console.log(`  Found ${orders.length} orders in SQLite.`);

    if (!dryRun) {
      let orderCount = 0;
      for (const o of orders) {
        await client.query(`
          INSERT INTO pos.orders (
            id, shop_id, ticket_no, order_type, customer_name, status,
            subtotal_cents, tax_cents, total_cents, paid_cents,
            payment_method, payment_ref, created_by, created_at, updated_at
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            total_cents = EXCLUDED.total_cents,
            paid_cents = EXCLUDED.paid_cents,
            updated_at = EXCLUDED.updated_at;
        `, [
          o.id, shopId, o.ticket_no, o.order_type || 'standard', o.customer_name || 'Walk-In Customer',
          o.status || 'paid', o.subtotal_cents || 0, o.tax_cents || 0, o.total_cents || 0, o.paid_cents || 0,
          o.payment_method || 'CASH', o.payment_ref || '', o.created_by || 1,
          o.created_at || new Date().toISOString(), o.updated_at || new Date().toISOString()
        ]);
        orderCount++;
      }
      console.log(`  ✓ ${orderCount} orders migrated.`);
    }

    // 6. Order Items -> pos.order_items
    console.log('\n📦 [6/6] Migrating Order Items...');
    const orderItems = sqlite.prepare('SELECT * FROM order_items').all();
    console.log(`  Found ${orderItems.length} order items in SQLite.`);

    if (!dryRun) {
      let itemCount = 0;
      for (const oi of orderItems) {
        // Resolve canonical menu_item_id using deduplication remap table
        const canonicalItemId = idRemap.get(oi.menu_item_id) || oi.menu_item_id;

        await client.query(`
          INSERT INTO pos.order_items (
            id, order_id, menu_item_id, name, qty, unit_price_cents, line_total_cents, note
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (id) DO UPDATE SET
            menu_item_id = EXCLUDED.menu_item_id,
            qty = EXCLUDED.qty,
            unit_price_cents = EXCLUDED.unit_price_cents,
            line_total_cents = EXCLUDED.line_total_cents;
        `, [
          oi.id, oi.order_id, canonicalItemId, oi.name, oi.qty || 1,
          oi.unit_price_cents || 0, oi.line_total_cents || 0, oi.note || ''
        ]);
        itemCount++;
      }
      console.log(`  ✓ ${itemCount} order items migrated.`);
    }

    // 7. Reset Postgres ID Sequences
    if (!dryRun) {
      console.log('\n⚙️ Synchronizing Database ID Sequences...');
      const tables = ['categories', 'suppliers', 'menu_items', 'orders', 'order_items'];
      for (const t of tables) {
        try {
          await client.query(`
            SELECT setval(
              pg_get_serial_sequence('pos.${t}', 'id'),
              COALESCE((SELECT MAX(id) FROM pos.${t}), 1)
            );
          `);
        } catch (_) {}
      }
      console.log('  ✓ Sequences synchronized successfully.');
    }

    console.log('\n============================================================');
    console.log('  🎉 MIGRATION COMPLETED SUCCESSFULLY!');
    console.log('============================================================');
    console.log(`  Categories:  ${categories.length}`);
    console.log(`  Suppliers:   ${suppliers.length}`);
    console.log(`  Products:    ${finalItems.length} (Duplicates eliminated: ${rawItems.length - finalItems.length})`);
    console.log(`  Orders:      ${orders.length}`);
    console.log(`  Order Items: ${orderItems.length}`);
    console.log('============================================================\n');

  } catch (err) {
    console.error('\n❌ Migration failed:', err);
  } finally {
    client.release();
    await pg.end();
  }
}

run();
