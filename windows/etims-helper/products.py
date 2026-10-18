"""Read-only registration planning, stable mappings and native-import workbooks."""
from collections import defaultdict
import csv
from decimal import Decimal
from pathlib import Path
import sys
from contracts import decimal, digest, product_key
from settings import ASSETS

FIELD_MAP = {'class_code':'ITEM_CLS_CD', 'item_type':'ITEM_TY_CD', 'origin':'ORGN_NAT_CD',
             'package_unit':'PKG_UNIT_CD', 'quantity_unit':'QTY_UNIT_CD', 'tax_code':'TAX_TY_CD'}
CODE_CLASSES = {'item_type':'24', 'origin':'05', 'package_unit':'17', 'quantity_unit':'10', 'tax_code':'04'}

def plan(sale, supplied, state, store, config):
    items = state['items']
    by_code = {i['ITEM_CD']: i for i in items}
    code_lists = {field: {c['CD'] for c in state['codes'] if c['CD_CLS']==group}
                  for field, group in CODE_CLASSES.items()}
    classes = {c['ITEM_CLS_CD'] for c in state['classes']}
    resolved, missing, adjustments, requirements, mappings = {}, {}, {}, [], {}
    quantities = defaultdict(Decimal)
    for item in sale['items']:
        quantities[item['product_key']] += decimal(item['quantity'], 'quantity', True)
    seen = set()
    for item in sale['items']:
        pos_key = item['product_key']
        if pos_key in seen:
            continue
        seen.add(pos_key)
        key = product_key(sale, item, config['taxpayer_pin'], config['branch_id'])
        previous = store.mapping(key)
        meta = {**(previous['metadata'] if previous else {}), **item.get('registration', {}), **supplied.get(pos_key, {})}
        # Per-sale inventory must come from this sale or an explicit current confirmation.
        for field in ('inventory_before_sale','inventory_confirmed','stock_reason'):
            meta.pop(field, None)
        meta.update(item.get('inventory', {}))
        meta.update({k:v for k,v in supplied.get(pos_key, {}).items() if k in ('inventory_before_sale','inventory_confirmed','stock_reason')})
        if previous:
            cand = by_code.get(previous['code'])
            # Verify that the mapped eTIMS code actually belongs to this exact product name.
            # If eTIMS was reinstalled or database rebuilt, codes may have shifted; fallback to matching by name.
            if cand and cand['ITEM_NM'].strip().casefold() == item['name'].strip().casefold():
                candidates = [cand]
                explicit = previous['code']
            else:
                explicit = None
                candidates = [i for i in items if i['ITEM_NM'].strip().casefold() == item['name'].strip().casefold()]
        elif meta.get('existing_code'):
            explicit = meta['existing_code']
            candidates = [by_code[explicit]] if explicit in by_code else []
            if not candidates:
                requirements.append(dict(product_key=pos_key,name=item['name'],missing=['existing_code'],message='Selected existing eTIMS code is not active'))
                continue
        else:
            explicit = None
            candidates = [i for i in items if i['ITEM_NM'].strip().casefold() == item['name'].strip().casefold()]
        if len(candidates) > 1:
            requirements.append(dict(product_key=pos_key,name=item['name'],missing=['existing_code'],message='Choose the correct existing eTIMS product',candidates=[{'code':i['ITEM_CD'],'name':i['ITEM_NM']} for i in candidates]))
            continue
        existing = candidates[0] if candidates else None
        if existing and existing.get('USE_YN','Y')!='Y':
            raise ValueError('The mapped eTIMS product is inactive; restore it through the official product workflow before invoicing')
        if item.get('expiry_date') or meta.get('expiry_date') or (existing and existing.get('EXPIRATION_YN')=='Y'):
            raise ValueError('Expiry-controlled products require a verified native batch/expiry workflow; no product or invoice was written')
        needed = []
        if existing:
            if existing['TAX_TY_CD'] not in ('B', 'D'):
                raise ValueError('Registered product tax differs from supported tax profiles (B or D)')
            # Authoritative synchronization: adapt POS metadata to match the active eTIMS registered product
            for field, column in FIELD_MAP.items():
                meta[field] = str(existing[column])
            code = existing['ITEM_CD']
            meta['verified'] = True
        else:
            # Device defaults are used only for new products. Existing native
            # origins remain authoritative and are never rewritten.
            meta={**config.get('registration_defaults',{}),**meta}
            for field in FIELD_MAP:
                if not meta.get(field):
                    needed.append(field)
            if meta.get('verified') is not True:
                needed.append('verified')
            for field, choices in code_lists.items():
                if meta.get(field) and str(meta[field]) not in choices:
                    raise ValueError('Registration code is not active in the installed eTIMS code tables: ' + field)
            if meta.get('class_code') and meta['class_code'] not in classes:
                raise ValueError('Item classification is not active in the installed eTIMS client')
            if meta.get('tax_code') and meta['tax_code'] not in ('B', 'D'):
                raise ValueError('This profile requires tax category B (VAT 16%) or D (Non-VAT)')
            if 'unit_cost_cents' not in meta:
                needed.append('unit_cost_cents')
            elif isinstance(meta['unit_cost_cents'], bool) or not isinstance(meta['unit_cost_cents'], int) or meta['unit_cost_cents'] < 0:
                raise ValueError('Provide actual purchase cost in integer cents')
            code = explicit or ''
            if not needed and not code:
                prefix = f"{meta['origin']}-{meta['item_type']}{meta['package_unit']}X{meta['quantity_unit']}X-"
                serial = int(key[:12], 16) % 9_999_999 + 1
                code = prefix + f'{serial:07d}'
                if code in by_code:
                    raise ValueError('Generated product code collision; select the correct existing product')
        service = meta.get('item_type') == '3'
        current = decimal(existing['RSD_QTY'], 'registered stock') if existing else Decimal(0)
        if not service and (not existing or current < quantities[pos_key]):
            if meta.get('inventory_before_sale') is None:
                needed.append('inventory_before_sale')
            if meta.get('inventory_confirmed') is not True:
                needed.append('inventory_confirmed')
            if meta.get('inventory_before_sale') is not None:
                actual = decimal(meta['inventory_before_sale'], 'actual inventory before this sale')
                if actual < quantities[pos_key]:
                    raise ValueError('Actual inventory is below this sale quantity; correct the POS stock or sale')
                if existing:
                    if len(str(meta.get('stock_reason', '')).strip()) < 10:
                        needed.append('stock_reason')
                    else:
                        adjustments[code] = dict(before=str(current), after=str(actual),
                                                 quantity=str(actual-current),reason=meta['stock_reason'])
        if needed:
            requirements.append(dict(product_key=pos_key,name=item['name'],missing=sorted(set(needed)),values=meta,
                                     registered_code=existing['ITEM_CD'] if existing else None,
                                     message='Confirm the actual product registration and inventory details'))
            continue
        resolved[pos_key] = code
        mappings[key] = dict(code=code,metadata={k:v for k,v in meta.items() if k not in ('inventory_before_sale','inventory_confirmed','stock_reason')})
        if not existing:
            missing[code] = dict(item=item,metadata=meta,quantity='0' if service else str(decimal(meta['inventory_before_sale'],'actual inventory')))
    totals=defaultdict(Decimal)
    for pos_key,code in resolved.items():totals[code]+=quantities[pos_key]
    for code,quantity in totals.items():
        existing=by_code.get(code)
        if existing and existing['ITEM_TY_CD']!='3' and code not in adjustments and decimal(existing['RSD_QTY'],'stock')<quantity:
            raise ValueError('Multiple POS products map to one eTIMS item with insufficient combined stock; reconcile that mapping first')
        if code in adjustments and decimal(adjustments[code]['after'],'confirmed stock')<quantity:
            raise ValueError('Confirmed stock is insufficient for combined lines mapped to the same eTIMS product')
    return dict(codes=resolved,missing=missing,adjustments=adjustments,requirements=requirements,mappings=mappings)

def workbook(registrations, directory, branch):
    sys.path.insert(0, str(ASSETS / 'product_import'))
    from convert import FIELDS, NUMBER_FIELDS, convert
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    source, output = directory/'products.csv', directory/'products.xlsx'
    rows = []
    for code, registration in registrations.items():
        item, meta = registration['item'], registration['metadata']
        row = {f:('0' if f in NUMBER_FIELDS else '') for f in FIELDS}
        row.update(ItemCd=code,ItemNm=item['name'],ItemClsCd=meta['class_code'],ItemTyCd=meta['item_type'],
                   OrgnNatCd=meta['origin'],PkgUnitCd=meta['package_unit'],QtyUnitCd=meta['quantity_unit'],
                   TaxTyCd=meta['tax_code'],RegBhfId=branch,UseYn='Y',RraModYn='N',IsrcAplcbYn='N',
                   DftPrc=str(Decimal(item['unit_price_cents'])/100),
                   InitlWhUntpc=str(Decimal(meta['unit_cost_cents'])/100),InitlQty=registration['quantity'],
                   UseBarcode='N',UseAdiYn='N',UseExpiration='N',Rm='Registered through Oraforge POS native eTIMS import')
        rows.append(row)
    with source.open('x',encoding='utf-8-sig',newline='') as stream:
        writer=csv.DictWriter(stream,fieldnames=FIELDS);writer.writeheader();writer.writerows(rows)
    convert(source,output)
    return output
