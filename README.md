# EITY-FITY POS — Universal Multi-Shop Cloud POS & KRA eTIMS System

A high-performance, modern Point of Sale (POS) and inventory management system designed for Kenyan businesses. Features **universal multi-profile support** (Hardware, Retail, Pharmacy, Restaurant, Boutique, Nightclub), native **KRA eTIMS compliance** (sub-second fiscal signing & QR generation), and a **$0/month serverless cloud architecture** powered by **Vercel** and **Supabase**.

[![Live POS](https://img.shields.io/badge/Live%20POS-eity--fity--pos.vercel.app-000000?style=for-the-badge&logo=vercel)](https://eity-fity-pos.vercel.app/pos)
[![Database](https://img.shields.io/badge/Database-Supabase%20Postgres-3ECF8E?style=for-the-badge&logo=supabase)](https://supabase.com)
[![KRA eTIMS](https://img.shields.io/badge/KRA%20eTIMS-Ready-red?style=for-the-badge)](https://kra.go.ke)
[![Cost](https://img.shields.io/badge/Cost-%240%2Fmonth-brightgreen?style=for-the-badge)](#architecture)

---

## 🚀 Live Demo & Portals

- **POS Terminal**: [`https://eity-fity-pos.vercel.app/pos`](https://eity-fity-pos.vercel.app/pos)
- **Admin Dashboard**: [`https://eity-fity-pos.vercel.app/admin`](https://eity-fity-pos.vercel.app/admin)
- **Cashier Portal**: [`https://eity-fity-pos.vercel.app/cashier`](https://eity-fity-pos.vercel.app/cashier)

**Default Credentials:**
- Staff PIN: `1234`
- Admin Username: `admin` | Password: `admin123`

---

## 🏗️ Architecture ($0/Month Cloud + Local Fiscal Signing)

Traditional eTIMS deployments require expensive static cloud servers or dedicated AWS EC2 instances. This system runs 100% free serverless by pairing **Vercel** (frontend & serverless APIs) with **Supabase** (PostgreSQL & job queue) and a **Local Cashier Companion** running on the shop counter.

```
       [ Cashier Web Browser ]
         https://eity-fity-pos.vercel.app/pos
                   │
                   ▼ (1. Sale Created)
       [ Supabase Cloud Database ]
         Schema: pos
         Tables: orders, order_items, etims_queue
                   ▲
                   │ (2. Queue Polling & Sync in < 1s)
                   ▼
     [ Local Shop Windows Companion ]
       Folder: C:\Oraforge-eTIMS-Companion\
       ├── Start-Cloud-Agent.cmd
       ├── etims-supabase-worker.js  (Watches pos.etims_queue)
       └── runtime\etims\OraforgeEtims.exe (Port 17383)
                   │
                   ▼ (3. Sign Fiscal Invoice)
     [ Official KRA eTIMS Client ]
       C:\eTIMS-Paypoint-Win
       └── SQLite / RRA_EBM2x.db.RraSdc (Crypto Device Keys)
                   │
                   ▼ (4. Return Fiscal Data: CU Number + QR Code)
       [ Supabase Order Updated ] ──► [ Receipt Auto-Refreshes with KRA QR ]
```

---

## 🏢 6 Universal Business Profiles

Switch instantly between 6 specialized retail profiles from the top navigation or Admin Settings:

1. **🔨 Hardware & Building Supplies**:
   - Decimal quantities (e.g. 2.5 kg cement, 3.5 m timber, 1.25 L paint).
   - Wholesale vs. Retail pricing tiers.
   - Built-in universal UNSPSC hardware tax classification mapping (`60102300` / `OU` / `NO`).
2. **🛒 Retail & Mini-Mart**:
   - Fast barcode scanning (USB guns and live camera scanner with audio chime).
   - Low-stock and reorder level alerts.
   - Supplier receiving and supplier accounts.
3. **💊 Pharmacy**:
   - Batch number tracking, expiry countdowns & alerts.
   - Drug strength and dosage notes.
4. **🍽️ Restaurant & Café**:
   - Table and bar tab management.
   - Waiter assignment & Kitchen Order Ticket (KOT) printing.
5. **👗 Boutique & Apparel**:
   - Multi-variant matrix (Sizes, Colors, Styles) with stock-level pickers.
6. **🍸 Bar & Nightclub**:
   - Open tabs, bottle service, server flows, and quick-tap nightlife receipts.

---

## 🖨️ KRA eTIMS Integration & Companion Agent

The POS connects seamlessly to Kenya Revenue Authority's eTIMS system to produce certified tax receipts complete with:
- **KRA CU Invoice Number** (e.g. `KRACU0100544492/76`)
- **SCU ID** and device signature
- **Scannable KRA QR Code** embedded directly onto POS receipts
- **Zero Cashier Friction**: Automatic fallback classification so cashiers never encounter manual eTIMS UNSPSC code dialogs during checkout.

### Is the Companion Portable to a New PC?
**YES. 100% Portable with Zero Dependencies.**
- **No Node.js Install**: Node is pre-bundled in `runtime\node.exe`.
- **No Python or Pip**: The signing engine is pre-compiled into `runtime\etims\OraforgeEtims\OraforgeEtims.exe`.
- **No Database Setup**: PostgreSQL drivers (`pg`) are pre-installed in `node_modules`.
- **Dynamic User Paths**: Automatically adapts to `%LOCALAPPDATA%` on any Windows user account.
- **Dynamic PIN Auto-Detection**: Reads the seller's registered taxpayer PIN, branch ID, and keys directly from the local KRA software (`RRA_EBM2x.db.RraSdc`). Never hardcodes or leaks private PINs.

**To Run on Any Cashier PC:**
1. Install official KRA client at `C:\eTIMS-Paypoint-Win`.
2. Copy `C:\Oraforge-eTIMS-Companion\` to the PC.
3. Double-click `Start-Cloud-Agent.cmd`.
4. Open `https://eity-fity-pos.vercel.app/pos` in Chrome or Edge.

---

## 🔄 SQLite to Supabase Cloud Migration Tool

If migrating from an existing offline installation or legacy `pos.sqlite3` database to the Supabase cloud:

### 1-Click Migration with Auto-Deduplication
Run the bundled migration script:
👉 **`Transfer-Data-To-Cloud.cmd`** (or drag-and-drop `pos.sqlite3` onto it).

### What the Migration Tool Does:
- **Intelligent Catalog Deduplication**: Detects duplicate products imported multiple times, keeps the canonical item, merges stock quantities, and automatically re-links historical `order_items` so sales history remains 100% accurate.
- **Migrates All Tables**:
  - `categories` (7 categories)
  - `suppliers` (all vendor accounts)
  - `menu_items` (clean catalog)
  - `orders` (historical receipts)
  - `order_items` (line-by-line ticket items)
  - `business_settings` (store branding & settings)
- **ID Sequence Synchronization**: Resets PostgreSQL identity sequences (`id_seq`) so new sales made in the cloud never conflict.

---

## 📁 Repository Structure

```text
.
├── api/                           # Vercel Serverless Functions
│   └── etims/
│       ├── health.js              # Real-time worker heartbeat monitor
│       ├── jobs.js                # Queue ingestion API
│       └── jobs/[id].js           # Job status & fiscal receipt lookup
├── capacitor/
│   ├── etims-supabase-worker.js   # Supabase cloud queue watcher
│   └── www/                       # Frontend application bundle
│       ├── index.html             # Main POS layout
│       ├── app.js                 # Cart, catalog, checkout & barcode engine
│       ├── admin.js               # Admin portal, inventory & analytics
│       ├── etims-core.js          # eTIMS signing client & progress bar
│       ├── etims-integration.css  # Animated signing shimmer UI
│       └── styles.css             # Light & Dark monochrome design
├── dist/
│   └── Oraforge-eTIMS-Companion/  # Distributable Windows companion package
│       ├── Start-Cloud-Agent.cmd  # 1-Click cashier launcher
│       ├── Transfer-Data-To-Cloud.cmd # SQLite to Supabase migration tool
│       ├── migrate-sqlite-to-supabase.js # Fast cloud data migration engine
│       └── config/                # Portable configuration templates
├── windows/
│   └── etims-helper/              # Python & C# local fiscal helper source
│       ├── server.py              # Authenticated loopback server (port 17383)
│       ├── engine.py              # Job state machine & Ghost overlay session
│       ├── store.py               # Self-healing SQLite store
│       └── fast_engine/           # High-speed native invoice generator
├── INSTALLATION.md                # Cashier setup & new machine transfer guide
├── vercel.json                    # Vercel routing & serverless build config
└── package.json                   # Root package configuration
```

---

## 🛠️ Local Development & Self-Hosting

### 1. Clone the Repository
```bash
git clone git@github.com:SK108045/EITY-FITY-POS.git
cd EITY-FITY-POS
```

### 2. Environment Variables
Create a `.env` file (or set in Vercel / Supabase settings):
```env
DATABASE_URL=postgresql://postgres:[PASSWORD]@[HOST]:[PORT]/postgres
POS_SHOP_ID=retail
ORAFORGE_ETIMS_PORT=17383
```

### 3. Run Locally with Node.js
```bash
node capacitor/etims-supabase-worker.js
```

### 4. Deploy to Vercel
```bash
vercel --prod
```

---

## 📄 License

MIT License. Open for personal, commercial, and enterprise point of sale deployments.
