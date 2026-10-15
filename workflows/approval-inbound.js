export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  const approvalId = input?.approval_id || "APP-REPLY-01";
  const decision = (input?.decision || "YES").toUpperCase();

  // 1. Fetch approval row
  const appRows = await fastn.db.query(
    "SELECT approval_id, order_id, type, proposal, approved FROM approvals WHERE tenant_id = $1 AND approval_id = $2",
    [tenantId, approvalId]
  );

  if (appRows.length === 0) {
    return { status: 404, error: "Approval not found" };
  }

  const app = appRows[0];

  // 2. Update approval
  await fastn.db.query(
    "UPDATE approvals SET approved = $1, decided_at = NOW() WHERE tenant_id = $2 AND approval_id = $3",
    [decision, tenantId, approvalId]
  );

  // 3. Emit downstream event if YES
  let emittedEvent = null;
  if (decision === "YES") {
    if (app.type === "REPLY") {
      emittedEvent = "reply.approved";
    } else if (app.type === "BOOKING") {
      emittedEvent = "booking.approved";
    }
  }

  const eventId = `EV-DEC-${Date.now()}`;
  if (emittedEvent) {
    await fastn.db.query(
      `INSERT INTO events (id, tenant_id, type, order_id, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [eventId, tenantId, emittedEvent, app.order_id, JSON.stringify({ approval_id: approvalId, order_id: app.order_id, proposal: app.proposal })]
    );
  }

  // 4. Audit
  await fastn.db.query(
    `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
     VALUES ($1, 'seller', 'APPROVAL_DECISION', $2, $3, $4)`,
    [tenantId, app.order_id, eventId, `Seller marked approval ${approvalId} as ${decision}`]
  );

  return {
    status: 200,
    approval_id: approvalId,
    decision,
    event: emittedEvent
  };
}