export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  // 1. Fetch claims
  const claims = await fastn.db.query(
    `SELECT id, order_id, tid_token, amount, wallet, recipient_last4, status, reason, created_at
     FROM payment_claims
     WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT 50`,
    [tenantId]
  );

  // 2. Compute COD totals
  const totalsRes = await fastn.db.query(
    `SELECT
       COALESCE(SUM(cod_expected), 0) as total_expected,
       COALESCE(SUM(cod_remitted), 0) as total_remitted,
       COALESCE(SUM(CASE WHEN order_status = 'DELIVERED' THEN amount_pkr ELSE 0 END), 0) as cash_held_by_courier,
       COALESCE(SUM(CASE WHEN order_status = 'RETURNED' THEN amount_pkr ELSE 0 END), 0) as total_returned
     FROM orders
     WHERE tenant_id = $1`,
    [tenantId]
  );

  const codTotals = totalsRes[0] || {
    total_expected: "0",
    total_remitted: "0",
    cash_held_by_courier: "0",
    total_returned: "0"
  };

  return {
    status: 200,
    claims,
    cod: {
      expected: parseFloat(codTotals.total_expected),
      remitted: parseFloat(codTotals.total_remitted),
      held_by_courier: parseFloat(codTotals.cash_held_by_courier),
      returned: parseFloat(codTotals.total_returned)
    }
  };
}