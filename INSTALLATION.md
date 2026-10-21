# Oraforge eTIMS POS — Setup, Deployment & Machine Transfer Guide

Here is the complete, straightforward breakdown for transferring to a new machine and clearing out old test data.

---

### 1. Does the Companion Need Any Installation BS?
**NO.** Absolutely none.
- **No Node.js install needed**: Node is already bundled inside `runtime\node.exe`.
- **No Python or pip needed**: The signing engine is already compiled into `runtime\etims\OraforgeEtims\OraforgeEtims.exe`.
- **No `npm install` needed**: All database drivers (`node_modules`) are pre-bundled.
- **No terminal or CLI commands**: It is 100% plug-and-play. Double-clicking `Start-Cloud-Agent.cmd` does everything.

---

### 2. What Does the New Machine Actually Need?

Only two things:
1. **The Official KRA eTIMS Client**:
   - In Kenya, any machine that signs official tax invoices must have the official KRA eTIMS software installed with your registered PIN (`A018733640V`) at `C:\eTIMS-Paypoint-Win` (or official KRA OSCU / VSCU).
2. **A Web Browser (Chrome or Edge)**:
   - To open the POS at **`https://eity-fity-pos.vercel.app/pos`**.

---

### 3. Step-by-Step: How to Transfer to a New Machine

#### Step 1: Copy the Companion Folder
Copy your `C:\Oraforge-eTIMS-Companion` folder (via flash drive, zip, or network) onto the new computer at:
`C:\Oraforge-eTIMS-Companion`

*(We have pre-configured `Start-Cloud-Agent.cmd` to automatically copy your configuration, taxpayer PIN, and verified UNSPSC defaults to the new computer on first launch).*

#### Step 2: Start the Companion
Open `C:\Oraforge-eTIMS-Companion` and double-click:
👉 **`Start-Cloud-Agent.cmd`**

You will see:
```text
[Local Helper] ✓ ONLINE on port 17383
============================================================
  🟢 WATCHING SUPABASE QUEUE (pos.etims_queue)
  Sales made on Vercel will sign automatically in real-time!
============================================================
```
*(Tip: Create a desktop shortcut for `Start-Cloud-Agent.cmd` so the cashier can start it when turning on the PC).*

#### Step 3: Open the POS in the Browser
Open Chrome/Edge and go to:
👉 **`https://eity-fity-pos.vercel.app/pos`**

Log in, and the cashier is ready to make sales immediately!

---

### 4. How to Clear Old Test Data (Clean Slate)

When you are ready to hand over the system with zero test sales, here is how to clean it:

#### A. Clear Old Test Sales in Supabase (Keep Catalog & Settings)
In your Supabase SQL Editor, run this single query:
```sql
TRUNCATE TABLE pos.order_items, pos.orders, pos.etims_queue CASCADE;
```
- **What this clears**: All test receipts, test tickets, and test queue history.
- **What this preserves**: All your products, prices, categories, suppliers, and store settings remain 100% untouched.

#### B. Clear Cashier Browser Cache (On the New or Old Machine)
On the browser at `https://eity-fity-pos.vercel.app/pos`:
1. Press `F12` (or right-click → **Inspect**).
2. Go to the **Application** tab → click **Storage** on the left menu.
3. Click **"Clear site data"**.
*(Or simply open an Incognito window or press `Ctrl + Shift + R`).*

#### C. If Wiping the Old Machine
If you want to remove all traces of local invoices from the old machine before giving it away:
1. Delete the companion folder: `C:\Oraforge-eTIMS-Companion`
2. Delete the local cache folder: `%LOCALAPPDATA%\OraforgePOS`
