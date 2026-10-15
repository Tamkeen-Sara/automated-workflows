export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  const eventType = input?.type || "order.ready";
  const payload = input?.payload || input || {};
  const orderId = input?.order_id || payload.order_id || "ORD-TEST-01";

  // Branch 1: order.ready -> propose booking
  if (eventType === "order.ready") {
    const orderRows = await fastn.db.query(
      "SELECT order_id, customer_ref, city, items, amount_pkr, cod_expected FROM orders WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, orderId]
    );
    const order = orderRows[0] || { order_id: orderId, city: "Lahore", items: "Kurti", cod_expected: 2500 };

    const proposalText = `Book PostEx courier for ${order.order_id}. Destination: ${order.city}. Items: ${order.items}. COD: PKR ${order.cod_expected || order.amount_pkr || 2500}.`;
    const approvalId = `APP-BOOKING-${Date.now()}`;

    await fastn.db.query(
      `INSERT INTO approvals (approval_id, order_id, type, proposal, approved, created_at, tenant_id)
       VALUES ($1, $2, 'BOOKING', $3, 'PENDING', NOW(), $4)`,
      [approvalId, orderId, proposalText, tenantId]
    );

    await fastn.db.query(
      "UPDATE orders SET order_status = 'BOOKING_PROPOSED', updated_at = NOW() WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, orderId]
    );

    await fastn.db.query(
      `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
       VALUES ($1, 'dispatcher', 'BOOKING_PROPOSED', $2, $3, $4)`,
      [tenantId, orderId, approvalId, "Proposed PostEx booking for seller approval"]
    );

    return {
      status: 200,
      order_id: orderId,
      approval_id: approvalId,
      action: "booking_proposed",
      event: "booking.proposed"
    };
  }

  // Branch 2: booking.approved -> execute booking (dry-run or real PostEx)
  if (eventType === "booking.approved") {
    const isDryRun = (await fastn.envConfig.get("COURIER_DRY_RUN")) !== "false";
    const trackingNumber = isDryRun ? `PEX-DRY-${Date.now().toString().slice(-8)}` : `PEX-${Date.now().toString().slice(-8)}`;

    await fastn.db.query(
      `UPDATE orders
       SET tracking_number = $1, order_status = 'BOOKED', updated_at = NOW()
       WHERE tenant_id = $2 AND order_id = $3`,
      [trackingNumber, tenantId, orderId]
    );

    const eventId = `EV-SHIP-${Date.now()}`;
    const shipmentPayload = {
      order_id: orderId,
      tracking_number: trackingNumber,
      dry_run: isDryRun
    };

    await fastn.db.query(
      `INSERT INTO events (id, tenant_id, type, order_id, payload, created_at)
       VALUES ($1, $2, 'shipment.booked', $3, $4, NOW())`,
      [eventId, tenantId, orderId, JSON.stringify(shipmentPayload)]
    );

    await fastn.db.query(
      `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
       VALUES ($1, 'dispatcher', 'SHIPMENT_BOOKED', $2, $3, $4)`,
      [tenantId, orderId, eventId, `Booked PostEx shipment tracking ${trackingNumber} (DryRun=${isDryRun})`]
    );

    return {
      status: 200,
      order_id: orderId,
      tracking_number: trackingNumber,
      dry_run: isDryRun,
      event: "shipment.booked"
    };
  }

  return { status: 200, action: "no_op" };
}