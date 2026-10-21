from pathlib import Path
import io
import json
import os
import re
import urllib.parse
import urllib.request
import uuid
from PIL import Image

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
UPLOAD_DIR = STATIC_DIR / "uploads"

# ── 1. CENTRALIZED BUSINESS PROFILES & CAPABILITIES MATRIX ────────────────────

PROFILES = {
    "retail": {
        "id": "retail",
        "name": "Retail / Mini-Mart",
        "tagline": "Supermarket, Grocery & General Retail POS",
        "icon": "🛒",
        "item_label": "Products",
        "order_type_default": "walk-in",
        "capabilities": {
            "barcode": True,
            "stock_tracking": True,
            "reorder_levels": True,
            "suppliers": True,
            "tables": False,
            "waiters": False,
            "kot": False,
            "batches_expiry": False,
            "decimal_qty": False,
            "units_extended": False,
            "quotations": True,
            "wholesale_pricing": False,
            "variants": False,
            "order_notes": False,
            "order_types": ["walk-in", "quote", "delivery"],
        },
    },
    "pharmacy": {
        "id": "pharmacy",
        "name": "Pharmacy",
        "tagline": "Pharmacy & Chemist POS",
        "icon": "💊",
        "item_label": "Medicines",
        "order_type_default": "walk-in",
        "capabilities": {
            "barcode": True,
            "stock_tracking": True,
            "reorder_levels": True,
            "suppliers": True,
            "tables": False,
            "waiters": False,
            "kot": False,
            "batches_expiry": True,
            "decimal_qty": False,
            "units_extended": False,
            "quotations": False,
            "wholesale_pricing": False,
            "variants": False,
            "order_notes": True,
            "order_types": ["walk-in", "prescription", "delivery"],
        },
    },
    "restaurant": {
        "id": "restaurant",
        "name": "Restaurant / Café",
        "tagline": "Food, Dining & Kitchen POS",
        "icon": "🍽️",
        "item_label": "Menu Items",
        "order_type_default": "dine-in",
        "capabilities": {
            "barcode": False,
            "stock_tracking": True,
            "reorder_levels": False,
            "suppliers": True,
            "tables": True,
            "waiters": True,
            "kot": True,
            "batches_expiry": False,
            "decimal_qty": False,
            "units_extended": False,
            "quotations": False,
            "wholesale_pricing": False,
            "variants": False,
            "order_notes": True,
            "order_types": ["dine-in", "takeaway", "delivery"],
        },
    },
    "hardware": {
        "id": "hardware",
        "name": "Hardware",
        "tagline": "Hardware, Building Materials & Tools POS",
        "icon": "🔧",
        "item_label": "Hardware Items",
        "order_type_default": "walk-in",
        "capabilities": {
            "barcode": True,
            "stock_tracking": True,
            "reorder_levels": True,
            "suppliers": True,
            "tables": False,
            "waiters": False,
            "kot": False,
            "batches_expiry": False,
            "decimal_qty": True,
            "units_extended": True,
            "quotations": True,
            "wholesale_pricing": True,
            "variants": False,
            "order_notes": True,
            "order_types": ["walk-in", "quote", "delivery"],
        },
    },
    "boutique": {
        "id": "boutique",
        "name": "Boutique / Cosmetics",
        "tagline": "Fashion, Beauty & Cosmetics POS",
        "icon": "👗",
        "item_label": "Apparel & Beauty",
        "order_type_default": "walk-in",
        "capabilities": {
            "barcode": True,
            "stock_tracking": True,
            "reorder_levels": True,
            "suppliers": True,
            "tables": False,
            "waiters": False,
            "kot": False,
            "batches_expiry": False,
            "decimal_qty": False,
            "units_extended": False,
            "quotations": False,
            "wholesale_pricing": False,
            "variants": True,
            "order_notes": False,
            "order_types": ["walk-in", "layaway", "delivery"],
        },
    },
    "bar": {
        "id": "bar",
        "name": "Bar / Nightclub",
        "tagline": "Bar, Lounge & Club POS",
        "icon": "🍸",
        "item_label": "Drinks & Snacks",
        "order_type_default": "dine-in",
        "capabilities": {
            "barcode": True,
            "stock_tracking": True,
            "reorder_levels": False,
            "suppliers": True,
            "tables": True,
            "waiters": True,
            "kot": True,
            "batches_expiry": False,
            "decimal_qty": False,
            "units_extended": False,
            "quotations": False,
            "wholesale_pricing": False,
            "variants": False,
            "order_notes": True,
            "order_types": ["dine-in", "bar-tab", "takeaway"],
        },
    },
    "garage": {'id': 'garage',
     'name': 'Garage & Auto Spares',
     'tagline': 'Auto Parts, Repairs & Workshop POS',
     'icon': '🚗',
     'item_label': 'Parts & Services',
     'order_type_default': 'walk-in',
     'capabilities': {'barcode': True,
                      'stock_tracking': True,
                      'reorder_levels': True,
                      'suppliers': True,
                      'tables': False,
                      'waiters': False,
                      'kot': False,
                      'batches_expiry': False,
                      'decimal_qty': False,
                      'units_extended': True,
                      'quotations': True,
                      'wholesale_pricing': False,
                      'variants': False,
                      'order_notes': True,
                      'order_types': ['walk-in', 'service', 'quote']}},
    "tech_accessories": {
        "id": "tech_accessories",
        "name": "Phone Accessories & Gadgets",
        "tagline": "Covers, Earphones, Chargers & Everyday Tech POS",
        "icon": "📱",
        "item_label": "Accessories & Gadgets",
        "order_type_default": "walk-in",
        "capabilities": {
            "barcode": True,
            "stock_tracking": True,
            "reorder_levels": True,
            "suppliers": True,
            "tables": False,
            "waiters": False,
            "kot": False,
            "batches_expiry": False,
            "decimal_qty": False,
            "units_extended": False,
            "quotations": False,
            "wholesale_pricing": True,
            "variants": True,
            "order_notes": True,
            "order_types": ["walk-in", "delivery", "wholesale"],
        },
    },
}

DEFAULT_SETTINGS = {
    "business_type": "bar",
    "business_name": "NIGHTCLUB",
    "business_tagline": "Bar & Club POS",
    "theme": "light",
    "phone": "0723056885",
    "email": "",
    "kra_pin": "",
    "address": "PJ CENTER-PARKLANDS",
    "logo_url": "",
    "receipt_header": "Welcome to our store",
    "receipt_footer": "Thank you for your visit!\nPowered by POS System\n------- END OF RECEIPT -------",
    "currency": "KES",
    "tax_rate": "0.0",
    "tax_rate_confirmed": "false",
}


def get_settings(conn):
    settings = dict(DEFAULT_SETTINGS)
    try:
        rows = conn.execute("SELECT key, value FROM business_settings").fetchall()
        for r in rows:
            settings[r["key"]] = r["value"]
    except Exception:
        pass
    # 16% was a pre-filled assumption, not a verified tax assessment.
    # On older shops, reset only the unconfirmed legacy default.
    try:
        assumed_legacy_rate = float(settings.get("tax_rate", 0)) == 16.0
    except (TypeError, ValueError):
        assumed_legacy_rate = False
    confirmed = str(settings.get("tax_rate_confirmed", "false")).lower() in ("1", "true", "yes")
    if assumed_legacy_rate and not confirmed:
        settings["tax_rate"] = "0.0"

    if settings.get("business_type") not in PROFILES:
        settings["business_type"] = "bar"
    return settings


def save_settings(conn, data):
    if "tax_rate" in data:
        # Only setting the VAT field explicitly can confirm a nonzero rate.
        data = {**data, "tax_rate_confirmed": "true"}
    for k, v in data.items():
        if k in DEFAULT_SETTINGS or k in ("business_type", "business_name", "business_tagline", "theme", "phone", "address", "logo_url", "receipt_header", "receipt_footer", "currency", "tax_rate"):
            conn.execute(
                "INSERT INTO business_settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (str(k), str(v)),
            )


# ── 2. IMAGE OPTIMIZATION & SEARCH ENGINE ─────────────────────────────────────

def optimize_and_save_image(image_bytes_or_url, target_dir="static/uploads", max_size=(600, 600), quality=85):
    os.makedirs(target_dir, exist_ok=True)
    raw_bytes = None

    if isinstance(image_bytes_or_url, str):
        s = image_bytes_or_url.strip()
        if s.startswith("http://") or s.startswith("https://"):
            req = urllib.request.Request(s, headers={"User-Agent": "Mozilla/5.0 POS/1.0"})
            with urllib.request.urlopen(req, timeout=10) as resp:
                raw_bytes = resp.read()
        elif "base64," in s:
            import base64
            b64_str = s.split("base64,", 1)[1]
            raw_bytes = base64.b64decode(b64_str)
        else:
            import base64
            try:
                raw_bytes = base64.b64decode(s)
            except Exception:
                return None
    elif isinstance(image_bytes_or_url, (bytes, bytearray)):
        raw_bytes = image_bytes_or_url

    if not raw_bytes:
        return None

    img = Image.open(io.BytesIO(raw_bytes))
    if img.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        if img.mode == "P":
            img = img.convert("RGBA")
        mask = img.split()[-1] if img.mode == "RGBA" else None
        bg.paste(img, mask=mask)
        img = bg
    elif img.mode != "RGB":
        img = img.convert("RGB")

    img.thumbnail(max_size, Image.Resampling.LANCZOS)
    filename = f"{uuid.uuid4().hex}.jpg"
    dest_path = os.path.join(target_dir, filename)
    img.save(dest_path, format="JPEG", quality=quality, optimize=True)
    return f"/{target_dir}/{filename}"


def build_search_terms(query):
    query = (query or "").strip()
    if not query:
        return []
    terms = [query]

    # 1. Clean out dosages, quantities, units, packaging
    cleaned = re.sub(
        r'\b\d+(\.\d+)?\s*(mg|ml|g|kg|l|s|m|cm|mm|oz|cl|tin|pkt|btl|bag|can|pie|plate|pcs|inch|\"|\')\b',
        '',
        query,
        flags=re.I,
    )
    cleaned = re.sub(r'\b\d+\b', '', cleaned)
    cleaned = re.sub(r'[-–—/()\[\],.]', ' ', cleaned)
    cleaned = re.sub(r'\s+', ' ', cleaned).strip()
    if cleaned and cleaned.lower() != query.lower() and cleaned not in terms:
        terms.append(cleaned)

    # 2. Extract significant words without common filler words
    stop_words = {'with', 'for', 'and', 'the', 'pcs', 'ltd', 'pack', 'bottle', 'box', 'inch', 'white'}
    words = [w for w in cleaned.split() if w.lower() not in stop_words and len(w) >= 3]

    # Last 2 words (e.g. 'Portland Cement', 'Wire Nails', 'Chiffon Dress', 'Beef Burger')
    if len(words) >= 2:
        last_two = ' '.join(words[-2:])
        if last_two not in terms:
            terms.append(last_two)

    # First 2 words (e.g. 'Cetirizine Tablets', 'Paracetamol Tablets')
    if len(words) >= 2:
        first_two = ' '.join(words[:2])
        if first_two not in terms:
            terms.append(first_two)

    # Last word (head noun e.g. 'Cement', 'Nails', 'Paint', 'Dress', 'Burger', 'Milk')
    if words and words[-1] not in terms:
        terms.append(words[-1])

    # First word
    if words and words[0] not in terms:
        terms.append(words[0])

    return terms


def search_product_images(query, limit=1):
    query = (query or "").strip()
    if not query:
        return []

    terms = build_search_terms(query)
    results = []
    seen = set()

    for term in terms:
        if len(results) >= limit:
            break

        # 1. Openverse API
        try:
            ov_url = f"https://api.openverse.org/v1/images/?q={urllib.parse.quote_plus(term)}&page_size=10"
            req = urllib.request.Request(ov_url, headers={"User-Agent": "POSSystem/1.0 (pos@store.local)"})
            with urllib.request.urlopen(req, timeout=4) as r:
                data = json.loads(r.read().decode("utf-8"))
                for item in data.get("results", []):
                    thumb = item.get("thumbnail") or item.get("url")
                    full = item.get("url") or thumb
                    title = item.get("title") or term
                    if thumb and thumb not in seen and not any(ext in full.lower() for ext in ('.svg', '.pdf', '.tif', '.tiff')):
                        seen.add(thumb)
                        results.append({
                            "thumb": thumb,
                            "full": full,
                            "thumbnail": thumb,
                            "url": full,
                            "title": title,
                            "source": "Openverse"
                        })
                        if len(results) >= limit:
                            break
        except Exception:
            pass

        # 2. Wikimedia Commons API
        if len(results) < limit:
            try:
                wiki_url = (
                    f"https://commons.wikimedia.org/w/api.php?action=query&generator=search"
                    f"&gsrsearch={urllib.parse.quote_plus(term)}&gsrnamespace=6&gsrlimit=10"
                    f"&prop=imageinfo&iiprop=url|thumburl&iiurlwidth=400&format=json"
                )
                req = urllib.request.Request(wiki_url, headers={"User-Agent": "POSSystem/1.0 (pos@store.local)"})
                with urllib.request.urlopen(req, timeout=4) as r:
                    data = json.loads(r.read().decode("utf-8"))
                    pages = data.get("query", {}).get("pages", {})
                    for pid, pinfo in pages.items():
                        ii = pinfo.get("imageinfo", [{}])[0]
                        t = ii.get("thumburl") or ii.get("url")
                        f = ii.get("url")
                        if t and f and not any(ext in f.lower() for ext in ('.svg', '.pdf', '.tif', '.tiff', '.ogg', '.ogv', '.webm')):
                            if t not in seen:
                                seen.add(t)
                                title = pinfo.get("title", "").replace("File:", "")
                                results.append({
                                    "thumb": t,
                                    "full": f,
                                    "thumbnail": t,
                                    "url": f,
                                    "title": title,
                                    "source": "Wikimedia"
                                })
                                if len(results) >= limit:
                                    break
            except Exception:
                pass

    # 3. Wikipedia fallback if under 4 results
    if len(results) < 4:
        for term in terms[:3]:
            try:
                wp_url = (
                    f"https://en.wikipedia.org/w/api.php?action=query&generator=search"
                    f"&gsrsearch={urllib.parse.quote_plus(term)}&gsrlimit=6"
                    f"&prop=pageimages&pithumbsize=500&format=json"
                )
                req = urllib.request.Request(wp_url, headers={"User-Agent": "POSSystem/1.0 (pos@store.local)"})
                with urllib.request.urlopen(req, timeout=4) as r:
                    data = json.loads(r.read().decode("utf-8"))
                    pages = data.get("query", {}).get("pages", {})
                    for pid, p in pages.items():
                        thumb = p.get("thumbnail", {}).get("source")
                        title = p.get("title", "")
                        if thumb and not thumb.lower().endswith(('.svg.png', '.pdf')) and thumb not in seen:
                            seen.add(thumb)
                            results.append({
                                "thumb": thumb,
                                "full": thumb,
                                "thumbnail": thumb,
                                "url": thumb,
                                "title": title,
                                "source": "Wikipedia"
                            })
                            if len(results) >= limit:
                                break
            except Exception:
                pass
            if len(results) >= 4:
                break

    return results[:limit]


# ── 3. SAMPLE PRODUCTS & CATEGORIES DATASET ───────────────────────────────────

SAMPLE_DATA = {
    "pharmacy": {
        "categories": [
            "Pain & Fever Relief",
            "Antibiotics & Prescriptions",
            "Cough, Cold & Flu",
            "Vitamins & Supplements",
            "First Aid & Antiseptics",
        ],
        "items": [
            {
                "category": "Pain & Fever Relief",
                "name": "Paracetamol 500mg Tablets",
                "price": 100,
                "cost": 60,
                "sku": "PHARM-001",
                "barcode": "616120100001",
                "stock": 80,
                "unit": "strip",
                "reorder_level": 15,
                "batch_no": "B4829",
                "expiry_date": "2027-11-30",
                "manufacturer": "Dawa Ltd",
                "strength": "500mg",
                "image_url": "/static/uploads/sample_paracetamol.jpg",
                "color": "#0e7490",
            },
            {
                "category": "Antibiotics & Prescriptions",
                "name": "Amoxicillin 500mg Capsules",
                "price": 350,
                "cost": 220,
                "sku": "PHARM-002",
                "barcode": "616120100002",
                "stock": 40,
                "unit": "strip",
                "reorder_level": 10,
                "batch_no": "AM912",
                "expiry_date": "2027-08-15",
                "manufacturer": "Cosmos Ltd",
                "strength": "500mg",
                "image_url": "/static/uploads/sample_amoxicillin.jpg",
                "color": "#0d9488",
            },
            {
                "category": "Cough, Cold & Flu",
                "name": "Cough Relief Syrup 100ml",
                "price": 280,
                "cost": 180,
                "sku": "PHARM-003",
                "barcode": "616120100003",
                "stock": 24,
                "unit": "btl",
                "reorder_level": 6,
                "batch_no": "CR104",
                "expiry_date": "2026-12-31",
                "manufacturer": "Regal Pharma",
                "strength": "100ml",
                "image_url": "/static/uploads/sample_cough_syrup.jpg",
                "color": "#b45309",
            },
            {
                "category": "Cough, Cold & Flu",
                "name": "Cetirizine 10mg Tablets",
                "price": 150,
                "cost": 90,
                "sku": "PHARM-004",
                "barcode": "616120100004",
                "stock": 50,
                "unit": "strip",
                "reorder_level": 10,
                "batch_no": "CT553",
                "expiry_date": "2027-05-20",
                "manufacturer": "GlaxoSmithKline",
                "strength": "10mg",
                "image_url": "/static/uploads/sample_cetirizine.jpg",
                "color": "#0284c7",
            },
            {
                "category": "Vitamins & Supplements",
                "name": "Multivitamin Effervescent 20s",
                "price": 650,
                "cost": 450,
                "sku": "PHARM-005",
                "barcode": "616120100005",
                "stock": 18,
                "unit": "tube",
                "reorder_level": 5,
                "batch_no": "MV771",
                "expiry_date": "2028-01-10",
                "manufacturer": "Bayer",
                "strength": "20 tabs",
                "image_url": "/static/uploads/sample_multivitamin.jpg",
                "color": "#d97706",
            },
            {
                "category": "First Aid & Antiseptics",
                "name": "Povidone Iodine 100ml",
                "price": 220,
                "cost": 140,
                "sku": "PHARM-006",
                "barcode": "616120100006",
                "stock": 30,
                "unit": "btl",
                "reorder_level": 8,
                "batch_no": "PI302",
                "expiry_date": "2027-04-01",
                "manufacturer": "Medilab",
                "strength": "10%",
                "image_url": "/static/uploads/sample_iodine.jpg",
                "color": "#9f1239",
            },
        ],
    },
    "hardware": {
        "categories": [
            "Cement & Building",
            "Fasteners & Fixings",
            "Paints & Finishes",
            "Plumbing",
            "Hand Tools",
            "Electrical",
        ],
        "items": [
            {
                "category": "Cement & Building",
                "name": "Simba Portland Cement 50kg",
                "price": 750,
                "wholesale_price": 680,
                "cost": 620,
                "sku": "HDW-001",
                "barcode": "616130100001",
                "stock": 120,
                "unit": "bag",
                "reorder_level": 25,
                "decimal_qty_enabled": 0,
                "image_url": "/static/uploads/sample_cement.jpg",
                "color": "#475569",
            },
            {
                "category": "Fasteners & Fixings",
                "name": "Steel Wire Nails 3-inch",
                "price": 180,
                "wholesale_price": 150,
                "cost": 120,
                "sku": "HDW-002",
                "barcode": "616130100002",
                "stock": 250,
                "unit": "kg",
                "reorder_level": 30,
                "decimal_qty_enabled": 1,
                "image_url": "/static/uploads/sample_nails.jpg",
                "color": "#64748b",
            },
            {
                "category": "Paints & Finishes",
                "name": "Crown Vinyl Gloss Paint White 4L",
                "price": 2400,
                "wholesale_price": 2100,
                "cost": 1800,
                "sku": "HDW-003",
                "barcode": "616130100003",
                "stock": 30,
                "unit": "tin",
                "reorder_level": 5,
                "decimal_qty_enabled": 0,
                "image_url": "/static/uploads/sample_paint.jpg",
                "color": "#ea580c",
            },
            {
                "category": "Plumbing",
                "name": "PPR Plumbing Pipe 1/2-inch",
                "price": 120,
                "wholesale_price": 95,
                "cost": 80,
                "sku": "HDW-004",
                "barcode": "616130100004",
                "stock": 300,
                "unit": "metre",
                "reorder_level": 50,
                "decimal_qty_enabled": 1,
                "image_url": "/static/uploads/sample_pipe.jpg",
                "color": "#10b981",
            },
            {
                "category": "Hand Tools",
                "name": "Heavy Duty Claw Hammer 16oz",
                "price": 850,
                "wholesale_price": 720,
                "cost": 550,
                "sku": "HDW-005",
                "barcode": "616130100005",
                "stock": 15,
                "unit": "pcs",
                "reorder_level": 4,
                "decimal_qty_enabled": 0,
                "image_url": "/static/uploads/sample_hammer.jpg",
                "color": "#1e293b",
            },
            {
                "category": "Electrical",
                "name": "Twin & Earth Electric Cable 2.5mm",
                "price": 160,
                "wholesale_price": 135,
                "cost": 110,
                "sku": "HDW-006",
                "barcode": "616130100006",
                "stock": 500,
                "unit": "metre",
                "reorder_level": 100,
                "decimal_qty_enabled": 1,
                "image_url": "/static/uploads/sample_cable.jpg",
                "color": "#dc2626",
            },
        ],
    },
    "boutique": {
        "categories": [
            "Women's Apparel",
            "Men's Wear",
            "Lip & Face Beauty",
            "Skincare",
            "Denim & Trousers",
        ],
        "items": [
            {
                "category": "Women's Apparel",
                "name": "Floral Summer Chiffon Dress",
                "price": 2800,
                "cost": 1600,
                "sku": "BTQ-001",
                "barcode": "616140100001",
                "stock": 24,
                "unit": "pcs",
                "reorder_level": 6,
                "image_url": "/static/uploads/sample_dress.jpg",
                "color": "#db2777",
                "variants_json": json.dumps([
                    {"name": "S / Sky Blue", "size": "S", "color": "Sky Blue", "shade": "", "stock": 6, "price_cents": 280000},
                    {"name": "M / Sky Blue", "size": "M", "color": "Sky Blue", "shade": "", "stock": 8, "price_cents": 280000},
                    {"name": "L / Sky Blue", "size": "L", "color": "Sky Blue", "shade": "", "stock": 4, "price_cents": 280000},
                    {"name": "M / Rose Pink", "size": "M", "color": "Rose Pink", "shade": "", "stock": 6, "price_cents": 280000},
                ]),
            },
            {
                "category": "Men's Wear",
                "name": "Men's Oxford Slim Fit Shirt",
                "price": 2200,
                "cost": 1300,
                "sku": "BTQ-002",
                "barcode": "616140100002",
                "stock": 30,
                "unit": "pcs",
                "reorder_level": 8,
                "image_url": "/static/uploads/sample_shirt.jpg",
                "color": "#2563eb",
                "variants_json": json.dumps([
                    {"name": "38 / White", "size": "38", "color": "White", "shade": "", "stock": 8, "price_cents": 220000},
                    {"name": "40 / White", "size": "40", "color": "White", "shade": "", "stock": 10, "price_cents": 220000},
                    {"name": "42 / Navy Blue", "size": "42", "color": "Navy Blue", "shade": "", "stock": 12, "price_cents": 220000},
                ]),
            },
            {
                "category": "Lip & Face Beauty",
                "name": "Velvet Matte Longstay Lipstick",
                "price": 850,
                "cost": 450,
                "sku": "BTQ-003",
                "barcode": "616140100003",
                "stock": 45,
                "unit": "pcs",
                "reorder_level": 12,
                "image_url": "/static/uploads/sample_lipstick.jpg",
                "color": "#be123c",
                "variants_json": json.dumps([
                    {"name": "Ruby Red #01", "size": "", "color": "Red", "shade": "Ruby Red", "stock": 15, "price_cents": 85000},
                    {"name": "Velvet Nude #05", "size": "", "color": "Nude", "shade": "Velvet Nude", "stock": 18, "price_cents": 85000},
                    {"name": "Plum Desire #09", "size": "", "color": "Purple", "shade": "Plum Desire", "stock": 12, "price_cents": 85000},
                ]),
            },
            {
                "category": "Skincare",
                "name": "Hydrating Glow Serum 50ml",
                "price": 1500,
                "cost": 900,
                "sku": "BTQ-004",
                "barcode": "616140100004",
                "stock": 20,
                "unit": "btl",
                "reorder_level": 5,
                "image_url": "/static/uploads/sample_serum.jpg",
                "color": "#f59e0b",
            },
            {
                "category": "Denim & Trousers",
                "name": "High-Waist Stretch Denim Jeans",
                "price": 2500,
                "cost": 1400,
                "sku": "BTQ-005",
                "barcode": "616140100005",
                "stock": 18,
                "unit": "pcs",
                "reorder_level": 5,
                "image_url": "/static/uploads/sample_jeans.jpg",
                "color": "#1e3a8a",
                "variants_json": json.dumps([
                    {"name": "Size 28 / Dark Wash", "size": "28", "color": "Dark Wash", "shade": "", "stock": 6, "price_cents": 250000},
                    {"name": "Size 30 / Dark Wash", "size": "30", "color": "Dark Wash", "shade": "", "stock": 7, "price_cents": 250000},
                    {"name": "Size 32 / Light Wash", "size": "32", "color": "Light Wash", "shade": "", "stock": 5, "price_cents": 250000},
                ]),
            },
        ],
    },
    "restaurant": {
        "categories": [
            "Burgers & Grills",
            "Main Courses",
            "Pizzas",
            "Pasta & Bowls",
            "Desserts",
            "Beverages",
        ],
        "items": [
            {
                "category": "Burgers & Grills",
                "name": "Classic Beef Burger with Fries",
                "price": 650,
                "cost": 320,
                "sku": "REST-001",
                "barcode": "",
                "stock": 100,
                "unit": "plate",
                "reorder_level": 0,
                "image_url": "/static/uploads/sample_burger.jpg",
                "color": "#b45309",
            },
            {
                "category": "Main Courses",
                "name": "Grilled Herb Chicken Breast",
                "price": 850,
                "cost": 420,
                "sku": "REST-002",
                "barcode": "",
                "stock": 80,
                "unit": "plate",
                "reorder_level": 0,
                "image_url": "/static/uploads/sample_chicken.jpg",
                "color": "#c2410c",
            },
            {
                "category": "Pizzas",
                "name": "Wood-Fired Margherita Pizza",
                "price": 900,
                "cost": 400,
                "sku": "REST-003",
                "barcode": "",
                "stock": 50,
                "unit": "pie",
                "reorder_level": 0,
                "image_url": "/static/uploads/sample_pizza.jpg",
                "color": "#dc2626",
            },
            {
                "category": "Pasta & Bowls",
                "name": "Creamy Chicken Alfredo Pasta",
                "price": 750,
                "cost": 350,
                "sku": "REST-004",
                "barcode": "",
                "stock": 60,
                "unit": "plate",
                "reorder_level": 0,
                "image_url": "/static/uploads/sample_pasta.jpg",
                "color": "#ca8a04",
            },
            {
                "category": "Desserts",
                "name": "Fresh Fruit Salad & Ice Cream",
                "price": 350,
                "cost": 150,
                "sku": "REST-005",
                "barcode": "",
                "stock": 40,
                "unit": "bowl",
                "reorder_level": 0,
                "image_url": "/static/uploads/sample_fruit.jpg",
                "color": "#10b981",
            },
            {
                "category": "Beverages",
                "name": "House Cappuccino Coffee",
                "price": 280,
                "cost": 80,
                "sku": "REST-006",
                "barcode": "",
                "stock": 200,
                "unit": "cup",
                "reorder_level": 0,
                "image_url": "/static/uploads/sample_coffee.jpg",
                "color": "#78350f",
            },
        ],
    },
    "retail": {
        "categories": [
            "Bakery & Bread",
            "Dairy & Milk",
            "Cooking Oils & Spices",
            "Sugar, Flour & Rice",
            "Cleaning & Household",
        ],
        "items": [
            {
                "category": "Bakery & Bread",
                "name": "Fresh Sliced White Bread 400g",
                "price": 65,
                "cost": 50,
                "sku": "RET-001",
                "barcode": "616110100001",
                "stock": 45,
                "unit": "loaf",
                "reorder_level": 10,
                "image_url": "/static/uploads/sample_bread.jpg",
                "color": "#d97706",
            },
            {
                "category": "Dairy & Milk",
                "name": "Fresh Whole Milk 500ml",
                "price": 60,
                "cost": 45,
                "sku": "RET-002",
                "barcode": "616110100002",
                "stock": 30,
                "unit": "pkt",
                "reorder_level": 8,
                "image_url": "/static/uploads/sample_milk.jpg",
                "color": "#0ea5e9",
            },
            {
                "category": "Cooking Oils & Spices",
                "name": "Pure Vegetable Cooking Oil 1L",
                "price": 290,
                "cost": 240,
                "sku": "RET-003",
                "barcode": "616110100003",
                "stock": 25,
                "unit": "btl",
                "reorder_level": 5,
                "image_url": "/static/uploads/sample_oil.jpg",
                "color": "#eab308",
            },
            {
                "category": "Sugar, Flour & Rice",
                "name": "White Sugar Refined 1kg",
                "price": 170,
                "cost": 140,
                "sku": "RET-004",
                "barcode": "616110100004",
                "stock": 50,
                "unit": "pkt",
                "reorder_level": 10,
                "image_url": "/static/uploads/sample_sugar.jpg",
                "color": "#64748b",
            },
            {
                "category": "Sugar, Flour & Rice",
                "name": "Pure Basmati Rice 2kg",
                "price": 450,
                "cost": 370,
                "sku": "RET-005",
                "barcode": "616110100005",
                "stock": 20,
                "unit": "bag",
                "reorder_level": 5,
                "image_url": "/static/uploads/sample_rice.jpg",
                "color": "#ca8a04",
            },
            {
                "category": "Cleaning & Household",
                "name": "Multi-Purpose Bar Soap 800g",
                "price": 160,
                "cost": 130,
                "sku": "RET-006",
                "barcode": "616110100006",
                "stock": 35,
                "unit": "bar",
                "reorder_level": 8,
                "image_url": "/static/uploads/sample_soap.jpg",
                "color": "#10b981",
            },
        ],
    },
    "garage": {'categories': ['Oils & Lubricants',
                    'Filters',
                    'Brakes & Suspension',
                    'Engine Parts',
                    'Batteries & Electrical',
                    'Tyres & Wheels',
                    'Workshop Services'],
     'items': [{'name': 'Engine Oil 5W-30 · 4L',
                'category': 'Oils & Lubricants',
                'price': 3500,
                'cost': 2600,
                'sku': 'GAR-001',
                'barcode': '2000000700014',
                'stock': 24,
                'stock_qty': 24,
                'unit': 'btl',
                'color': '#183d35',
                'reorder_level': 5,
                'image_url': '/static/uploads/garage_engine_oil.jpg'},
               {'name': 'Oil Filter',
                'category': 'Filters',
                'price': 850,
                'cost': 500,
                'sku': 'GAR-002',
                'barcode': '2000000700021',
                'stock': 40,
                'stock_qty': 40,
                'unit': 'pcs',
                'color': '#183d35',
                'reorder_level': 8,
                'image_url': '/static/uploads/garage_oil_filter.jpg'},
               {'name': 'Front Brake Pads Set',
                'category': 'Brakes & Suspension',
                'price': 2800,
                'cost': 1900,
                'sku': 'GAR-003',
                'barcode': '2000000700038',
                'stock': 18,
                'stock_qty': 18,
                'unit': 'set',
                'color': '#183d35',
                'reorder_level': 4,
                'image_url': '/static/uploads/garage_brake_pads.jpg'},
               {'name': 'Spark Plugs · Set of 4',
                'category': 'Engine Parts',
                'price': 1800,
                'cost': 1100,
                'sku': 'GAR-004',
                'barcode': '2000000700045',
                'stock': 32,
                'stock_qty': 32,
                'unit': 'set',
                'color': '#183d35',
                'reorder_level': 6,
                'image_url': '/static/uploads/garage_spark_plugs.jpg'},
               {'name': 'Car Battery · 12V 60Ah',
                'category': 'Batteries & Electrical',
                'price': 9500,
                'cost': 7300,
                'sku': 'GAR-005',
                'barcode': '2000000700052',
                'stock': 10,
                'stock_qty': 10,
                'unit': 'pcs',
                'color': '#183d35',
                'reorder_level': 3,
                'image_url': '/static/uploads/garage_car_battery.jpg'},
               {'name': 'Passenger Tyre · 195/65 R15',
                'category': 'Tyres & Wheels',
                'price': 6500,
                'cost': 4700,
                'sku': 'GAR-006',
                'barcode': '2000000700069',
                'stock': 16,
                'stock_qty': 16,
                'unit': 'pcs',
                'color': '#183d35',
                'reorder_level': 4,
                'image_url': '/static/uploads/garage_tyre.jpg'},
               {'name': 'Computer Diagnostics',
                'category': 'Workshop Services',
                'price': 1500,
                'cost': 0,
                'sku': 'GAR-007',
                'barcode': '',
                'stock': 0,
                'stock_qty': 0,
                'unit': 'service',
                'color': '#183d35',
                'reorder_level': 0,
                'image_url': '/static/uploads/garage_diagnostics.jpg'},
               {'name': 'Oil Change Labour',
                'category': 'Workshop Services',
                'price': 800,
                'cost': 0,
                'sku': 'GAR-008',
                'barcode': '',
                'stock': 0,
                'stock_qty': 0,
                'unit': 'service',
                'color': '#183d35',
                'reorder_level': 0,
                'image_url': '/static/uploads/garage_engine_oil.jpg'}]},
    "tech_accessories": {
        "categories": [
            "Earphones & Audio",
            "Phone Covers",
            "Chargers & Cables",
            "Power Banks",
            "Smart Watches",
            "Bluetooth Speakers",
        ],
        "items": [
            {
                "category": "Earphones & Audio",
                "name": "Wireless Earbuds Pro",
                "price": 2499,
                "cost": 1650,
                "sku": "TECH-001",
                "barcode": "2000000800011",
                "stock": 18,
                "unit": "pcs",
                "reorder_level": 5,
                "image_url": "/static/uploads/tech_wireless_earbuds.jpg",
                "color": "#16a34a",
            },
            {
                "category": "Phone Covers",
                "name": "Premium Phone Cover",
                "price": 799,
                "cost": 350,
                "sku": "TECH-002",
                "barcode": "2000000800028",
                "stock": 45,
                "unit": "pcs",
                "reorder_level": 10,
                "image_url": "/static/uploads/tech_phone_cases.jpg",
                "color": "#7c3aed",
                "variants_json": json.dumps([
                    {"name": "iPhone / Navy", "size": "iPhone", "color": "Navy", "shade": "", "stock": 12, "price_cents": 79900},
                    {"name": "Samsung / Clear", "size": "Samsung", "color": "Clear", "shade": "", "stock": 18, "price_cents": 79900},
                    {"name": "Tecno / Black", "size": "Tecno", "color": "Black", "shade": "", "stock": 15, "price_cents": 69900},
                ]),
            },
            {
                "category": "Chargers & Cables",
                "name": "20W Fast Charger + Type-C Cable",
                "price": 1299,
                "cost": 780,
                "sku": "TECH-003",
                "barcode": "2000000800035",
                "stock": 28,
                "unit": "set",
                "reorder_level": 7,
                "image_url": "/static/uploads/tech_charging_bundle.jpg",
                "color": "#2563eb",
            },
            {
                "category": "Power Banks",
                "name": "Slim Power Bank 10000mAh",
                "price": 1999,
                "cost": 1350,
                "sku": "TECH-004",
                "barcode": "2000000800042",
                "stock": 14,
                "unit": "pcs",
                "reorder_level": 4,
                "image_url": "/static/uploads/tech_charging_bundle.jpg",
                "color": "#334155",
            },
            {
                "category": "Smart Watches",
                "name": "Smart Watch Series Fit",
                "price": 2999,
                "cost": 1900,
                "sku": "TECH-005",
                "barcode": "2000000800059",
                "stock": 12,
                "unit": "pcs",
                "reorder_level": 3,
                "image_url": "",
                "color": "#0f766e",
            },
            {
                "category": "Bluetooth Speakers",
                "name": "Mini Bluetooth Speaker",
                "price": 2199,
                "cost": 1450,
                "sku": "TECH-006",
                "barcode": "2000000800066",
                "stock": 16,
                "unit": "pcs",
                "reorder_level": 4,
                "image_url": "",
                "color": "#ea580c",
            },
        ],
    },
}


def seed_sample_data(conn, profile_id=None):
    profiles_to_seed = [profile_id] if profile_id else list(SAMPLE_DATA.keys())

    for pid in profiles_to_seed:
        data = SAMPLE_DATA.get(pid)
        if not data:
            continue

        existing_cats = {
            r["name"].lower(): r["id"]
            for r in conn.execute("SELECT id, name FROM categories WHERE business_type = ?", (pid,)).fetchall()
        }

        cat_ids = dict(existing_cats)
        for i, cat_name in enumerate(data["categories"]):
            if cat_name.lower() not in cat_ids:
                cur = conn.execute(
                    "INSERT INTO categories(name, sort_order, business_type) VALUES (?, ?, ?)",
                    (cat_name, i, pid),
                )
                cat_ids[cat_name.lower()] = cur.lastrowid

        for it in data["items"]:
            cid = cat_ids.get(it["category"].lower())
            if not cid:
                continue
            exists = conn.execute(
                "SELECT id FROM menu_items WHERE category_id = ? AND name = ?",
                (cid, it["name"]),
            ).fetchone()
            if not exists:
                conn.execute(
                    """
                    INSERT INTO menu_items (
                        category_id, name, price_cents, cost_cents, color, active,
                        sku, barcode, stock_qty, unit, image_url,
                        reorder_level, batch_no, expiry_date, manufacturer, strength,
                        wholesale_price_cents, variants_json, decimal_qty_enabled
                    ) VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        cid,
                        it["name"],
                        int(it["price"] * 100),
                        int(it.get("cost", 0) * 100),
                        it.get("color", "#334155"),
                        it.get("sku", ""),
                        it.get("barcode", ""),
                        it.get("stock", 0),
                        it.get("unit", "pcs"),
                        it.get("image_url", ""),
                        it.get("reorder_level", 5),
                        it.get("batch_no", ""),
                        it.get("expiry_date", ""),
                        it.get("manufacturer", ""),
                        it.get("strength", ""),
                        int(it.get("wholesale_price", 0) * 100),
                        it.get("variants_json", ""),
                        it.get("decimal_qty_enabled", 0),
                    ),
                )

