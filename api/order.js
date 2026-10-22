/**
 * Vercel Serverless Function: /api/order
 * Fetches a single order by ID or ticket_no from Supabase
 */
const pool = require('./db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Oraforge-Shop');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const url = new URL(req.url, 'http://localhost');
    const id = url.searchParams.get('id') || req.query?.id;
    const ticketNo = url.searchParams.get('ticket_no') || req.query?.ticket_no;

    if (!id && !ticketNo) {
      return res.status(400).json({ error: 'id or ticket_no query parameter is required' });
    }

    let query = `
      SELECT o.id, o.shop_id, o.ticket_no, o.order_type, o.customer_name,
             o.customer_kra_pin, o.customer_phone, o.customer_email,
             o.customer_billing_address, o.customer_remarks,
             o.status, o.subtotal_cents, o.tax_cents, o.total_cents, o.paid_cents,
             o.payment_method, o.payment_ref, o.employee_name,
             o.etims_requested, o.etims_status, o.cu_invoice_number, o.scu_id,
             o.receipt_signature, o.qr_image, o.invoice_number, o.invoice_date,
             o.created_at, o.updated_at,
             COALESCE(
               json_agg(
                 json_build_object(
                   'id', i.id,
                   'menu_item_id', i.menu_item_id,
                   'name', i.name,
                   'qty', i.qty,
                   'unit_price_cents', i.unit_price_cents,
                   'line_total_cents', i.line_total_cents,
                   'tax_code', i.tax_code,
                   'variant_info', i.variant_info,
                   'note', i.note
                 )
               ) FILTER (WHERE i.id IS NOT NULL), '[]'
             ) AS items
      FROM pos.orders o
      LEFT JOIN pos.order_items i ON i.order_id = o.id
    `;

    const params = [];
    if (id) {
      params.push(Number(id));
      query += ` WHERE o.id = $1`;
    } else {
      params.push(ticketNo);
      query += ` WHERE o.ticket_no = $1`;
    }

    query += ` GROUP BY o.id LIMIT 1`;

    const result = await pool.query(query, params);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const row = result.rows[0];
    const createdMs = row.created_at ? new Date(row.created_at).getTime() : Date.now();
    const updatedMs = row.updated_at ? new Date(row.updated_at).getTime() : createdMs;

    const order = {
      id: Number(row.id),
      ticket_no: row.ticket_no,
      shop_id: row.shop_id,
      order_type: row.order_type || 'walk-in',
      customer_name: row.customer_name || 'Walk-In Customer',
      customer_kra_pin: row.customer_kra_pin || '',
      customer_phone: row.customer_phone || '',
      customer_email: row.customer_email || '',
      customer_billing_address: row.customer_billing_address || '',
      customer_remarks: row.customer_remarks || '',
      status: row.status,
      subtotal_cents: Number(row.subtotal_cents || row.total_cents || 0),
      tax_cents: Number(row.tax_cents || 0),
      total_cents: Number(row.total_cents || 0),
      paid_cents: Number(row.paid_cents || row.total_cents || 0),
      payment_method: row.payment_method || 'cash',
      payment_ref: row.payment_ref || '',
      employee_name: row.employee_name || 'POS Terminal',
      etims_requested: Boolean(row.etims_requested),
      cu_invoice_number: row.cu_invoice_number || '',
      qr_image: row.qr_image || '',
      scu_id: row.scu_id || '',
      receipt_signature: row.receipt_signature || '',
      invoice_number: row.invoice_number || '',
      invoice_date: row.invoice_date || '',
      created_at: Math.floor(createdMs / 1000),
      updated_at: Math.floor(updatedMs / 1000),
      paid_at: Math.floor(updatedMs / 1000),
      created_iso: row.created_at,
      updated_iso: row.updated_at,
      items: Array.isArray(row.items) ? row.items : []
    };

    return res.status(200).json(order);
  } catch (err) {
    console.error('Error fetching order from Supabase:', err);
    return res.status(500).json({ error: 'Failed to query order', details: err.message });
  }
};
