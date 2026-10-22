/**
 * Vercel Serverless Function: /api/orders
 * Provides live cloud order sync with Supabase PostgreSQL
 */
const pool = require('./db');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Oraforge-Shop, X-Oraforge-Etims');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // GET: Fetch orders from Supabase
  if (req.method === 'GET') {
    try {
      const url = new URL(req.url, 'http://localhost');
      const status = url.searchParams.get('status') || req.query?.status;
      const shopId = req.headers['x-oraforge-shop'] || url.searchParams.get('shop_id') || req.query?.shop_id || 'retail';
      const limit = Math.min(Number(url.searchParams.get('limit') || req.query?.limit || 200), 500);

      // Multi-shop flexibility: hardware shops include hardware, retail, and shop_eity_fit_hardware
      const shopCandidates = (shopId.includes('hardware') || shopId === 'retail')
        ? ['shop_eity_fit_hardware', 'hardware', 'retail']
        : [shopId];

      let query = `
        SELECT o.id, o.shop_id, o.ticket_no, o.order_type, o.customer_name,
               o.customer_kra_pin, o.customer_phone, o.customer_email,
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
                     'tax_code', i.tax_code
                   )
                 ) FILTER (WHERE i.id IS NOT NULL), '[]'
               ) AS items
        FROM pos.orders o
        LEFT JOIN pos.order_items i ON i.order_id = o.id
        WHERE o.shop_id = ANY($1)
      `;

      const params = [shopCandidates];
      if (status) {
        params.push(status);
        query += ` AND o.status = $${params.length}`;
      }

      query += ` GROUP BY o.id ORDER BY o.created_at DESC LIMIT $${params.length + 1}`;
      params.push(limit);

      const result = await pool.query(query, params);

      // Format output for frontend compatibility
      const orders = result.rows.map(row => {
        const createdMs = row.created_at ? new Date(row.created_at).getTime() : Date.now();
        const updatedMs = row.updated_at ? new Date(row.updated_at).getTime() : createdMs;
        const createdEpoch = Math.floor(createdMs / 1000);
        const updatedEpoch = Math.floor(updatedMs / 1000);

        return {
          id: Number(row.id),
          ticket_no: row.ticket_no,
          shop_id: row.shop_id,
          order_type: row.order_type || 'walk-in',
          customer_name: row.customer_name || 'Walk-In Customer',
          customer_kra_pin: row.customer_kra_pin || '',
          customer_phone: row.customer_phone || '',
          customer_email: row.customer_email || '',
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
          created_at: createdEpoch,
          updated_at: updatedEpoch,
          paid_at: updatedEpoch,
          created_iso: row.created_at,
          updated_iso: row.updated_at,
          items: Array.isArray(row.items) ? row.items : []
        };
      });

      return res.status(200).json(orders);
    } catch (err) {
      console.error('Error fetching orders from Supabase:', err);
      return res.status(500).json({ error: 'Failed to query orders from database', details: err.message });
    }
  }

  // POST: Record / sync an order to Supabase
  if (req.method === 'POST') {
    try {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (_) {}
      }

      const shopId = req.headers['x-oraforge-shop'] || body.shop_id || 'shop_eity_fit_hardware';
      const ticketNo = body.ticket_no;
      if (!ticketNo) return res.status(400).json({ error: 'ticket_no is required' });

      // Check if ticket already exists
      const existing = await pool.query('SELECT id FROM pos.orders WHERE ticket_no = $1', [ticketNo]);
      let orderId;

      const subtotalCents = Number(body.subtotal_cents || body.total_cents || 0);
      const taxCents = Number(body.tax_cents || 0);
      const totalCents = Number(body.total_cents || 0);
      const paidCents = Number(body.paid_cents || totalCents);

      if (existing.rows.length > 0) {
        orderId = existing.rows[0].id;
        await pool.query(`
          UPDATE pos.orders
          SET status = $1, payment_method = $2, payment_ref = $3,
              total_cents = $4, paid_cents = $5, updated_at = NOW()
          WHERE id = $6
        `, [body.status || 'paid', body.payment_method || 'cash', body.payment_ref || 'CASH', totalCents, paidCents, orderId]);
      } else {
        const maxRes = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM pos.orders');
        orderId = maxRes.rows[0].next_id;

        await pool.query(`
          INSERT INTO pos.orders (
            id, shop_id, ticket_no, order_type, customer_name, customer_kra_pin,
            status, subtotal_cents, tax_cents, total_cents, paid_cents,
            payment_method, payment_ref, employee_name, created_at, updated_at
          ) VALUES (
            $1, $2, $3, $4, $5, $6,
            $7, $8, $9, $10, $11,
            $12, $13, $14, NOW(), NOW()
          )
        `, [
          orderId, shopId, ticketNo, body.order_type || 'walk-in',
          body.customer_name || 'Walk-In Customer', body.customer_kra_pin || '',
          body.status || 'paid', subtotalCents, taxCents, totalCents, paidCents,
          body.payment_method || 'cash', body.payment_ref || 'CASH',
          body.employee_name || 'POS Terminal'
        ]);

        // Insert items
        if (Array.isArray(body.items)) {
          for (const it of body.items) {
            const maxItemRes = await pool.query('SELECT COALESCE(MAX(id), 0) + 1 AS next_item_id FROM pos.order_items');
            const itemId = maxItemRes.rows[0].next_item_id;

            await pool.query(`
              INSERT INTO pos.order_items (
                id, order_id, menu_item_id, name, qty,
                unit_price_cents, line_total_cents, tax_code
              ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            `, [
              itemId, orderId, it.menu_item_id ? Number(it.menu_item_id) : null,
              it.name, it.qty || 1, it.unit_price_cents || 0,
              it.line_total_cents || 0, it.tax_code || 'D'
            ]);
          }
        }
      }

      return res.status(200).json({ ok: true, id: orderId, ticket_no: ticketNo });
    } catch (err) {
      console.error('Error saving order to Supabase:', err);
      return res.status(500).json({ error: 'Failed to save order to database', details: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
};
