from http import cookies
from html import escape as html_escape
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse
import hashlib
import json
import secrets
import sqlite3
import time
from profiles import (
    PROFILES,
    DEFAULT_SETTINGS,
    get_settings,
    save_settings,
    optimize_and_save_image,
    search_product_images,
    seed_sample_data,
)



BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"
DB_PATH = DATA_DIR / "pos.sqlite3"
STATIC_DIR = BASE_DIR / "static"
HOST = __import__("os").environ.get("POS_HOST", "0.0.0.0")
PORT = int(__import__("os").environ.get("PORT") or __import__("os").environ.get("POS_PORT", "3000"))

SESSIONS = {}
CACHE = {"menu": None, "menu_ts": 0}
STORE_NAME = "NIGHTCLUB"
STORE_TAGLINE = "Bar & Club POS"


def sozuri_sms_config():
    key_file = BASE_DIR / "capacitor" / "sozuri-config.json"
    cfg = json.loads(key_file.read_text(encoding="utf-8")) if key_file.exists() else {}
    return {**cfg, "api_key": cfg.get("apiKey", ""), "configured": bool(cfg.get("apiKey") and cfg.get("project") and cfg.get("from"))}


def send_sozuri_sms(message, recipients):
    import urllib.request
    cfg = sozuri_sms_config()
    if not cfg["configured"]:
        raise RuntimeError("Sozuri SMS credentials are missing")
    payload = {k: cfg[k] for k in ("project", "apiKey", "from", "channel", "type")}
    payload.update(message=message, to=",".join(recipients))
    req = urllib.request.Request("https://sozuri.net/api/v1/messaging", data=json.dumps(payload).encode("utf-8"), headers={"Content-Type": "application/json", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as response:
        return json.load(response)


def now():
    return int(time.time())


def report_period_bounds(period, reference_ts=None, tz_name="Africa/Nairobi"):
    """Return [start, end) epoch bounds for POS reporting in the shop timezone."""
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo

    tz = ZoneInfo(tz_name)
    ref_ts = int(reference_ts if reference_ts is not None else now())
    current = datetime.fromtimestamp(ref_ts, tz)
    today_start = current.replace(hour=0, minute=0, second=0, microsecond=0)

    if period == "yesterday":
        start_dt = today_start - timedelta(days=1)
        end_dt = today_start
        label = start_dt.strftime("%d %b %Y")
    elif period == "week":
        start_dt = today_start - timedelta(days=6)
        end_dt = current
        label = f"{start_dt.strftime('%d %b')} – {current.strftime('%d %b %Y')}"
    elif period == "month":
        start_dt = today_start - timedelta(days=29)
        end_dt = current
        label = f"{start_dt.strftime('%d %b')} – {current.strftime('%d %b %Y')}"
    else:
        period = "today"
        start_dt = today_start
        end_dt = current
        label = current.strftime("%d %b %Y")

    start_ts = int(start_dt.timestamp())
    # Current-period reports include transactions stamped in the current second.
    end_ts = int(end_dt.timestamp()) + (1 if period != "yesterday" else 0)
    return start_ts, end_ts, label


def hash_password(password, salt=None):
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode(), salt.encode(), 120000).hex()
    return f"{salt}${digest}"


def check_password(password, stored):
    salt, digest = stored.split("$", 1)
    return hash_password(password, salt).split("$", 1)[1] == digest


def db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def rows(cursor):
    return [dict(row) for row in cursor.fetchall()]


def normalize_customer_phone(value):
    digits = ''.join(ch for ch in str(value or '') if ch.isdigit())
    if not digits:
        return ''
    if len(digits) == 10 and digits.startswith('0'):
        digits = '254' + digits[1:]
    elif len(digits) == 9 and digits[0] in ('7', '1'):
        digits = '254' + digits
    return digits


def active_business_type(user=None, conn=None):
    btype = (user or {}).get("business_type") if user else None
    if btype in PROFILES:
        return btype
    if conn is not None:
        settings = get_settings(conn)
        btype = settings.get("business_type")
        if btype in PROFILES:
            return btype
    return "retail"


def scoped_settings(conn, business_type):
    business_type = business_type if business_type in PROFILES else "retail"
    settings = dict(get_settings(conn))
    profile = PROFILES[business_type]
    # The global settings table is still used for common settings, but a session
    # must always display the category/workspace it actually logged into.
    if settings.get("business_type") != business_type:
        settings["business_name"] = profile["name"]
        settings["business_tagline"] = profile["tagline"]
    settings["business_type"] = business_type
    return settings


def find_customer_by_phone(conn, value, business_type=None):
    target = normalize_customer_phone(value)
    if not target:
        return None
    if business_type in PROFILES:
        source = conn.execute(
            "SELECT id, name, phone FROM customers WHERE business_type = ?",
            (business_type,),
        ).fetchall()
    else:
        source = conn.execute("SELECT id, name, phone FROM customers").fetchall()
    for row in source:
        if normalize_customer_phone(row['phone']) == target:
            return row
    return None


def init_db():
    DATA_DIR.mkdir(exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                full_name TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'cashier',
                password_hash TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS categories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                sort_order INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS menu_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                category_id INTEGER NOT NULL REFERENCES categories(id),
                name TEXT NOT NULL,
                price_cents INTEGER NOT NULL,
                color TEXT NOT NULL DEFAULT '#334155',
                active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS suppliers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT UNIQUE NOT NULL,
                phone TEXT,
                email TEXT,
                address TEXT,
                active INTEGER NOT NULL DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS orders (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ticket_no TEXT UNIQUE NOT NULL,
                supplier_id INTEGER REFERENCES suppliers(id),
                order_type TEXT NOT NULL DEFAULT 'walk-in',
                customer_name TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'open',
                subtotal_cents INTEGER NOT NULL DEFAULT 0,
                tax_cents INTEGER NOT NULL DEFAULT 0,
                total_cents INTEGER NOT NULL DEFAULT 0,
                paid_cents INTEGER NOT NULL DEFAULT 0,
                payment_method TEXT,
                payment_ref TEXT,
                created_by INTEGER REFERENCES users(id),
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS order_items (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
                menu_item_id INTEGER REFERENCES menu_items(id),
                name TEXT NOT NULL,
                qty INTEGER NOT NULL DEFAULT 1,
                unit_price_cents INTEGER NOT NULL,
                line_total_cents INTEGER NOT NULL,
                note TEXT NOT NULL DEFAULT ''
            );

            CREATE TABLE IF NOT EXISTS stock_movements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                product_id INTEGER NOT NULL REFERENCES menu_items(id),
                qty_change INTEGER NOT NULL,
                reason TEXT NOT NULL DEFAULT 'sale',
                note TEXT,
                created_by INTEGER REFERENCES users(id),
                created_at INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS stock_purchases (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
                product_id INTEGER NOT NULL REFERENCES menu_items(id),
                qty_received INTEGER NOT NULL,
                cost_per_unit_cents INTEGER NOT NULL,
                total_cost_cents INTEGER NOT NULL,
                date_received INTEGER NOT NULL,
                created_by INTEGER REFERENCES users(id)
            );

            CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, updated_at);
            CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
            CREATE INDEX IF NOT EXISTS idx_menu_items_active ON menu_items(active, category_id);
            """
        )
        # Business Settings table
        conn.execute("""
            CREATE TABLE IF NOT EXISTS business_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            )
        """)
        if conn.execute("SELECT COUNT(*) FROM business_settings").fetchone()[0] == 0:
            for k, v in DEFAULT_SETTINGS.items():
                conn.execute("INSERT INTO business_settings(key, value) VALUES (?, ?)", (k, v))

        # Categories: add business_type
        cat_cols = {row["name"] for row in conn.execute("PRAGMA table_info(categories)")}
        if "business_type" not in cat_cols:
            conn.execute("ALTER TABLE categories ADD COLUMN business_type TEXT")
            conn.execute("UPDATE categories SET business_type = 'bar' WHERE business_type IS NULL")

        # Migrate existing menu_items table — add retail columns if missing
        mi_cols = {row["name"] for row in conn.execute("PRAGMA table_info(menu_items)")}
        migrations = [
            ("sku", "ALTER TABLE menu_items ADD COLUMN sku TEXT"),
            ("barcode", "ALTER TABLE menu_items ADD COLUMN barcode TEXT"),
            ("stock_qty", "ALTER TABLE menu_items ADD COLUMN stock_qty INTEGER NOT NULL DEFAULT 0"),
            ("cost_cents", "ALTER TABLE menu_items ADD COLUMN cost_cents INTEGER NOT NULL DEFAULT 0"),
            ("unit", "ALTER TABLE menu_items ADD COLUMN unit TEXT NOT NULL DEFAULT 'pcs'"),
            ("supplier_id", "ALTER TABLE menu_items ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)"),
            ("image_url", "ALTER TABLE menu_items ADD COLUMN image_url TEXT"),
        ]
        for col, sql in migrations:
            if col not in mi_cols:
                conn.execute(sql)
                
        import os
        os.makedirs("static/uploads", exist_ok=True)
        # Migrate orders table
        o_cols = {row["name"] for row in conn.execute("PRAGMA table_info(orders)")}
        if "customer_name" not in o_cols:
            conn.execute("ALTER TABLE orders ADD COLUMN customer_name TEXT NOT NULL DEFAULT ''")
        if "supplier_id" not in o_cols:
            conn.execute("ALTER TABLE orders ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id)")
        if "payment_ref" not in o_cols:
            conn.execute("ALTER TABLE orders ADD COLUMN payment_ref TEXT")
            
        cost_updates = {
            "BE-001": 20000, "BE-002": 20000, "CO-001": 30000,
            "SP-001": 150000, "SP-002": 120000, "WI-001": 80000,
        }
        for sku, cost in cost_updates.items():
            conn.execute("UPDATE menu_items SET cost_cents = ? WHERE sku = ? AND cost_cents = 0", (cost, sku))
            
        # Migrate legacy dining_tables if it exists — we keep it for compat but don't use it
        conn.execute("CREATE TABLE IF NOT EXISTS dining_tables (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE NOT NULL, seats INTEGER NOT NULL DEFAULT 4, active INTEGER NOT NULL DEFAULT 1)")
        conn.execute('''
            CREATE TABLE IF NOT EXISTS customers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                phone TEXT NOT NULL,
                email TEXT,
                notes TEXT,
                created_at INTEGER DEFAULT (cast(strftime('%s','now') as int))
            )
        ''')

        # Additional capability columns for menu_items
        cur_mi_cols = {row["name"] for row in conn.execute("PRAGMA table_info(menu_items)")}
        for col_name, sql in [
            ("reorder_level", "ALTER TABLE menu_items ADD COLUMN reorder_level INTEGER NOT NULL DEFAULT 5"),
            ("batch_no", "ALTER TABLE menu_items ADD COLUMN batch_no TEXT"),
            ("expiry_date", "ALTER TABLE menu_items ADD COLUMN expiry_date TEXT"),
            ("manufacturer", "ALTER TABLE menu_items ADD COLUMN manufacturer TEXT"),
            ("strength", "ALTER TABLE menu_items ADD COLUMN strength TEXT"),
            ("wholesale_price_cents", "ALTER TABLE menu_items ADD COLUMN wholesale_price_cents INTEGER NOT NULL DEFAULT 0"),
            ("variants_json", "ALTER TABLE menu_items ADD COLUMN variants_json TEXT DEFAULT ''"),
            ("decimal_qty_enabled", "ALTER TABLE menu_items ADD COLUMN decimal_qty_enabled INTEGER NOT NULL DEFAULT 0"),
        ]:
            if col_name not in cur_mi_cols:
                conn.execute(sql)

        # Additional columns for orders
        cur_o_cols = {row["name"] for row in conn.execute("PRAGMA table_info(orders)")}
        for col_name, sql in [
            ("table_id", "ALTER TABLE orders ADD COLUMN table_id INTEGER REFERENCES dining_tables(id)"),
            ("pricing_tier", "ALTER TABLE orders ADD COLUMN pricing_tier TEXT NOT NULL DEFAULT 'retail'"),
            ("is_quote", "ALTER TABLE orders ADD COLUMN is_quote INTEGER NOT NULL DEFAULT 0"),
            ("notes", "ALTER TABLE orders ADD COLUMN notes TEXT NOT NULL DEFAULT ''"),
            ("paid_at", "ALTER TABLE orders ADD COLUMN paid_at INTEGER"),
        ]:
            if col_name not in cur_o_cols:
                conn.execute(sql)

        # Additional columns for order_items
        cur_oi_cols = {row["name"] for row in conn.execute("PRAGMA table_info(order_items)")}
        for col_name, sql in [
            ("variant_info", "ALTER TABLE order_items ADD COLUMN variant_info TEXT NOT NULL DEFAULT ''"),
            ("batch_no", "ALTER TABLE order_items ADD COLUMN batch_no TEXT NOT NULL DEFAULT ''"),
            ("cost_cents", "ALTER TABLE order_items ADD COLUMN cost_cents INTEGER"),
        ]:
            if col_name not in cur_oi_cols:
                conn.execute(sql)

        # Backfill report snapshots for existing data. New sales keep these values forever.
        conn.execute("UPDATE orders SET paid_at = updated_at WHERE status = 'paid' AND (paid_at IS NULL OR paid_at = 0)")
        conn.execute("""
            UPDATE order_items
               SET cost_cents = COALESCE((SELECT mi.cost_cents FROM menu_items mi WHERE mi.id = order_items.menu_item_id), 0)
             WHERE cost_cents IS NULL
        """)

        # Business workspace isolation. One codebase, separate operational data per shop category.
        workspace_migrations = [
            ("orders", "business_type", "ALTER TABLE orders ADD COLUMN business_type TEXT NOT NULL DEFAULT 'bar'"),
            ("customers", "business_type", "ALTER TABLE customers ADD COLUMN business_type TEXT NOT NULL DEFAULT 'bar'"),
            ("suppliers", "business_type", "ALTER TABLE suppliers ADD COLUMN business_type TEXT NOT NULL DEFAULT 'bar'"),
            ("stock_purchases", "business_type", "ALTER TABLE stock_purchases ADD COLUMN business_type TEXT NOT NULL DEFAULT 'bar'"),
            ("stock_movements", "business_type", "ALTER TABLE stock_movements ADD COLUMN business_type TEXT NOT NULL DEFAULT 'bar'"),
        ]
        for table_name, col_name, sql in workspace_migrations:
            table_cols = {row["name"] for row in conn.execute(f"PRAGMA table_info({table_name})")}
            if col_name not in table_cols:
                conn.execute(sql)

        # Recover the correct shop category for historical sales by looking at
        # the category of the products that were actually sold on each order.
        conn.execute("""
            UPDATE orders
               SET business_type = COALESCE((
                   SELECT c.business_type
                     FROM order_items oi
                     JOIN menu_items mi ON mi.id = oi.menu_item_id
                     JOIN categories c ON c.id = mi.category_id
                    WHERE oi.order_id = orders.id
                      AND c.business_type IN ('retail','pharmacy','restaurant','hardware','boutique','bar','garage')
                    ORDER BY oi.id
                    LIMIT 1
               ), business_type)
        """)

        # Existing suppliers/purchases/movements can also be inferred from their products.
        conn.execute("""
            UPDATE suppliers
               SET business_type = COALESCE((
                   SELECT c.business_type
                     FROM menu_items mi
                     JOIN categories c ON c.id = mi.category_id
                    WHERE mi.supplier_id = suppliers.id
                      AND c.business_type IN ('retail','pharmacy','restaurant','hardware','boutique','bar','garage')
                    LIMIT 1
               ), business_type)
        """)
        conn.execute("""
            UPDATE stock_purchases
               SET business_type = COALESCE((
                   SELECT c.business_type
                     FROM menu_items mi JOIN categories c ON c.id = mi.category_id
                    WHERE mi.id = stock_purchases.product_id
                    LIMIT 1
               ), business_type)
        """)
        conn.execute("""
            UPDATE stock_movements
               SET business_type = COALESCE((
                   SELECT c.business_type
                     FROM menu_items mi JOIN categories c ON c.id = mi.category_id
                    WHERE mi.id = stock_movements.product_id
                    LIMIT 1
               ), business_type)
        """)

        # Best-effort recovery of historical customer workspace from matching sales.
        for customer_row in conn.execute("SELECT id, name, phone FROM customers").fetchall():
            cust_phone = normalize_customer_phone(customer_row["phone"])
            matches = conn.execute(
                "SELECT business_type, payment_ref, customer_name FROM orders ORDER BY updated_at DESC"
            ).fetchall()
            for order_row in matches:
                same_phone = cust_phone and normalize_customer_phone(order_row["payment_ref"]) == cust_phone
                same_name = customer_row["name"] and order_row["customer_name"] == customer_row["name"]
                if same_phone or same_name:
                    conn.execute(
                        "UPDATE customers SET business_type = ? WHERE id = ?",
                        (order_row["business_type"], customer_row["id"]),
                    )
                    break

        # Seed sample data for profiles
        seed_sample_data(conn)

        if conn.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0:
            conn.execute(
                "INSERT INTO users(username, full_name, role, password_hash) VALUES (?, ?, ?, ?)",
                ("terminal", "POS Terminal", "terminal", hash_password("1234")),
            )
            conn.execute(
                "INSERT INTO users(username, full_name, role, password_hash) VALUES (?, ?, ?, ?)",
                ("admin", "The Owner", "manager", hash_password("admin123")),
            )
        else:
            terminal = conn.execute("SELECT id FROM users WHERE username = 'terminal'").fetchone()
            if not terminal:
                conn.execute(
                    "INSERT INTO users(username, full_name, role, password_hash) VALUES (?, ?, ?, ?)",
                    ("terminal", "POS Terminal", "terminal", hash_password("1234")),
                )
            conn.execute("UPDATE users SET active = 1, role = 'terminal' WHERE username = 'terminal'")

            admin = conn.execute("SELECT id, password_hash FROM users WHERE username = 'admin'").fetchone()
            if not admin:
                conn.execute(
                    "INSERT INTO users(username, full_name, role, password_hash) VALUES (?, ?, ?, ?)",
                    ("admin", "The Owner", "manager", hash_password("admin123")),
                )
            else:
                conn.execute(
                    "UPDATE users SET full_name = 'The Owner', role = 'manager' WHERE id = ?",
                    (admin["id"],),
                )
            
            # Clean up old dummy staff
            conn.execute("DELETE FROM users WHERE username != 'terminal' AND username != 'admin'")

        if conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
            seed_categories = ["Beers", "Cocktails", "Spirits", "Wines", "Soft Drinks", "Snacks"]
            for i, name in enumerate(seed_categories):
                conn.execute("INSERT INTO categories(name, sort_order) VALUES (?, ?)", (name, i))

            cat_ids = {r["name"]: r["id"] for r in conn.execute("SELECT id, name FROM categories")}
            seed_items = [
                ("Beers",       "Tusker Lager 500ml", 250, 200,  "#d97706", "BE-001", 120, "btl"),
                ("Beers",       "Guinness 500ml",     300, 240,  "#1e293b", "BE-002", 80,  "btl"),
                ("Beers",       "White Cap 500ml",    250, 200,  "#94a3b8", "BE-003", 100, "btl"),
                ("Beers",       "Heineken",           350, 280,  "#15803d", "BE-004", 60,  "btl"),
                ("Cocktails",   "Mojito",             600, 300,  "#22c55e", "CO-001", 0,   "glass"),
                ("Cocktails",   "Margarita",          650, 320,  "#eab308", "CO-002", 0,   "glass"),
                ("Cocktails",   "Long Island",        800, 400,  "#ef4444", "CO-003", 0,   "glass"),
                ("Spirits",     "Jameson 750ml",     3500,2800,  "#166534", "SP-001", 12,  "btl"),
                ("Spirits",     "Gilbeys Gin 750ml", 1800,1400,  "#0ea5e9", "SP-002", 15,  "btl"),
                ("Spirits",     "Smirnoff Vodka",    1600,1200,  "#ef4444", "SP-003", 20,  "btl"),
                ("Spirits",     "Jack Daniels",      4500,3600,  "#000000", "SP-004", 8,   "btl"),
                ("Wines",       "Four Cousins Sweet",1200, 900,  "#db2777", "WI-001", 24,  "btl"),
                ("Wines",       "Nederburg Cabernet",1800,1400,  "#9d174d", "WI-002", 10,  "btl"),
                ("Soft Drinks", "Coca Cola 300ml",     80,  50,  "#dc2626", "SD-001", 60,  "btl"),
                ("Soft Drinks", "Sprite 300ml",        80,  50,  "#16a34a", "SD-002", 48,  "btl"),
                ("Soft Drinks", "Red Bull",           250, 180,  "#2563eb", "SD-003", 24,  "can"),
                ("Snacks",      "Roasted Peanuts",    100,  60,  "#d97706", "SN-001", 30,  "pkt"),
                ("Snacks",      "Potato Crisps",      150, 100,  "#f59e0b", "SN-002", 20,  "pkt"),
            ]
            for category, name, price, cost, color, sku, stock, unit in seed_items:
                conn.execute(
                    "INSERT INTO menu_items(category_id, name, price_cents, cost_cents, color, sku, stock_qty, unit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (cat_ids[category], name, price * 100, cost * 100, color, sku, stock, unit),
                )

        if conn.execute("SELECT COUNT(*) FROM suppliers").fetchone()[0] == 0:
            seed_suppliers = [
                ("East African Breweries Ltd", "+254 700 111 000", "orders@eabl.co.ke"),
                ("Coca-Cola Beverages Africa", "+254 722 222 111", "supply@ccba.co.ke"),
                ("KWAL Kenya", "+254 711 333 000", "procurement@kwal.co.ke"),
                ("Local Liquor Distributors", "+254 733 444 000", "sales@lld.co.ke"),
            ]
            for name, phone, email in seed_suppliers:
                conn.execute("INSERT INTO suppliers(name, phone, email) VALUES (?, ?, ?)", (name, phone, email))


def money(cents):
    return f"{cents / 100:.2f}"


def recalc_order(conn, order_id):
    subtotal = conn.execute(
        "SELECT COALESCE(SUM(line_total_cents), 0) FROM order_items WHERE order_id = ?",
        (order_id,),
    ).fetchone()[0]
    tax = round(subtotal * 0.0)
    total = subtotal + tax
    conn.execute(
        "UPDATE orders SET subtotal_cents = ?, tax_cents = ?, total_cents = ?, updated_at = ? WHERE id = ?",
        (subtotal, tax, total, now(), order_id),
    )


def next_ticket(conn):
    return f"R{now()}{conn.execute('SELECT COUNT(*) FROM orders').fetchone()[0] + 1:03d}"


def get_order_payload(conn, order_id):
    order = conn.execute(
        """
        SELECT o.*, u.full_name AS employee_name, u.username AS employee_username,
               t.name AS table_name
        FROM orders o
        LEFT JOIN users u ON u.id = o.created_by
        LEFT JOIN dining_tables t ON t.id = o.table_id
        WHERE o.id = ?
        """,
        (order_id,),
    ).fetchone()
    if not order:
        return None
    items = rows(conn.execute("SELECT * FROM order_items WHERE order_id = ? ORDER BY id", (order_id,)))
    payload = dict(order)
    payload["items"] = items
    payload["total"] = money(payload["total_cents"])
    return payload


def receipt_page(order, autoprint=False, is_kot=False, settings=None):
    if not settings:
        with db() as conn:
            settings = get_settings(conn)
    bname = settings.get("business_name", "POS")
    btag = settings.get("business_tagline", "")
    phone = settings.get("phone", "")
    address = settings.get("address", "")
    r_header = settings.get("receipt_header", "Welcome to our store")
    r_footer = settings.get("receipt_footer", "Thank you for your visit!\n------- END OF RECEIPT -------")

    if is_kot:
        item_rows = "".join(
            f'''
            <tr>
              <td><strong>{item['qty']} x {item['name']}</strong>{f"<br><small style='color:#666'>* {item['note']}</small>" if item.get('note') else ""}{f"<br><small style='color:#666'>[{item['variant_info']}]</small>" if item.get('variant_info') else ""}</td>
            </tr>
            '''
            for item in order["items"]
        )
        return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>KOT #{order['ticket_no']} — {bname}</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body class="receipt-body">
  <section class="receipt">
    <h1>*** KITCHEN / BAR ORDER ***</h1>
    <p>Ticket: <strong>#{order['ticket_no']}</strong></p>
    <div style="border-top: 2px dashed var(--line); margin: 10px 0;"></div>
    <div class="receipt-line"><span>Table / Tab</span><strong>{order.get('table_name') or 'Counter'}</strong></div>
    <div class="receipt-line"><span>Server</span><strong>{order.get('employee_name') or '-'}</strong></div>
    <div class="receipt-line"><span>Time</span><strong>{__import__('datetime').datetime.now().strftime('%d/%m/%Y %H:%M:%S')}</strong></div>
    {f"<div class='receipt-line'><span>Notes</span><strong>{order.get('notes')}</strong></div>" if order.get('notes') else ""}
    <div style="border-top: 2px dashed var(--line); margin: 10px 0;"></div>
    <table><tbody>{item_rows}</tbody></table>
    <div style="border-top: 2px dashed var(--line); margin: 10px 0;"></div>
    <button onclick="window.print()">Print KOT</button>
  </section>
  {"<script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script>" if autoprint else ""}
</body>
</html>"""

    is_quote = bool(order.get("is_quote") or order.get("order_type") == "quote")
    title_label = "QUOTATION / ESTIMATE" if is_quote else "ORIGINAL RECEIPT"

    def safe(value):
        return html_escape(str(value if value is not None else ""))

    def info_row(label, value):
        return f'<div class="receipt-line"><span>{safe(label)}</span><span>{safe(value)}</span></div>'

    contact_html = "".join([
        f'<p class="receipt-contact">Address: {safe(address)}</p>' if address else "",
        f'<p class="receipt-contact">Mobile: {safe(phone)}</p>' if phone else "",
        f'<p class="receipt-contact">Email: {safe(settings.get("email"))}</p>' if settings.get("email") else "",
        f'<p class="receipt-contact">KRA PIN: {safe(settings.get("kra_pin"))}</p>' if settings.get("kra_pin") else "",
    ])

    item_rows = []
    for item in order["items"]:
        qty = float(item.get("qty") or 0)
        line_cents = int(item.get("line_total_cents") or 0)
        price_cents = item.get("unit_price_cents")
        if price_cents is None:
            price_cents = line_cents / qty if qty else 0
        notes = "".join([
            f'<small>{safe(item.get("variant_info"))}</small>' if item.get("variant_info") else "",
            f'<small>Batch: {safe(item.get("batch_no"))}</small>' if item.get("batch_no") else "",
            f'<small>{safe(item.get("note"))}</small>' if item.get("note") else "",
        ])
        item_rows.append(
            f'<tr class="receipt-item-name"><td colspan="3">{safe(item.get("name"))}{notes}</td></tr>'
            f'<tr class="receipt-item-values"><td>{qty:g}</td><td>{money(price_cents)}</td><td>{money(line_cents)}</td></tr>'
        )
    item_rows = "".join(item_rows)

    # Printed VAT is the amount already stored with the transaction.
    gross_cents = int(order.get("total_cents") or 0)
    vat_cents = min(gross_cents, max(0, int(order.get("tax_cents") or 0)))
    subtotal_no_vat = (gross_cents - vat_cents) / 100
    vat_amount = vat_cents / 100
    vat_rate = (100 * vat_cents / (gross_cents - vat_cents)
                if vat_cents and gross_cents > vat_cents else 0)
    discount_cents = int(order.get("discount_cents") or 0)
    subtotal_cents = int(order.get("subtotal_cents") or (gross_cents + discount_cents))
    from datetime import datetime
    from zoneinfo import ZoneInfo
    tz = ZoneInfo("Africa/Nairobi")
    sale_date = datetime.fromtimestamp(int(order.get("created_at") or now()), tz).strftime("%d/%m/%Y")
    printed_at = datetime.now(tz).strftime("%I:%M:%S %p")
    receipt_title = "Quotation" if is_quote else "Cash Sale"
    details_html = "".join([
        info_row("Name", order.get("customer_name") or "Walk-In Customer"),
        info_row("Receipt No.", order.get("ticket_no") or order.get("id") or "-"),
        info_row("Date", sale_date),
        info_row("Print Time", printed_at),
        info_row("Table / Tab", order.get("table_name")) if order.get("table_name") else "",
        info_row("Type", (order.get("order_type") or "walk-in").upper()),
        info_row("Served By", order.get("employee_name") or "POS Terminal"),
        info_row("Status", (order.get("status") or "open").upper()),
    ])
    discount_html = (
        info_row("Subtotal", money(subtotal_cents)) +
        info_row("Discount", "-" + money(discount_cents))
    ) if discount_cents else ""
    payment_html = "" if is_quote else (
        '<div class="receipt-payment">' +
        info_row("Payment Method", (order.get("payment_method") or "CASH").upper()) +
        (info_row("Txn Ref", order.get("payment_ref")) if order.get("payment_ref") else "") +
        '</div>'
    )
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{'Quote' if is_quote else 'Receipt'} #{safe(order.get('ticket_no'))} — {safe(bname)}</title>
  <link rel="stylesheet" href="/static/styles.css">
</head>
<body class="receipt-body">
  <section class="receipt sales-receipt">
    <header class="receipt-business-header">
      <h1 class="receipt-business-name">{safe(bname)}</h1>
      {contact_html}
      <p class="receipt-kind">{'QUOTATION / ESTIMATE' if is_quote else 'SALES RECEIPT'}</p>
      <h2 class="receipt-sale-title">{receipt_title}</h2>
    </header>
    <div class="receipt-details">{details_html}</div>
    <table class="receipt-items">
      <thead><tr><th>Qty</th><th>Unit Price</th><th>Total</th></tr></thead>
      <tbody>{item_rows}</tbody>
    </table>
    <div class="receipt-totals">
      {discount_html}
      {info_row("Total Excl. VAT", f"{subtotal_no_vat:,.2f}")}
      {info_row(f"VAT Total ({vat_rate:.1f}%)", f"{vat_amount:,.2f}")}
      <div class="receipt-total"><span>Total</span><strong>KES {money(gross_cents)}</strong></div>
    </div>
    {payment_html}
    <footer class="receipt-note">{safe(r_footer)}</footer>
    <button onclick="window.print()">Print {'Quotation' if is_quote else 'Receipt'}</button>
  </section>
  {"<script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script>" if autoprint else ""}
</body>
</html>"""


def hidden_admin_page(business_type="retail"):
    profile = PROFILES.get(business_type, PROFILES["retail"])
    html = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>__SHOP_NAME__ — Admin Portal</title>
  <link rel="stylesheet" href="/static/admin.css?v=__ASSET_VERSION__">
  <script>
    (function() {
      var t = localStorage.getItem('pos_theme') || 'light';
      document.documentElement.setAttribute('data-theme', t);
    })();
  </script>
</head>
<body>
  <div class="admin-shell">
    <!-- SIDEBAR -->
    <aside class="sidebar">
      <div class="sidebar-brand">
        <div class="logo">
          <div class="logo-icon" id="adminBusinessIcon">__SHOP_ICON__</div>
          <span class="name" id="adminBusinessName">__SHOP_NAME__</span>
        </div>
        <div class="tag" id="adminPortalTag">__SHOP_NAME__ Admin</div>
        <button class="sidebar-toggle" id="sidebarToggle" title="Toggle sidebar">
          <span></span><span></span><span></span>
        </button>
      </div>
      <nav class="sidebar-nav">
        <div class="nav-item active" data-section="dashboard">
          <span class="nav-icon">&#9646;</span>
          <span class="nav-label">Dashboard</span>
        </div>
        <div class="nav-item" data-section="users">
          <span class="nav-icon">&#9646;</span>
          <span class="nav-label">Staff</span>
        </div>
        <div class="nav-item" data-section="menu">
          <span class="nav-icon">&#9646;</span>
          <span class="nav-label" id="adminProductsLabel">Products</span>
        </div>
        <div class="nav-item" data-section="customers">
          <span class="nav-icon">&#9646;</span>
          <span class="nav-label">Customers</span>
        </div>
        <div class="nav-item" data-section="promotions">
          <span class="nav-icon">&#9646;</span>
          <span class="nav-label">Customer Marketing</span>
        </div>
        <div class="nav-item" data-section="pos">
          <span class="nav-icon">&#9646;</span>
          <span class="nav-label">Back to POS</span>
        </div>
      </nav>
      <div class="sidebar-footer">
        <div class="user-card">
          <div class="user-avatar" id="userAvatarLetter">A</div>
          <div class="user-info">
            <div class="user-name" id="userDisplayName">Admin</div>
            <div class="user-role">Manager</div>
          </div>
        </div>
        <a class="logout-btn" href="/logout">Logout</a>
      </div>
    </aside>

    <!-- MAIN -->
    <main class="main-content">
      <div class="content-section active" id="sec-dashboard"></div>
      <div class="content-section" id="sec-users"></div>
      <div class="content-section" id="sec-menu"></div>
      <div class="content-section" id="sec-customers"></div>
      <div class="content-section" id="sec-promotions"></div>
    </main>
  </div>

  <!-- FLOATING OPEN BUTTON (shown when sidebar is collapsed) -->
  <button class="sidebar-open-btn" id="sidebarOpenBtn" title="Open sidebar">
    <span></span><span></span><span></span>
  </button>

  <!-- TOAST CONTAINER -->
  <div class="toast-container" id="toastContainer"></div>

  <script src="/static/admin.js?v=__ASSET_VERSION__" defer></script>
  <script>
    document.addEventListener('DOMContentLoaded', () => {
      const shell = document.querySelector('.admin-shell');
      const closeBtn = document.getElementById('sidebarToggle');
      const openBtn = document.getElementById('sidebarOpenBtn');
      if (window.innerWidth <= 860) shell.classList.add('collapsed');
      closeBtn.addEventListener('click', () => shell.classList.add('collapsed'));
      openBtn.addEventListener('click', () => shell.classList.remove('collapsed'));
    });
  </script>
</body>
</html>"""
    return (html
            .replace("__SHOP_ICON__", profile.get("icon", "🏪"))
            .replace("__SHOP_NAME__", profile.get("name", business_type))
            .replace("__ASSET_VERSION__", str(int(time.time()))))


def page(title, active, content, role=None, settings=None):
    if not settings:
        with db() as conn:
            settings = get_settings(conn)
    btype = settings.get("business_type", "bar")
    profile = PROFILES.get(btype, PROFILES["retail"])
    bname = settings.get("business_name", "POS")
    btag = settings.get("business_tagline", profile["tagline"])
    bicon = profile.get("icon", "🛒")

    nav = [
        ("🖥️", "POS", "/pos"),
        ("🚚", "Suppliers", "/suppliers"),
        ("🧾", "Sales", "/sales"),
        ("📦", "Products", "/products"),
        ("📊", "Reports", "/reports"),
        ("⚙️", "Settings", "/settings"),
    ]
    links = "".join(
        f'<a class="nav-link {"active" if active == label else ""}" href="{href}"><span class="nav-icon">{icon}</span>{label}</a>'
        for icon, label, href in nav
    )
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} — {bname}</title>
  <link rel="stylesheet" href="/static/inter.css">
  <link rel="stylesheet" href="/static/styles.css?v={int(time.time())}">
  <script>
    (function() {{
      var t = localStorage.getItem('pos_theme') || 'light';
      document.documentElement.setAttribute('data-theme', t);
    }})();
  </script>
</head>
<body>
  <header class="topbar">
    <div class="topbar-left">
      <button class="mobile-nav-toggle" id="mobileNavToggle">
        <span></span><span></span><span></span>
      </button>
      <a class="brand" href="/pos">
        <div class="brand-logo">{bicon}</div>
        <div class="brand-text">
          <span id="brandName">{bname}</span>
          <small id="brandTagline">{btag}</small>
        </div>
      </a>
      <div class="topbar-divider"></div>
    </div>
    <div class="topbar-center">
      <nav id="topNav">{links}</nav>
    </div>
    <div class="topbar-right">
      <span class="status-dot" title="System online"></span>
      <div class="topbar-clock">
        <span id="navTime">--:--</span>
        <span id="navDate">---</span>
      </div>
      <button id="themeToggleBtn" class="theme-toggle-btn" title="Toggle Light / Dark theme" aria-label="Toggle theme">☀️</button>
      <div class="topbar-divider"></div>
      <a class="logout" href="/logout">⏏ Logout</a>
    </div>
  </header>
  <main>{content}</main>
  <script src="/static/app.js?v={int(time.time())}" defer></script>
  <script>
    function updateClock() {{
      const now = new Date();
      const t = now.toLocaleTimeString('en-GB', {{hour:'2-digit', minute:'2-digit', second:'2-digit'}});
      const d = now.toLocaleDateString('en-GB', {{weekday:'short', day:'2-digit', month:'short'}});
      const te = document.getElementById('navTime');
      const de = document.getElementById('navDate');
      if (te) te.textContent = t;
      if (de) de.textContent = d;
    }}
    updateClock();
    setInterval(updateClock, 1000);

    document.addEventListener('DOMContentLoaded', () => {{
      const toggle = document.getElementById('mobileNavToggle');
      const center = document.querySelector('.topbar-center');
      if(toggle && center) {{
        toggle.addEventListener('click', (e) => {{ e.stopPropagation(); center.classList.toggle('open'); }});
        document.addEventListener('click', (e) => {{
          if (!center.contains(e.target) && !toggle.contains(e.target)) center.classList.remove('open');
        }});
      }}
    }});
  </script>
</body>
</html>"""


def tech_demo_page():
    profile = PROFILES["tech_accessories"]
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{profile["name"]} — Client Demo</title>
  <link rel="stylesheet" href="/static/inter.css">
  <style>
    :root {{
      color-scheme: light;
      --ink:#10211b;
      --muted:#66756f;
      --line:#dfe8e3;
      --panel:#ffffff;
      --accent:#16a34a;
      --accent-dark:#0f7a37;
      --soft:#f4f8f5;
    }}
    * {{ box-sizing:border-box; }}
    body {{
      margin:0;
      min-height:100vh;
      font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
      color:var(--ink);
      background:
        radial-gradient(circle at 12% 15%, rgba(22,163,74,.10), transparent 25rem),
        radial-gradient(circle at 88% 82%, rgba(37,99,235,.08), transparent 24rem),
        var(--soft);
    }}
    .wrap {{ width:min(1120px, calc(100% - 32px)); margin:0 auto; padding:34px 0 46px; }}
    .top {{ display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:34px; }}
    .brand {{ display:flex; align-items:center; gap:12px; font-weight:850; letter-spacing:-.02em; }}
    .brand-icon {{ width:46px; height:46px; border-radius:14px; display:grid; place-items:center; background:#10211b; color:#fff; font-size:24px; box-shadow:0 10px 24px rgba(16,33,27,.12); }}
    .badge {{ padding:8px 12px; border:1px solid var(--line); border-radius:999px; background:rgba(255,255,255,.78); color:var(--muted); font-size:12px; font-weight:750; }}
    .hero {{ display:grid; grid-template-columns:1.15fr .85fr; gap:28px; align-items:stretch; }}
    .hero-copy, .preview {{ background:rgba(255,255,255,.9); border:1px solid var(--line); border-radius:26px; box-shadow:0 18px 55px rgba(29,54,43,.08); }}
    .hero-copy {{ padding:42px; }}
    .eyebrow {{ display:inline-flex; align-items:center; gap:8px; margin-bottom:16px; color:var(--accent-dark); font-weight:800; font-size:13px; text-transform:uppercase; letter-spacing:.08em; }}
    h1 {{ margin:0; font-size:clamp(34px,5vw,58px); line-height:.98; letter-spacing:-.055em; max-width:780px; }}
    .lead {{ max-width:650px; margin:20px 0 28px; color:var(--muted); font-size:17px; line-height:1.65; }}
    .actions {{ display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:14px; }}
    .portal {{ display:flex; flex-direction:column; gap:7px; min-height:148px; padding:22px; border-radius:20px; text-decoration:none; transition:.18s ease; }}
    .portal:hover {{ transform:translateY(-3px); box-shadow:0 14px 34px rgba(16,33,27,.10); }}
    .portal-worker {{ background:#10211b; color:#fff; }}
    .portal-admin {{ background:#eaf7ee; color:#153d25; border:1px solid #cde8d5; }}
    .portal .icon {{ font-size:29px; }}
    .portal strong {{ margin-top:auto; font-size:20px; letter-spacing:-.02em; }}
    .portal small {{ line-height:1.45; opacity:.76; }}
    .note {{ margin-top:18px; color:var(--muted); font-size:12px; line-height:1.55; }}
    .preview {{ padding:22px; display:flex; flex-direction:column; gap:14px; }}
    .preview-head {{ display:flex; align-items:center; justify-content:space-between; gap:12px; }}
    .preview-head strong {{ font-size:15px; }}
    .dot {{ width:9px; height:9px; border-radius:50%; background:#22c55e; box-shadow:0 0 0 5px rgba(34,197,94,.10); }}
    .product-grid {{ display:grid; grid-template-columns:1fr 1fr; gap:12px; flex:1; }}
    .product {{ overflow:hidden; border:1px solid var(--line); border-radius:18px; background:#fff; min-height:170px; }}
    .product img {{ width:100%; height:120px; object-fit:cover; display:block; background:#f7faf8; }}
    .product-copy {{ padding:12px; }}
    .product-copy strong {{ display:block; font-size:13px; margin-bottom:4px; }}
    .product-copy span {{ font-size:12px; color:var(--muted); }}
    .product.wide {{ grid-column:1/-1; display:grid; grid-template-columns:145px 1fr; min-height:145px; }}
    .product.wide img {{ width:145px; height:100%; min-height:145px; }}
    .product.wide .product-copy {{ display:flex; flex-direction:column; justify-content:center; }}
    @media (max-width:800px) {{
      .hero {{ grid-template-columns:1fr; }}
      .hero-copy {{ padding:28px 22px; }}
      .actions {{ grid-template-columns:1fr; }}
      .top {{ align-items:flex-start; }}
    }}
    @media (max-width:480px) {{
      .wrap {{ width:min(100% - 20px,1120px); padding-top:18px; }}
      .badge {{ display:none; }}
      .product-grid {{ grid-template-columns:1fr; }}
      .product.wide {{ grid-column:auto; grid-template-columns:1fr; }}
      .product.wide img {{ width:100%; height:120px; min-height:0; }}
    }}
  </style>
</head>
<body>
  <main class="wrap">
    <div class="top">
      <div class="brand">
        <div class="brand-icon">📱</div>
        <div>Oraforge POS · Tech Shop Demo</div>
      </div>
      <div class="badge">No login required · Demo profile only</div>
    </div>

    <section class="hero">
      <div class="hero-copy">
        <div class="eyebrow">● Live client demo workspace</div>
        <h1>Phone Accessories & Gadgets</h1>
        <p class="lead">
          Jump straight into the exact experience you want to show a client.
          Both portals use the tech-accessories sample catalogue and remain isolated from the other shop profiles.
        </p>

        <div class="actions">
          <a class="portal portal-worker" href="/tech-demo/worker" target="_blank" rel="noopener">
            <span class="icon">🛒</span>
            <small>Sales counter · products · checkout</small>
            <strong>Open Worker / POS →</strong>
          </a>
          <a class="portal portal-admin" href="/tech-demo/admin" target="_blank" rel="noopener">
            <span class="icon">📊</span>
            <small>Dashboard · stock · staff · customers</small>
            <strong>Open Admin Portal →</strong>
          </a>
        </div>

        <div class="note">
          These links create temporary demo sessions for <strong>tech_accessories</strong> only.
          The normal staff/admin login routes are unchanged.
        </div>
      </div>

      <aside class="preview">
        <div class="preview-head">
          <strong>Demo catalogue preview</strong>
          <span class="dot" title="Demo ready"></span>
        </div>
        <div class="product-grid">
          <article class="product">
            <img src="/static/uploads/tech_wireless_earbuds.jpg" alt="Wireless earbuds">
            <div class="product-copy">
              <strong>Wireless Earbuds Pro</strong>
              <span>KES 2,499</span>
            </div>
          </article>
          <article class="product">
            <img src="/static/uploads/tech_phone_cases.jpg" alt="Phone covers">
            <div class="product-copy">
              <strong>Premium Phone Covers</strong>
              <span>From KES 799</span>
            </div>
          </article>
          <article class="product wide">
            <img src="/static/uploads/tech_charging_bundle.jpg" alt="Charging accessories">
            <div class="product-copy">
              <strong>Fast Charger, Cable & Power Bank</strong>
              <span>Demo stock, pricing and checkout are already loaded.</span>
            </div>
          </article>
        </div>
      </aside>
    </section>
  </main>
</body>
</html>"""

def employee_login_page(error="", settings=None):
    if not settings:
        with db() as conn:
            settings = get_settings(conn)
    btype = settings.get("business_type", "bar")
    profile = PROFILES.get(btype, PROFILES["retail"])
    bname = settings.get("business_name", profile["name"])
    btag = settings.get("business_tagline", profile["tagline"])
    bicon = profile.get("icon", "🏢")

    chips = []
    for k, p in PROFILES.items():
        is_active = (k == btype)
        if is_active:
            style = "background:var(--primary); color:var(--primary-fg); border:1px solid var(--primary); font-weight:700; box-shadow:0 1px 3px rgba(0,0,0,0.15);"
            mark = " ✓"
        else:
            style = "background:var(--panel); color:var(--ink); border:1px solid var(--line);"
            mark = ""
        chips.append(f"""
          <button type="submit" name="switch_business_type" value="{k}" class="shop-chip" style="{style} padding:8px 10px; border-radius:8px; font-size:12px; cursor:pointer; display:flex; align-items:center; gap:6px; text-align:left; transition:all 0.15s ease;">
            <span style="font-size:18px;">{p['icon']}</span>
            <span style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">{p['name']}{mark}</span>
          </button>
        """)
    chips_html = "\n".join(chips)

    message = f'<p class="error" style="text-align:center; margin:0 0 8px;">{error}</p>' if error else ""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Staff Login — {bname} POS</title>
  <link rel="stylesheet" href="/static/styles.css?v={now()}">
  <script>
    (function() {{
      var t = localStorage.getItem('pos_theme') || 'light';
      document.documentElement.setAttribute('data-theme', t);
    }})();
  </script>
</head>
<body class="login-body">
  <div style="position:fixed; top:18px; right:18px; z-index:1000;">
    <button id="themeToggleBtn" class="theme-toggle-btn" style="width:40px; height:40px; font-size:18px;" title="Toggle Light / Dark theme">☀️</button>
  </div>

  <form class="login-panel" method="post" action="/login">
    <div style="display:flex; align-items:center; gap:12px; margin-bottom:4px;">
      <div style="width:48px; height:48px; border-radius:12px; background:var(--ink); display:grid; place-items:center; font-size:26px; flex-shrink:0; box-shadow:0 2px 8px rgba(0,0,0,0.15); color:var(--panel);">
        {bicon}
      </div>
      <div>
        <h1 style="margin:0; font-size:21px; font-weight:800; color:var(--ink);">{bname} POS</h1>
        <p style="margin:2px 0 0; color:var(--muted); font-size:12px;">{btag}</p>
      </div>
    </div>

    <div style="background:var(--bg); border:1px solid var(--line); border-radius:10px; padding:12px; margin:4px 0;">
      <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px;">
        <span style="font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">🏢 Select Shop Category</span>
        <span style="font-size:11px; color:var(--muted); font-weight:600;">1-Click Switch</span>
      </div>
      <div style="display:grid; grid-template-columns:repeat(2, 1fr); gap:6px;">
        {chips_html}
      </div>
    </div>

    {message}

    <button type="submit" name="quick_login" value="1" id="quickLoginBtn" style="width:100%; padding:12px; background:var(--primary); color:var(--primary-fg); border-radius:8px; font-weight:700; font-size:14px; border:1px solid var(--primary); cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px; box-shadow:0 2px 8px rgba(0,0,0,0.1);">
      <span>⚡</span> 1-Click Demo Login (PIN: 1234)
    </button>

    <div style="display:flex; align-items:center; gap:10px; margin:2px 0;">
      <div style="flex:1; height:1px; background:var(--line);"></div>
      <span style="font-size:11px; color:var(--muted); text-transform:uppercase; letter-spacing:0.5px;">or enter pin on keypad</span>
      <div style="flex:1; height:1px; background:var(--line);"></div>
    </div>

    <input id="pinInput" name="pin" type="password" inputmode="numeric" pattern="[0-9]*" value="" autocomplete="current-password" autofocus placeholder="Staff PIN" style="text-align:center; font-size:22px; letter-spacing:4px; font-weight:700;">
    <div class="pin-pad" data-pin-pad>
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
      <button type="submit">Enter</button>
    </div>
    <small style="text-align:center; display:block; font-size:12px; color:var(--muted); line-height:1.4;">
      Staff PIN: <strong>1234</strong> • Single codebase supporting all 6 profiles.<br>
      Choose category above to explore tailored features & sample catalog.
    </small>
  </form>
  <script>
    const pinInput = document.getElementById('pinInput');
    document.querySelectorAll('[data-pin-pad] button[data-key]').forEach((button) => {{
      button.addEventListener('click', () => {{
        const key = button.dataset.key;
        if (key === 'clear') pinInput.value = '';
        else if (pinInput.value.length < 6) pinInput.value += key;
        pinInput.focus();
      }});
    }});

    const themeBtn = document.getElementById('themeToggleBtn');
    if (themeBtn) {{
      const cur = document.documentElement.getAttribute('data-theme') || 'light';
      themeBtn.textContent = cur === 'dark' ? '☀️' : '🌙';
      themeBtn.title = cur === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme';
      themeBtn.addEventListener('click', () => {{
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        localStorage.setItem('pos_theme', next);
        themeBtn.textContent = next === 'dark' ? '☀️' : '🌙';
        themeBtn.title = next === 'dark' ? 'Switch to Light Theme' : 'Switch to Dark Theme';
      }});
    }}
  </script>
</body>
</html>"""


def cashier_login_page(error=""):
    message = f'<p class="error">{error}</p>' if error else ""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cashier Login — {STORE_NAME} POS</title>
  <link rel="stylesheet" href="/static/styles.css?v={int(time.time())}">
  <script>
    (function() {{
      var t = localStorage.getItem('pos_theme') || 'light';
      document.documentElement.setAttribute('data-theme', t);
    }})();
  </script>
</head>
<body class="login-body">
  <form class="login-panel" method="post" action="/cashier">
    <h1>Cashier Portal</h1>
    <p>Username and password required</p>
    {message}
    <label>Username<input name="username" autocomplete="username" autofocus></label>
    <label>Password<input name="password" type="password" autocomplete="current-password"></label>
    <button type="submit">Log In</button>
    <small>Default: admin / admin123</small>
  </form>
</body>
</html>"""


def admin_login_page(error="", selected_business_type=None):
    if selected_business_type not in PROFILES:
        with db() as conn:
            selected_business_type = active_business_type(None, conn)
    profile = PROFILES[selected_business_type]
    options = "".join(
        f'<option value="{key}" {"selected" if key == selected_business_type else ""}>{item["icon"]} {item["name"]}</option>'
        for key, item in PROFILES.items()
    )
    message = f'<p class="err">{error}</p>' if error else ""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{profile['name']} — Admin Login</title>
  <link rel="stylesheet" href="/static/admin.css?v={int(time.time())}">
  <style>
    body {{ display:grid; place-items:center; min-height:100vh; background:var(--bg); }}
    .admin-login-panel {{ width:min(410px,calc(100vw - 32px)); background:var(--panel); border:1px solid var(--line); border-radius:var(--radius); box-shadow:var(--shadow-lg); padding:36px; display:grid; gap:18px; }}
    .admin-login-panel .brand {{ display:flex; align-items:center; gap:10px; }}
    .admin-login-panel .logo-icon {{ width:42px; height:42px; background:var(--primary); border-radius:9px; display:grid; place-items:center; font-size:22px; color:#fff; }}
    .admin-login-panel h2 {{ margin:0; font-size:20px; font-weight:800; color:var(--navy); }}
    .admin-login-panel p {{ margin:2px 0 0; color:var(--muted); font-size:13px; }}
    .admin-login-panel .err {{ color:var(--danger); font-weight:700; font-size:13px; }}
    .workspace-box {{ padding:12px; border:1px solid var(--line); background:var(--bg); border-radius:10px; }}
  </style>
</head>
<body>
  <form class="admin-login-panel" method="post" action="/admin">
    <div class="brand">
      <div class="logo-icon">{profile['icon']}</div>
      <div><h2>Shop Admin Portal</h2><p>Choose the shop workspace you want to manage.</p></div>
    </div>
    {message}
    <div class="workspace-box">
      <label class="form-label">Shop Category / Workspace</label>
      <select class="form-select" name="business_type" required>{options}</select>
    </div>
    <div class="form-group"><label class="form-label">Username</label><input class="form-input" name="username" autocomplete="username" autofocus placeholder="admin"></div>
    <div class="form-group"><label class="form-label">Password</label><input class="form-input" name="password" type="password" autocomplete="current-password" placeholder="••••••••"></div>
    <button class="btn btn-primary" type="submit" style="width:100%;justify-content:center;padding:12px">Sign In to Selected Shop</button>
  </form>
</body>
</html>"""


class POSHandler(SimpleHTTPRequestHandler):
    server_version = "NIGHTCLUBPOS/1.0"

    def log_message(self, format, *args):
        return

    def end_headers(self):
        # Cache static assets aggressively (1 hour)
        if hasattr(self, 'path') and self.path.startswith("/static/"):
            self.send_header("Cache-Control", "public, max-age=3600")
        super().end_headers()

    def send_html(self, html, status=200):
        data = html.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_json(self, payload, status=200):
        data = json.dumps(payload, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        content_type = self.headers.get("Content-Type", "")
        if "application/json" in content_type:
            return json.loads(raw or b"{}")
        return {k: v[0] for k, v in parse_qs(raw.decode()).items()}

    def session_user(self):
        header = self.headers.get("Cookie", "")
        jar = cookies.SimpleCookie(header)
        sid = jar.get("sid")
        return SESSIONS.get(sid.value) if sid else None

    def require_user(self):
        user = self.session_user()
        if user:
            return user
        if self.path.startswith("/api/"):
            self.send_json({"error": "login_required"}, 401)
        else:
            self.send_response(302)
            self.send_header("Location", "/login")
            self.end_headers()
        return None

    def require_cashier(self, user):
        if user.get("role") in ("manager", "cashier"):
            return True
        if self.path.startswith("/api/"):
            self.send_json({"error": "cashier_login_required"}, 403)
        else:
            self.send_html(page("Cashier Required", "", '<section class="empty">Cashier login required for this page</section>'), 403)
        return False

    def require_manager(self, user):
        if user.get("role") == "manager":
            return True
        if self.path.startswith("/api/"):
            self.send_json({"error": "manager_login_required"}, 403)
        else:
            self.send_html(page("Admin Required", "", '<section class="empty">Admin manager login required for this page</section>'), 403)
        return False

    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        if path.startswith("/static/"):
            self.directory = str(BASE_DIR)
            # Send with aggressive cache headers for CSS/JS/fonts
            result = super().do_GET()
            return result
        if path == "/tech-demo":
            self.send_html(tech_demo_page())
            return
        if path in ("/tech-demo/worker", "/tech-demo/admin"):
            is_admin = path.endswith("/admin")
            username = "admin" if is_admin else "terminal"
            with db() as conn:
                seed_sample_data(conn, "tech_accessories")
                demo_user = conn.execute(
                    "SELECT * FROM users WHERE username = ? AND active = 1",
                    (username,),
                ).fetchone()
            if not demo_user:
                self.send_html(
                    tech_demo_page().replace(
                        "</main>",
                        '<p style="text-align:center;color:#b91c1c;font-weight:700;">Demo account is unavailable. Restart the POS server once to recreate seeded users.</p></main>'
                    ),
                    500,
                )
                return

            sid = secrets.token_urlsafe(32)
            SESSIONS[sid] = {
                "id": demo_user["id"],
                "username": demo_user["username"],
                "role": demo_user["role"],
                "name": demo_user["full_name"],
                "business_type": "tech_accessories",
                "demo": True,
            }
            self.send_response(302)
            self.send_header("Set-Cookie", f"sid={sid}; HttpOnly; SameSite=Lax; Path=/")
            self.send_header("Location", "/admin" if is_admin else "/pos")
            self.end_headers()
            return
        if path in ("/", "/login"):
            if self.session_user():
                self.send_response(302)
                self.send_header("Location", "/pos")
                self.end_headers()
            else:
                with db() as conn:
                    settings = get_settings(conn)
                self.send_html(employee_login_page(settings=settings))
            return
        if path == "/cashier":
            user = self.session_user()
            if user and user.get("role") in ("manager", "cashier"):
                # Authenticated cashier — show the payments page directly
                self.send_html(page("Cashier", "Cashier", '<section class="page-shell" data-page="cashier"></section>', user.get("role")))
            else:
                self.send_html(cashier_login_page())
            return
        if path == "/logout":
            sid = cookies.SimpleCookie(self.headers.get("Cookie", "")).get("sid")
            if sid:
                SESSIONS.pop(sid.value, None)
            self.send_response(302)
            self.send_header("Set-Cookie", "sid=; Max-Age=0; Path=/")
            self.send_header("Location", "/login")
            self.end_headers()
            return

        if path == "/secret-admin":
            user = self.session_user()
            if not user:
                self.send_html(admin_login_page())
                return
            if user.get("role") != "manager":
                self.send_html(admin_login_page("Access denied: manager account required"), 403)
                return
            self.send_html(hidden_admin_page(active_business_type(user)))
            return

        if path == "/admin":
            user = self.session_user()
            if not user:
                self.send_html(admin_login_page())
                return
            if user.get("role") != "manager":
                self.send_html(admin_login_page("Access denied: manager account required"), 403)
                return
            self.send_html(hidden_admin_page(active_business_type(user)))
            return

        user = self.require_user()
        if not user:
            return

        if path.startswith("/api/"):
            return self.api_get(path, parse_qs(parsed.query), user)

        if path == "/receipt":
            order_id = parse_qs(parsed.query).get("order_id", [""])[0]
            if not order_id.isdigit():
                self.send_html(page("Receipt", "", '<section class="empty">Missing order id</section>'), 400)
                return
            with db() as conn:
                order = get_order_payload(conn, int(order_id))
                current_btype = active_business_type(user, conn)
                settings = scoped_settings(conn, current_btype)
            if not order or order.get("business_type") != current_btype:
                self.send_html(page("Receipt", "", '<section class="empty">Order not found</section>'), 404)
                return
            autoprint = parse_qs(parsed.query).get("print", ["0"])[0] == "1"
            is_kot = parse_qs(parsed.query).get("kot", ["0"])[0] == "1"
            self.send_html(receipt_page(order, autoprint, is_kot=is_kot, settings=settings))
            return

        pages = {
            "/pos": ("POS", "POS", '<section class="pos-shell" data-page="pos"></section>'),
            "/suppliers": ("Suppliers", "Suppliers", '<section class="page-shell" data-page="suppliers"></section>'),
            "/sales": ("Sales", "Sales", '<section class="page-shell" data-page="sales"></section>'),
            "/products": ("Products", "Products", '<section class="page-shell" data-page="products"></section>'),
            "/customers": ("Customers", "Customers", '<section class="page-shell" data-page="customers"></section>'),
            "/reports": ("Reports", "Reports", '<section class="page-shell" data-page="reports"></section>'),
            "/settings": ("Settings", "Settings", '<section class="page-shell" data-page="settings"></section>'),
        }
        if path in pages:
            title, active, content = pages[path]
            self.send_html(page(title, active, content, user.get("role")))
            return
        self.send_html(page("Not Found", "", '<section class="empty">Page not found</section>'), 404)

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        method = self.command
        if path == "/login":
            data = self.read_body()
            switch_to = data.get("switch_business_type")
            if switch_to and switch_to in PROFILES:
                prof = PROFILES[switch_to]
                with db() as conn:
                    save_settings(conn, {
                        "business_type": switch_to,
                        "business_name": prof.get("name", switch_to),
                        "business_tagline": prof.get("tagline", ""),
                    })
                CACHE.clear()
                self.send_response(302)
                self.send_header("Location", "/login")
                self.end_headers()
                return

            if str(data.get("quick_login", "")).strip() in ("1", "true"):
                pin = "1234"
            else:
                pin = data.get("pin", "")

            user = None
            with db() as conn:
                user = conn.execute("SELECT * FROM users WHERE username = 'terminal' AND active = 1").fetchone()
            if user and not check_password(pin, user["password_hash"]):
                user = None
            if user:
                with db() as login_conn:
                    login_business_type = active_business_type(None, login_conn)
                sid = secrets.token_urlsafe(32)
                SESSIONS[sid] = {"id": user["id"], "username": user["username"], "role": user["role"], "name": user["full_name"], "business_type": login_business_type}
                self.send_response(302)
                self.send_header("Set-Cookie", f"sid={sid}; HttpOnly; SameSite=Lax; Path=/")
                self.send_header("Location", "/pos")
                self.end_headers()
            else:
                with db() as conn:
                    settings = get_settings(conn)
                self.send_html(employee_login_page("Invalid PIN", settings=settings), 401)
            return
        if path == "/cashier":
            data = self.read_body()
            with db() as conn:
                user = conn.execute(
                    "SELECT * FROM users WHERE username = ? AND role IN ('manager', 'cashier') AND active = 1",
                    (data.get("username", ""),),
                ).fetchone()
            if user and check_password(data.get("password", ""), user["password_hash"]):
                with db() as login_conn:
                    login_business_type = active_business_type(None, login_conn)
                sid = secrets.token_urlsafe(32)
                SESSIONS[sid] = {"id": user["id"], "username": user["username"], "role": user["role"], "name": user["full_name"], "business_type": login_business_type}
                self.send_response(302)
                self.send_header("Set-Cookie", f"sid={sid}; HttpOnly; SameSite=Lax; Path=/")
                self.send_header("Location", "/cashier")
                self.end_headers()
            else:
                self.send_html(cashier_login_page("Invalid username or password"), 401)
            return
        if path == "/admin":
            data = self.read_body()
            login_business_type = data.get("business_type", "")
            if login_business_type not in PROFILES:
                with db() as login_conn:
                    login_business_type = active_business_type(None, login_conn)
            with db() as conn:
                user = conn.execute(
                    "SELECT * FROM users WHERE username = ? AND role = 'manager' AND active = 1",
                    (data.get("username", ""),),
                ).fetchone()
            if user and check_password(data.get("password", ""), user["password_hash"]):
                sid = secrets.token_urlsafe(32)
                SESSIONS[sid] = {"id": user["id"], "username": user["username"], "role": user["role"], "name": user["full_name"], "business_type": login_business_type}
                self.send_response(302)
                self.send_header("Set-Cookie", f"sid={sid}; HttpOnly; SameSite=Lax; Path=/")
                self.send_header("Location", "/admin")
                self.end_headers()
            else:
                self.send_html(admin_login_page("Invalid credentials or insufficient permissions"), 401)
            return

        user = self.require_user()
        if not user:
            return
        if path.startswith("/api/"):
            return self.api_post(path, self.read_body(), user, method, query)
        self.send_json({"error": "not_found"}, 404)

    def api_get(self, path, query, user):
        with db() as conn:
            btype = active_business_type(user, conn)
            settings = scoped_settings(conn, btype)
            if path == "/api/bootstrap":
                profile = PROFILES.get(btype, PROFILES["retail"])

                expiry_alerts = 0
                if profile["capabilities"].get("batches_expiry"):
                    future_str = (__import__('datetime').date.today() + __import__('datetime').timedelta(days=60)).isoformat()
                    expiry_alerts = conn.execute(
                        "SELECT COUNT(*) FROM menu_items mi JOIN categories c ON c.id = mi.category_id WHERE mi.active = 1 AND c.business_type = ? AND mi.expiry_date IS NOT NULL AND mi.expiry_date != '' AND mi.expiry_date <= ?",
                        (btype, future_str,)
                    ).fetchone()[0]

                low_stock_alerts = 0
                if profile["capabilities"].get("reorder_levels"):
                    low_stock_alerts = conn.execute(
                        "SELECT COUNT(*) FROM menu_items mi JOIN categories c ON c.id = mi.category_id WHERE mi.active = 1 AND c.business_type = ? AND mi.unit != 'service' AND mi.stock_qty <= mi.reorder_level", (btype,)
                    ).fetchone()[0]

                tables = self.tables_payload(conn, btype) if profile["capabilities"].get("tables") else []

                self.send_json({
                    "user": user,
                    "settings": settings,
                    "profile": profile,
                    "profiles": PROFILES,
                    "capabilities": profile["capabilities"],
                    "employees": self.employees_payload(conn),
                    "menu": self.menu_payload(conn, btype),
                    "suppliers": rows(conn.execute("SELECT * FROM suppliers WHERE active = 1 AND business_type = ? ORDER BY name", (btype,))),
                    "tables": tables,
                    "alerts": {
                        "expiry": expiry_alerts,
                        "low_stock": low_stock_alerts,
                    }
                })
            elif path == "/api/settings":
                profile = PROFILES.get(btype, PROFILES["retail"])
                self.send_json({
                    "settings": settings,
                    "profile": profile,
                    "profiles": PROFILES,
                    "capabilities": profile["capabilities"],
                })
            elif path == "/api/tables":
                self.send_json(self.tables_payload(conn, btype))
            elif path == "/api/product/image-search":
                q = query.get("q", [""])[0].strip()
                res = search_product_images(q, limit=1)
                self.send_json({"query": q, "results": res, "images": res})
            elif path == "/api/menu":
                self.send_json(self.menu_payload(conn, btype))
            elif path == "/api/suppliers":
                self.send_json(rows(conn.execute("SELECT * FROM suppliers WHERE business_type = ? ORDER BY name", (btype,))))
            elif path == "/api/supplier/detail":
                supplier_id = int(query.get("id", [0])[0])
                supplier_row = conn.execute("SELECT * FROM suppliers WHERE id = ? AND business_type = ?", (supplier_id, btype)).fetchone()
                if not supplier_row:
                    return self.send_json({"error": "supplier_not_found"}, 404)
                supplier = dict(supplier_row)
                products = rows(conn.execute(
                    """
                    SELECT m.name, m.cost_cents, m.stock_qty, MAX(sp.date_received) as last_delivery
                    FROM menu_items m
                    LEFT JOIN stock_purchases sp ON sp.product_id = m.id
                    WHERE m.supplier_id = ? AND m.active = 1
                    GROUP BY m.id
                    """, (supplier_id,)
                ))
                stats = dict(conn.execute(
                    "SELECT COALESCE(SUM(total_cost_cents), 0) as total_purchases FROM stock_purchases WHERE supplier_id = ?",
                    (supplier_id,)
                ).fetchone())
                supplier["products"] = products
                supplier["total_purchases"] = stats["total_purchases"]
                self.send_json(supplier)
            elif path == "/api/stock":
                self.send_json(rows(conn.execute(
                    """
                    SELECT mi.id, mi.name, mi.sku, mi.barcode, mi.stock_qty, mi.unit, mi.category_id, mi.price_cents, mi.cost_cents,
                           wholesale_price_cents, reorder_level, batch_no, expiry_date, manufacturer, strength,
                           variants_json, decimal_qty_enabled, image_url
                    FROM menu_items mi
                    JOIN categories c ON c.id = mi.category_id
                    WHERE mi.active = 1 AND c.business_type = ? AND mi.unit != 'service'
                    ORDER BY mi.stock_qty ASC, mi.name
                    """, (btype,)
                )))
            elif path == "/api/order":
                order_id = query.get("id", [""])[0]
                if not order_id.isdigit():
                    return self.send_json({"error": "invalid_id"}, 400)
                order = get_order_payload(conn, int(order_id))
                if not order or order.get("business_type") != btype:
                    return self.send_json({"error": "not_found"}, 404)
                self.send_json(order)
            elif path == "/api/orders":
                status = query.get("status", ["open"])[0]
                sql = """
                    SELECT o.*, u.full_name AS employee_name
                    FROM orders o
                    LEFT JOIN users u ON u.id = o.created_by
                    WHERE o.business_type = ? AND (? = 'all' OR o.status = ?)
                    ORDER BY o.updated_at DESC LIMIT 80
                """
                self.send_json(rows(conn.execute(sql, (btype, status, status))))
            elif path == "/api/payments":
                if not self.require_cashier(user):
                    return
                term = query.get("q", [""])[0].strip()
                like = f"%{term}%"
                self.send_json(rows(conn.execute(
                    """
                    SELECT o.*, u.full_name AS employee_name
                    FROM orders o
                    LEFT JOIN users u ON u.id = o.created_by
                    WHERE o.business_type = ? AND o.status IN ('open', 'sent')
                    AND (? = '' OR o.ticket_no LIKE ? OR u.full_name LIKE ? OR o.customer_name LIKE ?)
                    ORDER BY o.updated_at DESC LIMIT 80
                    """,
                    (btype, term, like, like, like),
                )))
            elif path == "/api/reports":
                period = query.get("period", ["today"])[0]
                if period not in ("today", "yesterday", "week", "month"):
                    period = "today"
                start_ts, end_ts, range_label = report_period_bounds(period)

                totals = dict(conn.execute(
                    """
                    SELECT
                        COUNT(DISTINCT o.id) AS orders,
                        COALESCE(SUM(oi.line_total_cents), 0) AS sales,
                        COALESCE(SUM(oi.qty * COALESCE(oi.cost_cents, mi.cost_cents, 0)), 0) AS costs,
                        COALESCE(SUM(oi.qty), 0) AS items_sold
                    FROM orders o
                    JOIN order_items oi ON o.id = oi.order_id
                    LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
                    WHERE o.business_type = ?
                      AND o.status = 'paid'
                      AND COALESCE(o.paid_at, o.updated_at) >= ?
                      AND COALESCE(o.paid_at, o.updated_at) < ?
                    """,
                    (btype, start_ts, end_ts),
                ).fetchone())

                payments = rows(conn.execute(
                    """
                    SELECT COALESCE(payment_method, 'cash') AS method,
                           COUNT(*) AS transactions,
                           COALESCE(SUM(total_cents), 0) AS amount
                    FROM orders
                    WHERE business_type = ?
                      AND status = 'paid'
                      AND COALESCE(paid_at, updated_at) >= ?
                      AND COALESCE(paid_at, updated_at) < ?
                    GROUP BY COALESCE(payment_method, 'cash')
                    ORDER BY amount DESC
                    """,
                    (btype, start_ts, end_ts),
                ))

                top_items = rows(conn.execute(
                    """
                    SELECT
                        oi.name,
                        COALESCE(SUM(oi.qty), 0) AS qty,
                        COALESCE(SUM(oi.line_total_cents), 0) AS sales,
                        MAX(mi.stock_qty) AS current_stock
                    FROM order_items oi
                    JOIN orders o ON o.id = oi.order_id
                    LEFT JOIN menu_items mi ON oi.menu_item_id = mi.id
                    WHERE o.business_type = ?
                      AND o.status = 'paid'
                      AND COALESCE(o.paid_at, o.updated_at) >= ?
                      AND COALESCE(o.paid_at, o.updated_at) < ?
                    GROUP BY oi.menu_item_id, oi.name
                    ORDER BY sales DESC, qty DESC
                    LIMIT 15
                    """,
                    (btype, start_ts, end_ts),
                ))

                stock_stats = dict(conn.execute(
                    """
                    SELECT
                        COALESCE(SUM(mi.stock_qty * mi.cost_cents), 0) AS inventory_value,
                        COALESCE(SUM(mi.stock_qty * (mi.price_cents - mi.cost_cents)), 0) AS potential_profit
                    FROM menu_items mi
                    JOIN categories c ON c.id = mi.category_id
                    WHERE mi.active = 1 AND mi.stock_qty > 0 AND c.business_type = ? AND mi.unit != 'service'
                    """,
                    (btype,),
                ).fetchone())

                self.send_json({
                    "totals": totals,
                    "payments": payments,
                    "top_items": top_items,
                    "period": period,
                    "range": {"start": start_ts, "end": end_ts, "label": range_label, "timezone": "Africa/Nairobi"},
                    "stock": stock_stats,
                })
            elif path == "/api/admin/summary":
                if not self.require_manager(user):
                    return
                self.send_json(self.admin_summary(conn, btype))
            elif path == "/api/admin/customers":
                self.send_json(rows(conn.execute("SELECT * FROM customers WHERE business_type = ? ORDER BY name", (btype,))))
            elif path == "/api/admin/sms/config":
                if not self.require_manager(user):
                    return
                sms_cfg = sozuri_sms_config()
                self.send_json({
                    "provider": "Sozuri",
                    "configured": sms_cfg["configured"],
                    "project": sms_cfg.get("project", ""),
                    "bulk_enabled": True,
                })
            elif path == "/api/admin/users":
                if not self.require_manager(user):
                    return
                self.send_json(rows(conn.execute(
                    "SELECT id, username, full_name, role, active FROM users ORDER BY role, full_name"
                )))
            elif path == "/api/admin/suppliers":
                if not self.require_manager(user):
                    return
                self.send_json(rows(conn.execute("SELECT * FROM suppliers WHERE business_type = ? ORDER BY name", (btype,))))
            else:
                self.send_json({"error": "not_found"}, 404)

    def api_post(self, path, data, user, method="POST", query=None):
        with db() as conn:
            btype = active_business_type(user, conn)
            if path == "/api/settings":
                requested_btype = data.get("business_type")
                if requested_btype in PROFILES:
                    btype = requested_btype
                    user["business_type"] = requested_btype
                save_settings(conn, data)
                CACHE.clear()
                settings = scoped_settings(conn, btype)
                profile = PROFILES.get(btype, PROFILES["retail"])
                self.send_json({
                    "ok": True,
                    "settings": settings,
                    "profile": profile,
                    "capabilities": profile["capabilities"],
                })
            elif path == "/api/seed-samples":
                pid = data.get("profile_id")
                seed_sample_data(conn, pid)
                CACHE.clear()
                self.send_json({"ok": True, "menu": self.menu_payload(conn, btype)})
            elif path == "/api/product/save-image":
                img_src = data.get("image_url") or data.get("image_base64")
                if not img_src:
                    return self.send_json({"error": "missing_image_data"}, 400)
                saved_url = optimize_and_save_image(img_src)
                if not saved_url:
                    return self.send_json({"error": "image_optimization_failed"}, 400)
                self.send_json({"ok": True, "image_url": saved_url, "local_url": saved_url})
            elif path == "/api/order/kot":
                order_id = int(data["order_id"])
                conn.execute("UPDATE orders SET status = 'sent', updated_at = ? WHERE id = ?", (now(), order_id))
                self.send_json(get_order_payload(conn, order_id))
            elif path == "/api/order/convert-quote":
                order_id = int(data["order_id"])
                conn.execute("UPDATE orders SET is_quote = 0, order_type = 'walk-in', status = 'open', updated_at = ? WHERE id = ?", (now(), order_id))
                recalc_order(conn, order_id)
                self.send_json(get_order_payload(conn, order_id))
            elif path == "/api/orders":
                employee_id = data.get("employee_id") or user["id"]
                valid_employee = conn.execute(
                    "SELECT id FROM users WHERE id = ? AND role IN ('staff', 'cashier', 'manager', 'terminal') AND active = 1",
                    (int(employee_id),),
                ).fetchone()
                if not valid_employee:
                    employee_id = user["id"]
                ticket = next_ticket(conn)
                customer_name = data.get("customer_name", "") or ""
                table_id = int(data["table_id"]) if data.get("table_id") else None
                notes = data.get("notes", "") or ""
                pricing_tier = data.get("pricing_tier", "retail")
                is_quote = 1 if (data.get("is_quote") or data.get("order_type") == "quote") else 0
                cur = conn.execute(
                    """
                    INSERT INTO orders(ticket_no, table_id, order_type, customer_name, notes, pricing_tier, is_quote, created_by, created_at, updated_at, business_type)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (ticket, table_id, data.get("order_type", "walk-in"), customer_name, notes, pricing_tier, is_quote, employee_id, now(), now(), btype),
                )
                self.send_json(get_order_payload(conn, cur.lastrowid))
            elif path == "/api/order/add":
                order_id = int(data["order_id"])
                item = conn.execute("SELECT mi.* FROM menu_items mi JOIN categories c ON c.id = mi.category_id WHERE mi.id = ? AND mi.active = 1 AND c.business_type = ?", (int(data["menu_item_id"]), btype)).fetchone()
                if not item:
                    return self.send_json({"error": "item_not_found"}, 404)
                order = conn.execute("SELECT * FROM orders WHERE id = ? AND business_type = ?", (order_id, btype)).fetchone()
                if not order:
                    return self.send_json({"error": "order_not_found"}, 404)

                qty = float(data.get("qty", 1))
                note = data.get("note", "").strip()
                variant_info = data.get("variant_info", "").strip()
                batch_no = data.get("batch_no", "") or (item["batch_no"] or "")

                pricing_tier = data.get("pricing_tier") or order["pricing_tier"] or "retail"
                if pricing_tier == "wholesale" and item["wholesale_price_cents"] > 0:
                    unit_price = item["wholesale_price_cents"]
                elif data.get("unit_price_cents"):
                    unit_price = int(data["unit_price_cents"])
                else:
                    unit_price = item["price_cents"]

                existing = conn.execute(
                    "SELECT * FROM order_items WHERE order_id = ? AND menu_item_id = ? AND note = ? AND variant_info = ?",
                    (order_id, item["id"], note, variant_info),
                ).fetchone()
                if existing:
                    new_qty = existing["qty"] + qty
                    conn.execute(
                        "UPDATE order_items SET qty = ?, line_total_cents = ? WHERE id = ?",
                        (new_qty, int(round(new_qty * unit_price)), existing["id"]),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO order_items(order_id, menu_item_id, name, qty, unit_price_cents, line_total_cents, note, variant_info, batch_no, cost_cents)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (order_id, item["id"], item["name"], qty, unit_price, int(round(qty * unit_price)), note, variant_info, batch_no, item["cost_cents"]),
                    )
                recalc_order(conn, order_id)
                self.send_json(get_order_payload(conn, order_id))
            elif path == "/api/order/qty":
                item_id = int(data["item_id"])
                qty = max(0.0, float(data["qty"]))
                row = conn.execute("SELECT order_id, unit_price_cents FROM order_items WHERE id = ?", (item_id,)).fetchone()
                if not row:
                    return self.send_json({"error": "item_not_found"}, 404)
                if qty <= 0:
                    conn.execute("DELETE FROM order_items WHERE id = ?", (item_id,))
                else:
                    conn.execute(
                        "UPDATE order_items SET qty = ?, line_total_cents = ? WHERE id = ?",
                        (qty, int(round(qty * row["unit_price_cents"])), item_id),
                    )
                recalc_order(conn, row["order_id"])
                self.send_json(get_order_payload(conn, row["order_id"]))
            elif path == "/api/swifta/stkpush":
                import urllib.request, urllib.error
                import math
                phone = "".join(c for c in str(data.get("phone", "")) if c.isdigit())
                if phone.startswith("254") and len(phone) == 12:
                    phone = "0" + phone[3:]
                amount = data.get("amount")
                if len(phone) != 10 or phone[:2] not in ("07", "01") or isinstance(amount, bool) or not isinstance(amount, (int, float)) or not math.isfinite(amount) or amount <= 0 or not data.get("accountReference"):
                    return self.send_json({"status": False, "message": "Invalid phone, amount or reference"}, 400)
                key_file = BASE_DIR / "swifta.txt"
                key = key_file.read_text().strip() if key_file.exists() else ""
                if not key:
                    return self.send_json({"status": False, "message": "Swifta key is missing from swifta.txt"}, 503)
                payload = {"phone": phone, "amount": amount, "accountReference": str(data["accountReference"]), "description": str(data.get("description") or "POS payment")}
                req = urllib.request.Request("https://app.swifta.co.ke/stkpush", data=json.dumps(payload).encode(), headers={"x-api-key": key, "Content-Type": "application/json", "Accept": "application/json"})
                try:
                    with urllib.request.urlopen(req, timeout=30) as response:
                        result = json.load(response)
                    details = result.get("data") if isinstance(result.get("data"), dict) else result
                    code = details.get("ResponseCode", details.get("responseCode", result.get("ResponseCode", result.get("responseCode"))))
                    failed = result.get("success") is False or result.get("status") is False or details.get("success") is False or details.get("status") is False or (code is not None and str(code) != "0")
                    accepted = not failed and (str(code) == "0" or result.get("success") is True or result.get("status") is True or str(result.get("status")).lower() in ("success", "accepted", "pending"))
                    message = details.get("errorMessage") or result.get("errorMessage") or details.get("ResponseDescription") or result.get("message") or ("STK request accepted" if accepted else "Could not confirm STK acceptance. Check Swifta before retrying.")
                    return self.send_json({"status": accepted, "message": str(message).replace(key, "[redacted]"), "data": {"status": "pay_offline" if accepted else "failed", "reference": details.get("CheckoutRequestID") or details.get("checkoutRequestId") or details.get("reference") or ""}})
                except Exception:
                    return self.send_json({"status": False, "message": "Could not confirm the Swifta request. Check payment status before retrying."}, 502)
            elif path == "/api/order/pay":
                order_id = int(data["order_id"])
                order = conn.execute("SELECT status, total_cents, customer_name FROM orders WHERE id = ? AND business_type = ?", (order_id, btype)).fetchone()
                if not order:
                    return self.send_json({"error": "order_not_found"}, 404)
                
                if order["status"] != "paid":
                    # VAT only applies when an owner has explicitly configured a rate.
                    # Sale prices remain tax-inclusive; no tax is added to the total.
                    settings = get_settings(conn)
                    confirmed = str(settings.get("tax_rate_confirmed", "false")).lower() in ("1", "true", "yes")
                    rate = float(settings.get("tax_rate", 0) or 0) if confirmed else 0.0
                    rate = rate if 0.0 < rate <= 100.0 else 0.0
                    recorded_tax = round(order["total_cents"] * rate / (100.0 + rate)) if rate else 0
                    conn.execute("UPDATE orders SET tax_cents = ? WHERE id = ?", (recorded_tax, order_id))
                    items = conn.execute("SELECT oi.menu_item_id, oi.qty, mi.unit FROM order_items oi LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id WHERE oi.order_id = ?", (order_id,)).fetchall()
                    for item in items:
                        if item["menu_item_id"] and item["unit"] != "service":
                            conn.execute("UPDATE menu_items SET stock_qty = stock_qty - ? WHERE id = ?", (item["qty"], item["menu_item_id"]))
                            conn.execute(
                                "INSERT INTO stock_movements(product_id, qty_change, reason, note, created_by, created_at, business_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
                                (item["menu_item_id"], -item["qty"], "sale", f"Order #{order_id}", user["id"], now(), btype),
                            )

                payment_method = data.get("payment_method", "cash")
                payment_ref = data.get("payment_ref", "").strip()
                customer_phone = normalize_customer_phone(data.get("customer_phone", ""))
                if payment_method == "mpesa":
                    payment_ref = normalize_customer_phone(payment_ref) or payment_ref
                    customer_phone = customer_phone or normalize_customer_phone(payment_ref)
                customer_name = order["customer_name"]

                if payment_method == "mpesa" and payment_ref:
                    import urllib.request, urllib.error
                    
                    phone_no = payment_ref
                    if phone_no.startswith('0'):
                        phone_no = '+254' + phone_no[1:]
                    
                    # paystack_payload = json.dumps({
                    #     "email": f"customer_{order_id}@eityfit.com",
                    #     "amount": order["total_cents"],
                    #     "currency": "KES",
                    #     "mobile_money": {
                    #         "phone": phone_no,
                    #         "provider": "mpesa"
                    #     }
                    # }).encode('utf-8')
                    # 
                    # req = urllib.request.Request("https://api.paystack.co/charge", data=paystack_payload)
                    # req.add_header("Authorization", "Bearer " + __import__("os").environ.get("PAYSTACK_SECRET_KEY", "your_paystack_secret_key_here"))
                    # req.add_header("Content-Type", "application/json")
                    # req.add_header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
                    # 
                    # try:
                    #     with urllib.request.urlopen(req) as response:
                    #         res_data = json.loads(response.read().decode())
                    #         if not res_data.get("status"):
                    #             return self.send_json({"error": res_data.get("message", "Paystack STK push failed")}, 400)
                    # except urllib.error.HTTPError as e:
                    #     try:
                    #         err_res = json.loads(e.read().decode())
                    #         err_msg = err_res.get("message", "Payment API error")
                    #     except:
                    #         err_msg = str(e)
                    #     return self.send_json({"error": err_msg}, 400)
                    # except Exception as e:
                    #     return self.send_json({"error": "Connection to Paystack failed: " + str(e)}, 500)

                    # Save the M-Pesa/STK phone into Customers after a successful payment.
                    customer = find_customer_by_phone(conn, payment_ref, btype)
                    if not customer:
                        conn.execute(
                            "INSERT INTO customers(name, phone, notes, business_type) VALUES (?, ?, ?, ?)",
                            (customer_name.strip() or "Customer", normalize_customer_phone(payment_ref), "Auto-saved from M-Pesa purchase", btype),
                        )

                if payment_method != "mpesa" and customer_phone:
                    customer = find_customer_by_phone(conn, customer_phone, btype)
                    if not customer:
                        conn.execute(
                            "INSERT INTO customers(name, phone, notes, business_type) VALUES (?, ?, ?, ?)",
                            (customer_name.strip() or "Customer", customer_phone, "Saved from POS checkout", btype),
                        )

                paid_ts = now()
                conn.execute(
                    "UPDATE orders SET status = 'paid', paid_cents = ?, payment_method = ?, payment_ref = ?, customer_name = ?, paid_at = COALESCE(paid_at, ?), updated_at = ? WHERE id = ?",
                    (order["total_cents"], payment_method, payment_ref, customer_name, paid_ts, paid_ts, order_id),
                )
                self.send_json(get_order_payload(conn, order_id))
            elif path == "/api/order/status":
                order_id = int(data["order_id"])
                status = data.get("status", "sent")
                conn.execute("UPDATE orders SET status = ?, updated_at = ? WHERE id = ?", (status, now(), order_id))
                self.send_json(get_order_payload(conn, order_id))
            elif path == "/api/menu/item" and method == "DELETE":
                item_id = int(query.get("id", [0])[0])
                try:
                    conn.execute("DELETE FROM menu_items WHERE id = ?", (item_id,))
                    CACHE["menu"] = None
                    self.send_json(self.menu_payload(conn))
                except sqlite3.IntegrityError:
                    self.send_json({"error": "Cannot delete product. It has already been sold on past receipts or has stock history."}, status=400)
            elif path == "/api/menu/item":
                price_cents = int(float(data.get("price", "0")) * 100)
                cost_cents = int(float(data.get("cost", "0")) * 100)
                wholesale_price_cents = int(float(data.get("wholesale_price", "0")) * 100) if data.get("wholesale_price") else 0
                sku = data.get("sku", "").strip() or None
                barcode = data.get("barcode", "").strip() or None
                unit = data.get("unit", "pcs").strip() or "pcs"
                stock_qty = float(data.get("stock_qty", 0))
                reorder_level = int(data.get("reorder_level", 5))
                batch_no = data.get("batch_no", "").strip() or None
                expiry_date = data.get("expiry_date", "").strip() or None
                manufacturer = data.get("manufacturer", "").strip() or None
                strength = data.get("strength", "").strip() or None
                variants_json = data.get("variants_json", "").strip() or ""
                decimal_qty_enabled = 1 if data.get("decimal_qty_enabled") in (1, "1", True, "true") else 0

                image_url = data.get("image_url")
                if data.get("image_base64"):
                    saved = optimize_and_save_image(data["image_base64"])
                    if saved:
                        image_url = saved

                if data.get("id"):
                    conn.execute(
                        """
                        UPDATE menu_items SET category_id=?, name=?, price_cents=?, cost_cents=?, color=?, active=?,
                               sku=?, barcode=?, unit=?, stock_qty=?, image_url=?, reorder_level=?,
                               batch_no=?, expiry_date=?, manufacturer=?, strength=?,
                               wholesale_price_cents=?, variants_json=?, decimal_qty_enabled=?
                        WHERE id=?
                        """,
                        (
                            int(data["category_id"]), data["name"], price_cents, cost_cents,
                            data.get("color", "#334155"), int(data.get("active", 1)),
                            sku, barcode, unit, stock_qty, image_url, reorder_level,
                            batch_no, expiry_date, manufacturer, strength,
                            wholesale_price_cents, variants_json, decimal_qty_enabled,
                            int(data["id"])
                        ),
                    )
                else:
                    conn.execute(
                        """
                        INSERT INTO menu_items(
                            category_id, name, price_cents, cost_cents, color, sku, barcode, unit, stock_qty, image_url,
                            reorder_level, batch_no, expiry_date, manufacturer, strength, wholesale_price_cents,
                            variants_json, decimal_qty_enabled
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            int(data["category_id"]), data["name"], price_cents, cost_cents, data.get("color", "#334155"),
                            sku, barcode, unit, stock_qty, image_url, reorder_level, batch_no, expiry_date,
                            manufacturer, strength, wholesale_price_cents, variants_json, decimal_qty_enabled
                        ),
                    )
                CACHE.clear()
                self.send_json(self.menu_payload(conn, btype))
            elif path == "/api/admin/user":
                if not self.require_manager(user):
                    return
                username = data.get("username", "").strip()
                full_name = data.get("full_name", "").strip()
                role = data.get("role", "staff")
                active = int(data.get("active", 1))
                password = data.get("password", "").strip()
                if role not in ("staff", "cashier", "manager"):
                    return self.send_json({"error": "bad_role"}, 400)
                if not username or not full_name:
                    return self.send_json({"error": "missing_user_fields"}, 400)
                if data.get("id"):
                    user_id = int(data["id"])
                    if password:
                        conn.execute(
                            "UPDATE users SET username=?, full_name=?, role=?, active=?, password_hash=? WHERE id=?",
                            (username, full_name, role, active, hash_password(password), user_id),
                        )
                    else:
                        conn.execute(
                            "UPDATE users SET username=?, full_name=?, role=?, active=? WHERE id=?",
                            (username, full_name, role, active, user_id),
                        )
                else:
                    if not password:
                        password = "1234" if role == "staff" else "admin123"
                    conn.execute(
                        "INSERT INTO users(username, full_name, role, active, password_hash) VALUES (?, ?, ?, ?, ?)",
                        (username, full_name, role, active, hash_password(password)),
                    )
                self.send_json(rows(conn.execute(
                    "SELECT id, username, full_name, role, active FROM users ORDER BY role, full_name"
                )))
            elif path == "/api/purchase":
                supplier_id = int(data["supplier_id"])
                product_id = int(data["product_id"])
                qty = int(data["qty"])
                cost = int(data["cost_cents"])
                total = qty * cost
                conn.execute("UPDATE menu_items SET cost_cents = ?, stock_qty = stock_qty + ?, supplier_id = ? WHERE id = ?", (cost, qty, supplier_id, product_id))
                conn.execute(
                    "INSERT INTO stock_purchases (supplier_id, product_id, qty_received, cost_per_unit_cents, total_cost_cents, date_received, created_by, business_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    (supplier_id, product_id, qty, cost, total, now(), user["id"], btype)
                )
                conn.execute(
                    "INSERT INTO stock_movements (product_id, qty_change, reason, note, created_by, created_at, business_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (product_id, qty, 'purchase', f'Supplier {supplier_id}', user["id"], now(), btype)
                )
                self.send_json({"success": True})
            elif path == "/api/admin/supplier":
                name = data.get("name", "").strip()
                phone = data.get("phone", "").strip()
                email = data.get("email", "").strip()
                address = data.get("address", "").strip()
                active = int(data.get("active", 1))
                if not name:
                    return self.send_json({"error": "missing_supplier_name"}, 400)
                if data.get("id"):
                    conn.execute(
                        "UPDATE suppliers SET name=?, phone=?, email=?, address=?, active=? WHERE id=? AND business_type=?",
                        (name, phone, email, address, active, int(data["id"]), btype),
                    )
                else:
                    conn.execute(
                        "INSERT INTO suppliers(name, phone, email, address, active, business_type) VALUES (?, ?, ?, ?, ?, ?)",
                        (name, phone, email, address, active, btype),
                    )
                self.send_json(rows(conn.execute("SELECT * FROM suppliers WHERE business_type = ? ORDER BY name", (btype,))))
            elif path == "/api/admin/customer":
                name = data.get("name", "").strip()
                phone = data.get("phone", "").strip()
                email = data.get("email", "").strip()
                notes = data.get("notes", "").strip()
                if not name:
                    return self.send_json({"error": "missing_customer_name"}, 400)
                if data.get("id"):
                    conn.execute(
                        "UPDATE customers SET name=?, phone=?, email=?, notes=? WHERE id=? AND business_type=?",
                        (name, phone, email, notes, int(data["id"]), btype),
                    )
                else:
                    conn.execute(
                        "INSERT INTO customers(name, phone, email, notes, business_type) VALUES (?, ?, ?, ?, ?)",
                        (name, phone, email, notes, btype),
                    )
                self.send_json(rows(conn.execute("SELECT * FROM customers WHERE business_type = ? ORDER BY name", (btype,))))
            elif path == "/api/admin/sms/send":
                if not self.require_manager(user):
                    return
                message = str(data.get("message", "")).strip()
                if not message:
                    return self.send_json({"error": "Write an SMS message first"}, 400)
                if len(message) > 1000:
                    return self.send_json({"error": "SMS message is too long (maximum 1000 characters)"}, 400)

                raw_ids = data.get("customer_ids") or []
                if not isinstance(raw_ids, list):
                    return self.send_json({"error": "Select customers before sending SMS"}, 400)
                try:
                    customer_ids = sorted({int(value) for value in raw_ids if int(value) > 0})
                except (TypeError, ValueError):
                    return self.send_json({"error": "Invalid customer selection"}, 400)
                if not customer_ids:
                    return self.send_json({"error": "Select at least one customer first"}, 400)
                if len(customer_ids) > 200:
                    return self.send_json({"error": "Send to at most 200 customers at a time"}, 400)

                placeholders = ",".join("?" for _ in customer_ids)
                selected_customers = rows(conn.execute(
                    f"SELECT id, name, phone FROM customers WHERE business_type = ? AND id IN ({placeholders}) ORDER BY name",
                    [btype] + customer_ids,
                ))

                recipients = []
                seen = set()
                skipped = 0
                for customer in selected_customers:
                    digits = "".join(ch for ch in str(customer.get("phone") or "") if ch.isdigit())
                    if len(digits) == 10 and digits.startswith("0"):
                        digits = "254" + digits[1:]
                    elif len(digits) == 9 and digits[:1] in ("7", "1"):
                        digits = "254" + digits
                    phone = "+" + digits if 10 <= len(digits) <= 15 else ""
                    if not phone or phone in seen:
                        skipped += 1
                        continue
                    seen.add(phone)
                    recipients.append(phone)

                if not recipients:
                    return self.send_json({"error": "None of the selected customers has a valid phone number"}, 400)

                sms_cfg = sozuri_sms_config()
                try:
                    result = send_sozuri_sms(message, recipients)
                except Exception as exc:
                    error_text = str(exc).replace(sms_cfg.get("api_key", ""), "***")
                    return self.send_json({"error": error_text[:300] or "SMS send failed"}, 502)

                sms_data = result if isinstance(result, dict) else {}
                provider_recipients = sms_data.get("recipients", []) if isinstance(sms_data, dict) else []
                results = []
                sent = 0
                for item in provider_recipients:
                    status = str(item.get("status") or "")
                    status_code = item.get("statusCode")
                    if str(status_code) in ("11", "13", "14"):
                        sent += 1
                    results.append({
                        "number": item.get("to"),
                        "status": status or "Unknown",
                        "status_code": status_code,
                        "message_id": item.get("messageId") or item.get("message_id"),
                        "cost": item.get("cost"),
                    })

                self.send_json({
                    "ok": True,
                    "provider": "Sozuri",
                    "selected": len(customer_ids),
                    "matched": len(selected_customers),
                    "total": len(recipients),
                    "sent": sent,
                    "failed": max(0, len(recipients) - sent),
                    "skipped": skipped,
                    "message": sms_data.get("message") if isinstance(sms_data, dict) else "",
                    "results": results,
                })
            elif path == "/api/stock/adjust":
                if not self.require_manager(user):
                    return
                product_id = int(data["product_id"])
                qty_change = int(data["qty_change"])
                reason = data.get("reason", "adjustment")
                note = data.get("note", "")
                conn.execute(
                    "UPDATE menu_items SET stock_qty = stock_qty + ? WHERE id = ?",
                    (qty_change, product_id),
                )
                conn.execute(
                    "INSERT INTO stock_movements(product_id, qty_change, reason, note, created_by, created_at, business_type) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    (product_id, qty_change, reason, note, user["id"], now(), btype),
                )
                CACHE["menu"] = None
                self.send_json({"ok": True, "product_id": product_id, "qty_change": qty_change})
            else:
                self.send_json({"error": "not_found"}, 404)

    def menu_payload(self, conn, business_type=None):
        if not business_type:
            settings = get_settings(conn)
            business_type = settings.get("business_type")

        cache_key = f"menu_{business_type}"
        if CACHE.get(cache_key) and now() - CACHE.get(f"menu_ts_{business_type}", 0) < 15:
            return CACHE[cache_key]

        has_profile_cats = conn.execute(
            "SELECT COUNT(*) FROM categories WHERE business_type = ?", (business_type,)
        ).fetchone()[0]

        if has_profile_cats > 0:
            categories = rows(conn.execute(
                "SELECT * FROM categories WHERE business_type = ? OR business_type IS NULL OR business_type = 'all' ORDER BY sort_order, name",
                (business_type,)
            ))
            cat_ids = [c["id"] for c in categories]
            placeholders = ",".join("?" * len(cat_ids))
            items = rows(conn.execute(
                f"SELECT * FROM menu_items WHERE active = 1 AND category_id IN ({placeholders}) ORDER BY category_id, name",
                cat_ids,
            ))
        else:
            categories = rows(conn.execute("SELECT * FROM categories ORDER BY sort_order, name"))
            items = rows(conn.execute("SELECT * FROM menu_items WHERE active = 1 ORDER BY category_id, name"))

        payload = {"categories": categories, "items": items}
        CACHE[cache_key] = payload
        CACHE[f"menu_ts_{business_type}"] = now()
        return payload

    def tables_payload(self, conn, business_type=None):
        return rows(conn.execute(
            """
            SELECT t.*, o.id AS order_id, o.ticket_no, o.total_cents
            FROM dining_tables t
            LEFT JOIN orders o ON o.table_id = t.id AND o.status IN ('open', 'sent') AND (? IS NULL OR o.business_type = ?)
            WHERE t.active = 1 ORDER BY t.id
            """, (business_type, business_type)
        ))

    def employees_payload(self, conn):
        return rows(conn.execute(
            """
            SELECT MIN(id) AS id, full_name AS name
            FROM users
            WHERE role IN ('staff', 'cashier', 'manager') AND active = 1
            GROUP BY full_name
            ORDER BY full_name
            """
        ))

    def admin_summary(self, conn, business_type):
        day_start, day_end, _ = report_period_bounds("today")
        week_start, week_end, _ = report_period_bounds("week")
        totals = dict(conn.execute(
            """
            SELECT
              COUNT(CASE WHEN status = 'paid' AND COALESCE(paid_at, updated_at) >= ? THEN 1 END) AS paid_today,
              COALESCE(SUM(CASE WHEN status = 'paid' AND COALESCE(paid_at, updated_at) >= ? THEN total_cents END), 0) AS sales_today,
              COUNT(CASE WHEN status IN ('open','sent') THEN 1 END) AS unpaid_orders,
              COALESCE(SUM(CASE WHEN status IN ('open','sent') THEN total_cents END), 0) AS unpaid_total,
              COALESCE(SUM(CASE WHEN status = 'paid' AND COALESCE(paid_at, updated_at) >= ? THEN total_cents END), 0) AS sales_week
            FROM orders WHERE business_type = ?
            """,
            (day_start, day_start, week_start, business_type),
        ).fetchone())
        by_employee = rows(conn.execute(
            """
            SELECT u.full_name AS employee, COUNT(o.id) AS orders, COALESCE(SUM(o.total_cents), 0) AS sales
            FROM orders o JOIN users u ON u.id = o.created_by
            WHERE o.business_type = ? AND o.status = 'paid' AND COALESCE(o.paid_at, o.updated_at) >= ?
            GROUP BY u.id, u.full_name ORDER BY sales DESC LIMIT 8
            """, (business_type, week_start),
        ))
        by_method = rows(conn.execute(
            """
            SELECT COALESCE(payment_method, 'unknown') AS method, COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS sales
            FROM orders
            WHERE business_type = ? AND status = 'paid' AND COALESCE(paid_at, updated_at) >= ?
            GROUP BY payment_method ORDER BY sales DESC
            """, (business_type, week_start),
        ))
        top_items = rows(conn.execute(
            """
            SELECT oi.name, SUM(oi.qty) AS qty, SUM(oi.line_total_cents) AS sales
            FROM order_items oi JOIN orders o ON o.id = oi.order_id
            WHERE o.business_type = ? AND o.status = 'paid' AND COALESCE(o.paid_at, o.updated_at) >= ?
            GROUP BY oi.name ORDER BY sales DESC LIMIT 8
            """, (business_type, week_start),
        ))
        counts = dict(conn.execute(
            """
            SELECT
              (SELECT COUNT(*) FROM users WHERE active = 1 AND role NOT IN ('terminal')) AS active_users,
              (SELECT COUNT(*) FROM menu_items mi JOIN categories c ON c.id = mi.category_id WHERE mi.active = 1 AND c.business_type = ?) AS active_items,
              (SELECT COUNT(*) FROM suppliers WHERE active = 1 AND business_type = ?) AS active_suppliers
            """, (business_type, business_type)
        ).fetchone())
        sales_trend = rows(conn.execute(
            """
            SELECT strftime('%Y-%m-%d', COALESCE(paid_at, updated_at) + 10800, 'unixepoch') AS day, COALESCE(SUM(total_cents), 0) AS sales
            FROM orders
            WHERE business_type = ? AND status = 'paid' AND COALESCE(paid_at, updated_at) >= ?
            GROUP BY day ORDER BY day ASC
            """, (business_type, week_start)
        ))
        return {"totals": totals, "counts": counts, "by_employee": by_employee, "by_method": by_method, "top_items": top_items, "sales_trend": sales_trend, "business_type": business_type}

    do_DELETE = do_POST

if __name__ == "__main__":
    init_db()
    print(f"{STORE_NAME} Bar POS running at http://{HOST}:{PORT}")
    print("Staff PIN login: 1234 | Admin login: admin / admin123")

    class ReuseServer(ThreadingHTTPServer):
        allow_reuse_address = True

    ReuseServer((HOST, PORT), POSHandler).serve_forever()

