export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";
  const statusFilter = input?.status;

  let query = "SELECT order_id, channel, customer_ref, city, items, amount_pkr, payment_mode, payment_status, order_status, make_by, ship_by, tracking_number, cod_expected, cod_remitted, created_at, updated_at FROM orders WHERE tenant_id = $1";
  const params = [tenantId];

  if (statusFilter) {
    query += " AND order_status = $2";
    params.push(statusFilter.toUpperCase());
  }

  query += " ORDER BY created_at DESC LIMIT 50";

  const orders = await fastn.db.query(query, params);
  return { status: 200, count: orders.length, orders };
}