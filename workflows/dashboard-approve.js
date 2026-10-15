export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  const approvalId = input?.approval_id;
  const decision = (input?.decision || "YES").toUpperCase();
  const editedProposal = input?.edited_proposal;

  if (!approvalId) {
    return { status: 400, error: "approval_id is required" };
  }

  // 1. Fetch approval
  const appRows = await fastn.db.query(
    "SELECT approval_id, order_id, type, proposal FROM approvals WHERE tenant_id = $1 AND approval_id = $2",
    [tenantId, approvalId]
  );
  if (appRows.length === 0) {
    return { status: 404, error: "Approval not found" };
  }

  const app = appRows[0];
  const finalProposal = editedProposal || app.proposal;

  // 2. Update approval
  await fastn.db.query(
    `UPDATE approvals
     SET approved = $1, proposal = $2, decided_at = NOW()
     WHERE tenant_id = $3 AND approval_id = $4`,
    [decision, finalProposal, tenantId, approvalId]
  );

  // 3. Emit event if YES
  let emittedEvent = null;
  if (decision === "YES") {
    if (app.type === "REPLY") emittedEvent = "reply.approved";
    else if (app.type === "BOOKING") emittedEvent = "booking.approved";
  }

  const eventId = `EV-DASH-DEC-${Date.now()}`;
  if (emittedEvent) {
    await fastn.db.query(
      `INSERT INTO events (id, tenant_id, type, order_id, payload, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())`,
      [eventId, tenantId, emittedEvent, app.order_id, JSON.stringify({ approval_id: approvalId, order_id: app.order_id, proposal: finalProposal })]
    );
  }

  await fastn.db.query(
    `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
     VALUES ($1, 'dashboard_seller', 'APPROVAL_DECISION', $2, $3, $4)`,
    [tenantId, app.order_id, eventId, `Seller marked ${approvalId} as ${decision}`]
  );

  return {
    status: 200,
    approval_id: approvalId,
    decision,
    event: emittedEvent
  };
}