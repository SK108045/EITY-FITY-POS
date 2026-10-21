#!/usr/bin/env python3
"""
Oraforge POS - SQLite to Supabase Cloud Migration Tool (Python Edition)
Migrates categories, menu items (with intelligent deduplication), suppliers,
orders, order items, and business settings from local pos.sqlite3 to Supabase cloud.
"""

import sys
import os
import sqlite3
import argparse
from pathlib import Path

DEFAULT_DB_URL = "postgresql://postgres.iyfebdvtcryjxitizuwb:8045%40JohnWakaba@aws-1-eu-west-1.pooler.supabase.com:6543/postgres"
if hasattr(sys.stdout, 'reconfigure'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
    except Exception:
        pass
DEFAULT_SHOP_ID = "retail"

def find_sqlite_file(explicit_path=None):
    if explicit_path and Path(explicit_path).is_file():
        return Path(explicit_path).resolve()
    candidates = [
        Path.cwd() / "pos.sqlite3",
        Path.cwd() / "data" / "pos.sqlite3",
        Path.cwd() / "dist" / "windows" / "OraforgePOS" / "pos.sqlite3",
        Path.cwd() / "dist" / "windows" / "OraforgePOS" / "data" / "pos.sqlite3",
        Path(r"C:\Users\Admin\Downloads\POS_APK-Linux_Deployment\POS_APK-Linux_Deployment\dist\windows\OraforgePOS\pos.sqlite3"),
        Path(r"C:\Oraforge-eTIMS-Companion\pos.sqlite3")
    ]
    for c in candidates:
        if c.is_file():
            return c.resolve()
    return None

def main():
    parser = argparse.ArgumentParser(description="Migrate Oraforge POS SQLite data to Supabase Cloud")
    parser.add_argument("sqlite_file", nargs="?", help="Path to pos.sqlite3 file")
    parser.add_argument("--shop", default=DEFAULT_SHOP_ID, help="Target shop ID in Supabase (default: retail)")
    parser.add_argument("--db-url", default=DEFAULT_DB_URL, help="Supabase PostgreSQL connection string")
    parser.add_argument("--no-dedup", action="store_true", help="Disable deduplication and perform raw import")
    parser.add_argument("--dry-run", action="store_true", help="Validate and preview without writing to Supabase")
    args = parser.parse_args()

    sqlite_path = find_sqlite_file(args.sqlite_file)
    if not sqlite_path:
        print("\n❌ ERROR: pos.sqlite3 file was not found!")
        print("Please provide the file path, e.g.:")
        print("  python migrate_to_supabase.py \"C:\\path\\to\\pos.sqlite3\"\n")
        sys.exit(1)

    try:
        import psycopg2
        from psycopg2.extras import execute_batch
    except ImportError:
        print("\n❌ Error: psycopg2 is required for Python migration.")
        print("Install it with: pip install psycopg2-binary")
        print("Or simply use Transfer-Data-To-Cloud.cmd (which uses pre-bundled Node.js)!\n")
        sys.exit(1)

    print("\n" + "=" * 60)
    print("  🚀 ORAFORGE POS -> SUPABASE CLOUD DATA MIGRATION")
    print("=" * 60)
    print(f"  Source SQLite:   {sqlite_path}")
    print(f"  Target Cloud DB: Supabase (Schema: pos)")
    print(f"  Target Shop ID:  {args.shop}")
    print(f"  Deduplication:   {'DISABLED (Raw import)' if args.no_dedup else 'ENABLED (Cleans double/triple items)'}")
    print(f"  Mode:            {'DRY RUN (No writes)' if args.dry_run else 'LIVE MIGRATION'}")
    print("=" * 60 + "\n")

    sqlite_conn = sqlite3.connect(sqlite_path)
    sqlite_conn.row_factory = sqlite3.Row
    sc = sqlite_conn.cursor()

    pg_conn = psycopg2.connect(args.db_url)
    pc = pg_conn.cursor()

    try:
        # 1. Business Settings -> pos.shop_settings
        print("📦 [1/6] Migrating Business Settings...")
        settings_rows = sc.execute("SELECT key, value FROM business_settings").fetchall()
        settings_map = {r["key"]: r["value"] for r in settings_rows}
        b_name = settings_map.get("business_name", "BuildMart Hardware")
        b_type = settings_map.get("business_type", "hardware")
        print(f"  Shop Name: \"{b_name}\" | Type: \"{b_type}\"")

        if not args.dry_run:
            pc.execute("""
                INSERT INTO pos.shop_settings (shop_id, business_name, business_type, updated_at)
                VALUES (%s, %s, %s, NOW())
                ON CONFLICT (shop_id) DO UPDATE SET
                  business_name = EXCLUDED.business_name,
                  business_type = EXCLUDED.business_type,
                  updated_at = NOW();
            """, (args.shop, b_name, b_type))
        print("  ✓ Shop settings updated.")

        # 2. Categories -> pos.categories
        print("\n📦 [2/6] Migrating Categories...")
        categories = sc.execute("SELECT id, name, sort_order, business_type FROM categories").fetchall()
        print(f"  Found {len(categories)} categories.")
        if not args.dry_run:
            for c in categories:
                pc.execute("""
                    INSERT INTO pos.categories (id, shop_id, name, sort_order, business_type, created_at)
                    VALUES (%s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (id) DO UPDATE SET
                      name = EXCLUDED.name,
                      sort_order = EXCLUDED.sort_order,
                      business_type = EXCLUDED.business_type;
                """, (c["id"], args.shop, c["name"], c["sort_order"] or 0, c["business_type"] or b_type))
        print("  ✓ Categories migrated.")

        # 3. Suppliers -> pos.suppliers
        print("\n📦 [3/6] Migrating Suppliers...")
        suppliers = sc.execute("SELECT id, name, phone, email, address, active FROM suppliers").fetchall()
        print(f"  Found {len(suppliers)} suppliers.")
        if not args.dry_run:
            for s in suppliers:
                pc.execute("""
                    INSERT INTO pos.suppliers (id, shop_id, name, phone, email, address, active, created_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
                    ON CONFLICT (id) DO UPDATE SET
                      name = EXCLUDED.name,
                      phone = EXCLUDED.phone,
                      email = EXCLUDED.email,
                      address = EXCLUDED.address,
                      active = EXCLUDED.active;
                """, (s["id"], args.shop, s["name"], s["phone"] or "", s["email"] or "", s["address"] or "", 1 if s["active"] is None else s["active"]))
        print("  ✓ Suppliers migrated.")

        # 4. Products (Menu Items) -> pos.menu_items
        print("\n📦 [4/6] Migrating Products (Menu Items)...")
        raw_items = sc.execute("SELECT * FROM menu_items").fetchall()
        print(f"  Total raw items in SQLite: {len(raw_items)}")

        id_remap = {}
        final_items = []
        dup_ids_to_remove = []

        if not args.no_dedup:
            by_name = {}
            for row in raw_items:
                item = dict(row)
                clean_name = (item["name"] or "").strip().lower()
                existing = by_name.get(clean_name)
                if not existing:
                    by_name[clean_name] = item
                    id_remap[item["id"]] = item["id"]
                    final_items.append(item)
                else:
                    id_remap[item["id"]] = existing["id"]
                    dup_ids_to_remove.append(item["id"])
                    if item.get("stock_qty") and item["stock_qty"] > (existing.get("stock_qty") or 0):
                        existing["stock_qty"] = item["stock_qty"]
                    if not existing.get("sku") and item.get("sku"):
                        existing["sku"] = item["sku"]
                    if not existing.get("barcode") and item.get("barcode"):
                        existing["barcode"] = item["barcode"]
            print(f"  🧹 Deduplication: Found {len(dup_ids_to_remove)} duplicate items!")
            print(f"  ✨ Retained {len(final_items)} unique catalog products.")
        else:
            for row in raw_items:
                item = dict(row)
                id_remap[item["id"]] = item["id"]
                final_items.append(item)

        if not args.dry_run:
            for item in final_items:
                pc.execute("""
                    INSERT INTO pos.menu_items (
                      id, shop_id, category_id, name, price_cents, cost_cents,
                      stock_qty, reorder_level, sku, barcode, unit, color, active, created_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, NOW(), NOW())
                    ON CONFLICT (id) DO UPDATE SET
                      name = EXCLUDED.name,
                      price_cents = EXCLUDED.price_cents,
                      cost_cents = EXCLUDED.cost_cents,
                      stock_qty = EXCLUDED.stock_qty,
                      sku = EXCLUDED.sku,
                      unit = EXCLUDED.unit,
                      active = EXCLUDED.active,
                      updated_at = NOW();
                """, (
                    item["id"], args.shop, item["category_id"], item["name"], item["price_cents"] or 0, item["cost_cents"] or 0,
                    item["stock_qty"] or 0, item["reorder_level"] or 5, item["sku"] or "", item["barcode"] or "",
                    item["unit"] or "pcs", item["color"] or "#334155", 1 if item["active"] is None else item["active"]
                ))
            print(f"  ✓ {len(final_items)} unique products saved to Supabase.")

            if dup_ids_to_remove:
                pc.execute("DELETE FROM pos.menu_items WHERE shop_id = %s AND id = ANY(%s)", (args.shop, dup_ids_to_remove))
                print(f"  ✓ Purged {len(dup_ids_to_remove)} duplicate products from Supabase.")

        # 5. Orders -> pos.orders
        print("\n📦 [5/6] Migrating Orders...")
        orders = sc.execute("SELECT * FROM orders").fetchall()
        print(f"  Found {len(orders)} orders in SQLite.")
        if not args.dry_run:
            for o in orders:
                pc.execute("""
                    INSERT INTO pos.orders (
                      id, shop_id, ticket_no, order_type, customer_name, status,
                      subtotal_cents, tax_cents, total_cents, paid_cents,
                      payment_method, payment_ref, created_by, created_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                      status = EXCLUDED.status,
                      total_cents = EXCLUDED.total_cents,
                      paid_cents = EXCLUDED.paid_cents,
                      updated_at = EXCLUDED.updated_at;
                """, (
                    o["id"], args.shop, o["ticket_no"], o["order_type"] or "standard", o["customer_name"] or "Walk-In Customer",
                    o["status"] or "paid", o["subtotal_cents"] or 0, o["tax_cents"] or 0, o["total_cents"] or 0, o["paid_cents"] or 0,
                    o["payment_method"] or "CASH", o["payment_ref"] or "", o["created_by"] or 1,
                    o["created_at"], o["updated_at"]
                ))
            print(f"  ✓ {len(orders)} orders migrated.")

        # 6. Order Items -> pos.order_items
        print("\n📦 [6/6] Migrating Order Items...")
        order_items = sc.execute("SELECT * FROM order_items").fetchall()
        print(f"  Found {len(order_items)} order items in SQLite.")
        if not args.dry_run:
            for oi in order_items:
                canonical_item_id = id_remap.get(oi["menu_item_id"], oi["menu_item_id"])
                pc.execute("""
                    INSERT INTO pos.order_items (
                      id, order_id, menu_item_id, name, qty, unit_price_cents, line_total_cents, note
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (id) DO UPDATE SET
                      menu_item_id = EXCLUDED.menu_item_id,
                      qty = EXCLUDED.qty,
                      unit_price_cents = EXCLUDED.unit_price_cents,
                      line_total_cents = EXCLUDED.line_total_cents;
                """, (
                    oi["id"], oi["order_id"], canonical_item_id, oi["name"], oi["qty"] or 1,
                    oi["unit_price_cents"] or 0, oi["line_total_cents"] or 0, oi["note"] or ""
                ))
            print(f"  ✓ {len(order_items)} order items migrated.")

        # 7. Resync ID Sequences
        if not args.dry_run:
            print("\n⚙️ Synchronizing Database ID Sequences...")
            tables = ["categories", "suppliers", "menu_items", "orders", "order_items"]
            for t in tables:
                pc.execute(f"SELECT setval(pg_get_serial_sequence('pos.{t}', 'id'), COALESCE((SELECT MAX(id) FROM pos.{t}), 1));")
            pg_conn.commit()
            print("  ✓ Sequences synchronized successfully.")

        print("\n" + "=" * 60)
        print("  🎉 MIGRATION COMPLETED SUCCESSFULLY!")
        print("=" * 60)
        print(f"  Categories:  {len(categories)}")
        print(f"  Suppliers:   {len(suppliers)}")
        print(f"  Products:    {len(final_items)} (Duplicates eliminated: {len(dup_ids_to_remove)})")
        print(f"  Orders:      {len(orders)}")
        print(f"  Order Items: {len(order_items)}")
        print("=" * 60 + "\n")

    except Exception as e:
        pg_conn.rollback()
        print(f"\n❌ Migration failed: {e}")
        raise
    finally:
        pc.close()
        pg_conn.close()
        sc.close()
        sqlite_conn.close()

if __name__ == "__main__":
    main()
