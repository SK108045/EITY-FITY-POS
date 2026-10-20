const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

let sqliteModule = null;
try {
  sqliteModule = require("node:sqlite");
} catch (_) {}

const BACKUP_DIR = path.resolve(process.env.POS_BACKUP_DIR || path.join(__dirname, "../backups"));
const day = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

function validate(data) {
  if (
    !data ||
    data.format !== "oraforge-pos-backup" ||
    data.version !== 1 ||
    !Array.isArray(data.records) ||
    !data.records.length ||
    !data.preferences ||
    typeof data.preferences !== "object" ||
    Array.isArray(data.preferences)
  )
    throw Error("Invalid backup format");
  const keys = new Set();
  for (const row of data.records) {
    if (
      !Array.isArray(row) ||
      row.length !== 2 ||
      typeof row[0] !== "string" ||
      !/^(shop:|oraforge:)/.test(row[0]) ||
      keys.has(row[0])
    )
      throw Error("Invalid backup records");
    keys.add(row[0]);
  }
}

function getSqliteTargets() {
  const targets = new Set();
  const rootDir = process.env.POS_ROOT_DIR;
  if (rootDir) {
    targets.add(path.resolve(rootDir, "pos.sqlite3"));
    targets.add(path.resolve(rootDir, "data", "pos.sqlite3"));
  }
  // Packaged build: __dirname is dist/windows/OraforgePOS/app/capacitor -> resolve to OraforgePOS root
  targets.add(path.resolve(__dirname, "../../pos.sqlite3"));
  targets.add(path.resolve(__dirname, "../../data/pos.sqlite3"));
  // Source repo: __dirname is capacitor -> resolve to repo root
  targets.add(path.resolve(__dirname, "../data/pos.sqlite3"));
  targets.add(path.resolve(__dirname, "../pos.sqlite3"));
  if (process.env.POS_DATA_DIR) {
    targets.add(path.resolve(process.env.POS_DATA_DIR, "pos.sqlite3"));
    targets.add(path.resolve(process.env.POS_DATA_DIR, "data", "pos.sqlite3"));
  }
  return [...targets];
}

function extractShopData(records) {
  const map = new Map(records);
  let prefix = null;
  for (const k of map.keys()) {
    if (k.includes("shop_eity_fit_hardware")) {
      prefix = "shop:shop_eity_fit_hardware:";
      break;
    }
  }
  if (!prefix) {
    for (const k of map.keys()) {
      const m = k.match(/^(shop:[^:]+:)/);
      if (m) {
        prefix = m[1];
        break;
      }
    }
  }
  if (!prefix) return null;

  return {
    categories: map.get(prefix + "categories") || [],
    items: map.get(prefix + "items") || [],
    suppliers: map.get(prefix + "suppliers") || [],
    orders: map.get(prefix + "orders") || [],
    users: map.get(prefix + "users") || [],
    settings: map.get(prefix + "settings") || null,
  };
}

function syncSqlite(data) {
  if (!sqliteModule || !sqliteModule.DatabaseSync) return;
  const shopData = extractShopData(data.records);
  if (!shopData) return;

  const targets = getSqliteTargets();

  for (const dbPath of targets) {
    try {
      const dir = path.dirname(dbPath);
      if (!fsSync.existsSync(dir)) {
        try { fsSync.mkdirSync(dir, { recursive: true }); } catch (_) { continue; }
      }

      const db = new sqliteModule.DatabaseSync(dbPath);
      db.exec(`
        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          sort_order INTEGER DEFAULT 0,
          business_type TEXT DEFAULT 'retail'
        );
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
        );
        CREATE TABLE IF NOT EXISTS suppliers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          phone TEXT,
          email TEXT,
          address TEXT,
          active INTEGER DEFAULT 1
        );
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
        );
        CREATE TABLE IF NOT EXISTS order_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          order_id INTEGER,
          menu_item_id INTEGER,
          name TEXT,
          qty REAL,
          unit_price_cents INTEGER,
          line_total_cents INTEGER,
          note TEXT
        );
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          full_name TEXT NOT NULL,
          role TEXT NOT NULL DEFAULT 'cashier',
          password_hash TEXT NOT NULL,
          active INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS business_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);

      db.exec("BEGIN TRANSACTION");
      try {
        if (Array.isArray(shopData.categories) && shopData.categories.length > 0) {
          db.exec("DELETE FROM categories");
          const stmt = db.prepare("INSERT INTO categories (id, name, sort_order, business_type) VALUES (?, ?, ?, ?)");
          shopData.categories.forEach((c, idx) => {
            const name = typeof c === "string" ? c : (c.name || "General");
            const id = typeof c === "object" && c.id ? Number(c.id) : idx + 1;
            const sort = typeof c === "object" && c.sort_order !== undefined ? Number(c.sort_order) : idx;
            const btype = typeof c === "object" && c.business_type ? c.business_type : "hardware";
            stmt.run(id, name, sort, btype);
          });
        }

        if (Array.isArray(shopData.items) && shopData.items.length > 0) {
          db.exec("DELETE FROM menu_items");
          const stmt = db.prepare("INSERT INTO menu_items (id, category_id, name, price_cents, cost_cents, stock_qty, sku, barcode, unit, color, active, reorder_level) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
          shopData.items.forEach((it, idx) => {
            const id = Number(it.id || idx + 1);
            const catId = Number(it.category_id || 1);
            const name = String(it.name || "").trim();
            const priceCents = it.price_cents !== undefined ? Number(it.price_cents) : Math.round(Number(it.price || 0) * 100);
            const costCents = it.cost_cents !== undefined ? Number(it.cost_cents) : Math.round(Number(it.cost || 0) * 100);
            const stockQty = it.stock_qty !== undefined ? Number(it.stock_qty) : Number(it.stock || 0);
            const sku = String(it.sku || (id ? `BM-${String(id).padStart(5, "0")}` : ""));
            const barcode = it.barcode ? String(it.barcode) : null;
            const unit = String(it.unit || "pcs");
            const color = String(it.color || "#334155");
            const active = it.active !== undefined ? (it.active ? 1 : 0) : 1;
            const reorder = Number(it.reorder_level || 5);
            stmt.run(id, catId, name, priceCents, costCents, stockQty, sku, barcode, unit, color, active, reorder);
          });
        }

        if (Array.isArray(shopData.suppliers) && shopData.suppliers.length > 0) {
          db.exec("DELETE FROM suppliers");
          const stmt = db.prepare("INSERT INTO suppliers (id, name, phone, email, address, active) VALUES (?, ?, ?, ?, ?, ?)");
          shopData.suppliers.forEach((s, idx) => {
            const id = Number(s.id || idx + 1);
            const name = String(s.name || "");
            const phone = String(s.phone || "");
            const email = String(s.email || "");
            const address = String(s.address || "");
            const active = s.active !== undefined ? (s.active ? 1 : 0) : 1;
            stmt.run(id, name, phone, email, address, active);
          });
        }

        if (Array.isArray(shopData.orders) && shopData.orders.length > 0) {
          db.exec("DELETE FROM order_items");
          db.exec("DELETE FROM orders");
          const stmtOrder = db.prepare("INSERT INTO orders (id, ticket_no, order_type, customer_name, status, subtotal_cents, tax_cents, total_cents, paid_cents, payment_method, payment_ref, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
          const stmtItem = db.prepare("INSERT INTO order_items (id, order_id, menu_item_id, name, qty, unit_price_cents, line_total_cents, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");

          shopData.orders.forEach((o, idx) => {
            const orderId = Number(o.id || idx + 1);
            stmtOrder.run(
              orderId,
              String(o.ticket_no || ""),
              String(o.order_type || "walk-in"),
              String(o.customer_name || "Walk-In Customer"),
              String(o.status || "paid"),
              Number(o.subtotal_cents || 0),
              Number(o.tax_cents || 0),
              Number(o.total_cents || 0),
              Number(o.paid_cents || 0),
              String(o.payment_method || "cash"),
              String(o.payment_ref || ""),
              Number(o.created_by || 1),
              String(o.created_at || ""),
              String(o.updated_at || o.created_at || "")
            );
            if (Array.isArray(o.items)) {
              o.items.forEach(it => {
                stmtItem.run(
                  it.id ? Number(it.id) : null,
                  orderId,
                  it.menu_item_id ? Number(it.menu_item_id) : (it.id ? Number(it.id) : null),
                  String(it.name || ""),
                  Number(it.qty || 1),
                  Number(it.unit_price_cents || it.price_cents || (Number(it.price || 0) * 100) || 0),
                  Number(it.line_total_cents || (Number(it.qty || 1) * Number(it.unit_price_cents || 0))),
                  String(it.note || "")
                );
              });
            }
          });
        }

        if (Array.isArray(shopData.users) && shopData.users.length > 0) {
          db.exec("DELETE FROM users");
          const stmt = db.prepare("INSERT INTO users (id, username, full_name, role, password_hash, active) VALUES (?, ?, ?, ?, ?, ?)");
          shopData.users.forEach((u, idx) => {
            stmt.run(
              Number(u.id || idx + 1),
              String(u.username || ""),
              String(u.full_name || ""),
              String(u.role || "cashier"),
              String(u.password_hash || ""),
              u.active !== undefined ? (u.active ? 1 : 0) : 1
            );
          });
        }

        if (shopData.settings && typeof shopData.settings === "object") {
          const stmt = db.prepare("INSERT OR REPLACE INTO business_settings (key, value) VALUES (?, ?)");
          for (const [k, v] of Object.entries(shopData.settings)) {
            stmt.run(k, typeof v === "object" ? JSON.stringify(v) : String(v));
          }
        }

        db.exec("COMMIT");
      } catch (innerErr) {
        db.exec("ROLLBACK");
        throw innerErr;
      } finally {
        db.close();
      }
    } catch (err) {
      console.warn(`[Backup] SQLite sync notice on ${dbPath}:`, err.message);
    }
  }
}

function createStore(directory = BACKUP_DIR, clock = () => new Date()) {
  let pending = Promise.resolve();
  async function latest() {
    try {
      const data = JSON.parse(await fs.readFile(path.join(directory, "latest.json"), "utf8"));
      validate(data);
      return data;
    } catch (err) {
      if (err.code === "ENOENT" || err instanceof SyntaxError || err.message.startsWith("Invalid backup")) return null;
      throw err;
    }
  }
  async function status() {
    const data = await latest();
    return {
      due: !data || clock().getTime() - Date.parse(data.created_at) >= 60000,
      last_backup: data?.created_at || null,
      folder: "backups",
      file: data ? "latest.json" : null,
    };
  }
  async function atomicWrite(name, contents) {
    const file = path.join(directory, name),
      temp = file + ".tmp";
    try {
      await fs.writeFile(temp, contents, { mode: 0o600 });
      await fs.rename(temp, file);
    } finally {
      await fs.unlink(temp).catch(() => {});
    }
  }
  function save(data) {
    const job = pending.then(async () => {
      validate(data);
      const previous = await latest(),
        now = clock();
      const same =
        previous &&
        JSON.stringify(previous.records) === JSON.stringify(data.records) &&
        JSON.stringify(previous.preferences) === JSON.stringify(data.preferences);

      let needsSqliteSync = !same;
      if (!needsSqliteSync) {
        for (const target of getSqliteTargets()) {
          if (!fsSync.existsSync(target)) {
            needsSqliteSync = true;
            break;
          }
        }
      }

      if (needsSqliteSync) {
        try {
          syncSqlite(data);
        } catch (err) {
          console.warn("[Backup] SQLite sync warning:", err.message);
        }
      }

      if (same && day(new Date(previous.created_at)) === day(now)) return status();

      await fs.mkdir(directory, { recursive: true });
      const contents = JSON.stringify({ ...data, created_at: now.toISOString() });
      const stamp = now.toISOString().replace(/[:.]/g, "-");
      await atomicWrite(`auto-${stamp}.json`, contents);
      await atomicWrite(`daily-${day(now)}.json`, contents);
      await atomicWrite("latest.json", contents);
      const versions = (await fs.readdir(directory)).filter((n) => /^auto-\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(n)).sort();
      await Promise.all(versions.slice(0, -60).map((n) => fs.unlink(path.join(directory, n))));
      return status();
    });
    pending = job.catch(() => {});
    return job;
  }
  return { status, save };
}

const store = createStore();
async function handle(req, res) {
  const send = (code, data) => {
    res.writeHead(code, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    res.end(JSON.stringify(data));
  };
  const remote = req.socket.remoteAddress;
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote))
    return send(403, { error: "PC local access only" });
  if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
    return send(403, { error: "Same-origin access required" });
  try {
    if (req.method === "GET") return send(200, await store.status());
    if (req.method !== "POST") return send(405, { error: "Method not allowed" });
    if (!String(req.headers["content-type"]).startsWith("application/json"))
      return send(415, { error: "JSON required" });
    let size = 0,
      chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 100 * 1024 * 1024) return send(413, { error: "Backup exceeds 100 MB" });
      chunks.push(chunk);
    }
    let data;
    try {
      data = JSON.parse(Buffer.concat(chunks).toString());
      validate(data);
    } catch (err) {
      return send(400, { error: err.message });
    }
    return send(200, await store.save(data));
  } catch (err) {
    console.error("[Backup]", err.message);
    send(500, {
      error: "Could not save automatic backup. Check project folder permissions and free disk space.",
    });
  }
}

module.exports = { handle, createStore, day, syncSqlite };
