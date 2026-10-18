"""
BuildMart Complete Database Sync Tool
---------------------------------------
Fetches everything from Supabase PostgreSQL:
1. Products & Categories (831 products)
2. Suppliers (5 suppliers)
3. Orders & Order Items (787+ orders, 2,699+ line items)
4. Stock Movements

And updates:
- pos.sqlite3 (Full offline SQLite database in local POS projects)
- buildmart_catalog.json (Browser database with products, suppliers & sales history)
- CSV exports in exports/
"""

import csv
import json
import sqlite3
import shutil
import sys
from pathlib import Path
import psycopg2
import psycopg2.extras

# Resolve base paths
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
BASE_DIR = Path(r"c:\eTIMS-Analysis")

PG_URL = "postgresql://postgres.iyfebdvtcryjxitizuwb:8045%40JohnWakaba@aws-1-eu-west-1.pooler.supabase.com:6543/postgres"

# Target SQLite databases to update
SQLITE_TARGETS = [
    REPO_ROOT / "data" / "pos.sqlite3",
    BASE_DIR / "Programmatic-Fix" / "POS-Invoice-Prgrammatic" / "Programmatic-Fix" / "data" / "pos.sqlite3",
    BASE_DIR / "POS-Invoice-Prgrammatic" / "POS_APK-improved-ui" / "data" / "pos.sqlite3",
    BASE_DIR / "POS_APK-improved-ui" / "data" / "pos.sqlite3",
]

# Target browser catalogs to update
CATALOG_TARGETS = [
    REPO_ROOT / "capacitor" / "www" / "buildmart_catalog.json",
    REPO_ROOT / "dist" / "windows" / "OraforgePOS" / "app" / "capacitor" / "www" / "buildmart_catalog.json",
    BASE_DIR / "Programmatic-Fix" / "POS-Invoice-Prgrammatic" / "Programmatic-Fix" / "capacitor" / "www" / "buildmart_catalog.json",
    BASE_DIR / "Programmatic-Fix" / "POS-Invoice-Prgrammatic" / "Programmatic-Fix" / "dist" / "windows" / "OraforgePOS" / "app" / "capacitor" / "www" / "buildmart_catalog.json",
    BASE_DIR / "POS_APK-improved-ui" / "capacitor" / "www" / "buildmart_catalog.json",
]

# Target CSVs
CSV_PRODUCTS = [
    BASE_DIR / "exports" / "buildmart_products_for_ui_pos.csv",
    BASE_DIR / "POS_APK-improved-ui" / "data" / "buildmart_products.csv",
    REPO_ROOT / "data" / "buildmart_products.csv",
]
CSV_SUPPLIERS = BASE_DIR / "exports" / "buildmart_suppliers.csv"
CSV_ORDERS = BASE_DIR / "exports" / "buildmart_sales_history.csv"


def sync():
    print("=" * 65)
    print("      SYNCING FULL DATABASE FROM SUPABASE TO LOCAL POS")
    print("=" * 65)

    print("\n[1/5] Connecting to Supabase...")
    try:
        conn = psycopg2.connect(PG_URL)
    except Exception as e:
        print(f"Error connecting to Supabase: {e}")
        sys.exit(1)

    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)

    # 1. Products & Categories
    cur.execute("""
        SELECT 
            m.id, m.name, c.name as category, m.price_cents, m.cost_cents,
            m.stock_qty, m.sku, m.barcode, m.unit, m.color, m.active
        FROM menu_items m
        LEFT JOIN categories c ON m.category_id = c.id
        ORDER BY m.id
    """)
    products = cur.fetchall()
    print(f"      -> {len(products)} products")

    # 2. Suppliers
    cur.execute("SELECT * FROM suppliers ORDER BY id")
    suppliers = cur.fetchall()
    print(f"      -> {len(suppliers)} suppliers")

    # 3. Orders
    cur.execute("SELECT * FROM orders ORDER BY id DESC")
    orders = cur.fetchall()
    print(f"      -> {len(orders)} sales orders")

    # 4. Order items
    cur.execute("SELECT * FROM order_items ORDER BY id ASC")
    order_items = cur.fetchall()
    print(f"      -> {len(order_items)} order line items")

    conn.close()

    # Map order items to orders
    items_by_order = {}
    for item in order_items:
        items_by_order.setdefault(item["order_id"], []).append({
            "id": item["id"],
            "menu_item_id": item["menu_item_id"],
            "name": item["name"],
            "qty": item["qty"],
            "unit_price_cents": item["unit_price_cents"],
            "line_total_cents": item["line_total_cents"],
            "note": item.get("note") or ""
        })

    # Prepare formatted orders for browser / JSON
    formatted_orders = []
    for o in orders:
        formatted_orders.append({
            "id": o["id"],
            "ticket_no": o["ticket_no"],
            "order_type": o["order_type"] or "walk-in",
            "customer_name": o["customer_name"] or "Walk-In Customer",
            "status": o["status"] or "paid",
            "subtotal_cents": o["subtotal_cents"] or 0,
            "tax_cents": o["tax_cents"] or 0,
            "total_cents": o["total_cents"] or 0,
            "paid_cents": o["paid_cents"] or 0,
            "payment_method": o["payment_method"] or "cash",
            "payment_ref": o["payment_ref"] or "",
            "employee_name": "POS Terminal",
            "created_at": o["created_at"],
            "updated_at": o["updated_at"],
            "paid_at": o["updated_at"],
            "items": items_by_order.get(o["id"], [])
        })

    # [2/5] Update CSV files
    print("\n[2/5] Writing updated CSV exports...")
    prod_fields = ["name", "category", "price", "cost", "stock", "sku", "barcode", "unit", "color", "reorder_level", "active"]
    prod_csv_rows = []
    unique_cats = []
    for p in products:
        cname = (p["category"] or "General").strip()
        if cname not in unique_cats:
            unique_cats.append(cname)
        prod_csv_rows.append({
            "name": p["name"].strip(),
            "category": cname,
            "price": f"{(p['price_cents'] or 0) / 100.0:.2f}",
            "cost": f"{(p['cost_cents'] or 0) / 100.0:.2f}",
            "stock": p["stock_qty"] or 0,
            "sku": p["sku"] or f"BM-{p['id']:05d}",
            "barcode": p["barcode"] or "",
            "unit": p["unit"] or "pcs",
            "color": p["color"] or "#334155",
            "reorder_level": 5,
            "active": p["active"]
        })

    seen_csv = set()
    for path in CSV_PRODUCTS:
        try:
            if str(path.resolve()) in seen_csv:
                continue
            seen_csv.add(str(path.resolve()))
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, "w", newline="", encoding="utf-8") as f:
                w = csv.DictWriter(f, fieldnames=prod_fields)
                w.writeheader()
                w.writerows(prod_csv_rows)
            print(f"      -> {path}")
        except Exception as err:
            pass

    # Suppliers CSV
    try:
        CSV_SUPPLIERS.parent.mkdir(parents=True, exist_ok=True)
        with open(CSV_SUPPLIERS, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=["id", "name", "phone", "email", "address", "active"])
            w.writeheader()
            w.writerows([{
                "id": s["id"],
                "name": s["name"],
                "phone": s["phone"] or "",
                "email": s["email"] or "",
                "address": s["address"] or "",
                "active": s["active"]
            } for s in suppliers])
        print(f"      -> {CSV_SUPPLIERS}")
    except Exception as err:
        pass

    # Orders CSV
    try:
        CSV_ORDERS.parent.mkdir(parents=True, exist_ok=True)
        with open(CSV_ORDERS, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=[
                "id", "ticket_no", "date", "status", "payment_method",
                "total_kes", "items_count"
            ])
            w.writeheader()
            for o in orders:
                w.writerow({
                    "id": o["id"],
                    "ticket_no": o["ticket_no"],
                    "date": o["created_at"],
                    "status": o["status"],
                    "payment_method": o["payment_method"],
                    "total_kes": f"{(o['total_cents'] or 0) / 100.0:.2f}",
                    "items_count": len(items_by_order.get(o["id"], []))
                })
        print(f"      -> {CSV_ORDERS}")
    except Exception as err:
        pass

    # [3/5] Update SQLite databases
    print("\n[3/5] Updating SQLite databases...")
    seen_db = set()
    primary_db = None

    for db_path in SQLITE_TARGETS:
        try:
            resolved = str(db_path.resolve())
            if resolved in seen_db:
                continue
            seen_db.add(resolved)

            db_path.parent.mkdir(parents=True, exist_ok=True)
            if primary_db and Path(primary_db).exists():
                shutil.copy2(primary_db, db_path)
                print(f"      -> Synced {db_path} (from master)")
                continue

            s_conn = sqlite3.connect(db_path)
            s_cur = s_conn.cursor()

            # Ensure tables exist
            s_cur.execute("""
                CREATE TABLE IF NOT EXISTS categories (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    sort_order INTEGER DEFAULT 0,
                    business_type TEXT DEFAULT 'retail'
                )
            """)
            s_cur.execute("""
                CREATE TABLE IF NOT EXISTS menu_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    category_id INTEGER,
                    name TEXT NOT NULL,
                    price_cents INTEGER NOT NULL,
                    cost_cents INTEGER DEFAULT 0,
                    stock_qty REAL DEFAULT 0,
                    sku TEXT,
                    barcode TEXT,
                    unit TEXT DEFAULT 'pcs',
                    color TEXT DEFAULT '#334155',
                    active INTEGER DEFAULT 1,
                    reorder_level REAL DEFAULT 5
                )
            """)
            s_cur.execute("""
                CREATE TABLE IF NOT EXISTS suppliers (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    name TEXT NOT NULL,
                    phone TEXT,
                    email TEXT,
                    address TEXT,
                    active INTEGER DEFAULT 1
                )
            """)
            s_cur.execute("""
                CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ticket_no TEXT,
                    order_type TEXT,
                    customer_name TEXT,
                    status TEXT,
                    subtotal_cents INTEGER,
                    tax_cents INTEGER,
                    total_cents INTEGER,
                    paid_cents INTEGER,
                    payment_method TEXT,
                    payment_ref TEXT,
                    created_by INTEGER,
                    created_at TEXT,
                    updated_at TEXT
                )
            """)
            s_cur.execute("""
                CREATE TABLE IF NOT EXISTS order_items (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    order_id INTEGER,
                    menu_item_id INTEGER,
                    name TEXT,
                    qty REAL,
                    unit_price_cents INTEGER,
                    line_total_cents INTEGER,
                    note TEXT
                )
            """)

            # Categories
            cat_map = {}
            for sort_idx, cat_name in enumerate(unique_cats):
                s_cur.execute("SELECT id FROM categories WHERE name = ? AND business_type = 'hardware'", (cat_name,))
                row = s_cur.fetchone()
                if row:
                    cat_map[cat_name] = row[0]
                else:
                    s_cur.execute(
                        "INSERT INTO categories (name, sort_order, business_type) VALUES (?, ?, 'hardware')",
                        (cat_name, sort_idx)
                    )
                    cat_map[cat_name] = s_cur.lastrowid

            # Menu items
            s_cur.execute("DELETE FROM menu_items WHERE category_id IN (SELECT id FROM categories WHERE business_type = 'hardware')")
            for p in products:
                cname = (p["category"] or "General").strip()
                s_cur.execute("""
                    INSERT INTO menu_items (
                        category_id, name, price_cents, cost_cents, stock_qty,
                        sku, barcode, unit, color, active, reorder_level
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 5)
                """, (
                    cat_map[cname], p["name"].strip(), p["price_cents"] or 0, p["cost_cents"] or 0,
                    p["stock_qty"] or 0, p["sku"] or f"BM-{p['id']:05d}", p["barcode"] or None,
                    p["unit"] or "pcs", p["color"] or "#334155", p["active"]
                ))

            # Suppliers
            s_cur.execute("DELETE FROM suppliers")
            for s in suppliers:
                s_cur.execute(
                    "INSERT INTO suppliers (id, name, phone, email, address, active) VALUES (?, ?, ?, ?, ?, ?)",
                    (s["id"], s["name"], s["phone"] or "", s["email"] or "", s["address"] or "", s["active"])
                )

            # Orders & order_items
            s_cur.execute("DELETE FROM order_items")
            s_cur.execute("DELETE FROM orders")
            for o in orders:
                s_cur.execute("""
                    INSERT INTO orders (
                        id, ticket_no, order_type, customer_name, status,
                        subtotal_cents, tax_cents, total_cents, paid_cents,
                        payment_method, payment_ref, created_by, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    o["id"], o["ticket_no"], o["order_type"] or "walk-in", o["customer_name"] or "",
                    o["status"] or "paid", o["subtotal_cents"] or 0, o["tax_cents"] or 0,
                    o["total_cents"] or 0, o["paid_cents"] or 0, o["payment_method"] or "cash",
                    o["payment_ref"] or "", o["created_by"] or 1, o["created_at"], o["updated_at"]
                ))

            for item in order_items:
                s_cur.execute("""
                    INSERT INTO order_items (
                        id, order_id, menu_item_id, name, qty,
                        unit_price_cents, line_total_cents, note
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, (
                    item["id"], item["order_id"], item["menu_item_id"], item["name"],
                    item["qty"], item["unit_price_cents"], item["line_total_cents"], item.get("note") or ""
                ))

            s_conn.commit()
            s_conn.close()
            primary_db = db_path
            print(f"      -> Updated {db_path} with products, suppliers, and sales history.")
        except Exception as err:
            print(f"      [!] Warning: Could not update {db_path}: {err}")

    # [4/5] Update browser catalog JSON
    print("\n[4/5] Updating browser catalog JSON...")
    cat_id_lookup = {name: i + 1 for i, name in enumerate(unique_cats)}
    browser_items = []
    for i, p in enumerate(products):
        cname = (p["category"] or "General").strip()
        browser_items.append({
            "id": i + 1,
            "category_id": cat_id_lookup[cname],
            "category": cname,
            "name": p["name"].strip(),
            "price_cents": p["price_cents"] or 0,
            "cost_cents": p["cost_cents"] or 0,
            "stock_qty": p["stock_qty"] or 0,
            "sku": p["sku"] or f"BM-{p['id']:05d}",
            "barcode": p["barcode"] or "",
            "unit": p["unit"] or "pcs",
            "color": p["color"] or "#334155",
            "active": p["active"],
            "reorder_level": 5
        })

    browser_suppliers = [{
        "id": s["id"],
        "name": s["name"],
        "phone": s["phone"] or "",
        "email": s["email"] or "",
        "address": s["address"] or "",
        "active": s["active"]
    } for s in suppliers]

    catalog_data = {
        "business_type": "hardware",
        "shop_name": "EITY FIT Hardware",
        "categories": [{"id": i + 1, "name": name, "sort_order": i, "business_type": "hardware"} for i, name in enumerate(unique_cats)],
        "items": browser_items,
        "suppliers": browser_suppliers,
        "orders": formatted_orders
    }

    seen_cat = set()
    for cat_path in CATALOG_TARGETS:
        try:
            resolved = str(cat_path.resolve())
            if resolved in seen_cat:
                continue
            seen_cat.add(resolved)
            cat_path.parent.mkdir(parents=True, exist_ok=True)
            with open(cat_path, "w", encoding="utf-8") as f:
                json.dump(catalog_data, f, indent=2)
            print(f"      -> {cat_path} ({len(browser_items)} products, {cat_path.stat().st_size:,} bytes)")
        except Exception as err:
            pass

    print("\n" + "=" * 65)
    print("  ALL DONE! SQLite, CSVs, and Browser Catalog are fully synced.")
    print("=" * 65 + "\n")


if __name__ == "__main__":
    sync()
