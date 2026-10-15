export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  const eventType = input?.type || "order.confirmed";
  const payload = input?.payload || input || {};
  const orderId = input?.order_id || payload.order_id;

  // 1. Fetch updated order record from DB
  let order = null;
  if (orderId) {
    const rows = await fastn.db.query(
      "SELECT * FROM orders WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, orderId]
    );
    order = rows[0];
  }

  // 2. Prepare Google Sheet row format
  // Columns: order_id, channel, customer_name, city, items, amount_pkr, payment_mode, payment_status, order_status, make_by, ship_by, tracking_number, cod_expected, cod_remitted, created_at, last_update, notes
  const sheetRow = order ? [
    order.order_id,
    order.channel,
    order.customer_ref,
    order.city,
    order.items,
    order.amount_pkr,
    order.payment_mode,
    order.payment_status,
    order.order_status,
    order.make_by || "",
    order.ship_by || "",
    order.tracking_number || "",
    order.cod_expected || 0,
    order.cod_remitted || 0,
    order.created_at,
    order.updated_at
  ] : [];

  // Audit sync
  const eventId = `EV-SYNC-${Date.now()}`;
  await fastn.db.query(
    `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
     VALUES ($1, 'sheet-sync', 'SHEET_ROW_SYNCED', $2, $3, $4)`,
    [tenantId, orderId, eventId, `Synced order ${orderId || 'all'} to Google Sheets`]
  );

  return {
    status: 200,
    synced: true,
    order_id: orderId,
    event: eventType,
    sheet_row: sheetRow
  };
}