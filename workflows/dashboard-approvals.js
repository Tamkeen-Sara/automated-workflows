export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  const approvals = await fastn.db.query(
    `SELECT approval_id, order_id, type, proposal, approved, created_at
     FROM approvals
     WHERE tenant_id = $1 AND approved = 'PENDING'
     ORDER BY created_at ASC`,
    [tenantId]
  );

  return { status: 200, count: approvals.length, approvals };
}