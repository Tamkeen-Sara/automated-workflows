export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  const csvContent = input?.csv_content || "tracking_number,status,cod_amount,charges,net_remitted\nPEX-1001,Delivered,2500,250,2250";
  const lines = csvContent.trim().split("\n");
  const headersList = lines[0].split(",").map(h => h.trim().toLowerCase());

  let reconciledCount = 0;
  let totalNetRemitted = 0;
  const discrepancies = [];

  for (let i = 1; i < lines.length; i++) {
    const parts = lines[i].split(",").map(p => p.trim());
    if (parts.length < headersList.length) continue;

    const row = {};
    headersList.forEach((h, idx) => row[h] = parts[idx]);

    const trackingNumber = row.tracking_number;
    const status = (row.status || "Delivered").toUpperCase();
    const codAmount = parseFloat(row.cod_amount || "0");
    const charges = parseFloat(row.charges || "0");
    const netRemitted = parseFloat(row.net_remitted || "0");

    // Match order by tracking number
    const orderRows = await fastn.db.query(
      "SELECT order_id, amount_pkr, cod_expected FROM orders WHERE tenant_id = $1 AND tracking_number = $2",
      [tenantId, trackingNumber]
    );

    if (orderRows.length === 0) {
      discrepancies.push({ trackingNumber, error: "Tracking number not found" });
      continue;
    }

    const orderId = orderRows[0].order_id;

    if (status.includes("RETURN")) {
      await fastn.db.query(
        "UPDATE orders SET order_status = 'RETURNED', updated_at = NOW() WHERE tenant_id = $1 AND order_id = $2",
        [tenantId, orderId]
      );
      continue;
    }

    const expectedNet = codAmount - charges;
    if (Math.abs(netRemitted - expectedNet) > 1.0) {
      discrepancies.push({ orderId, trackingNumber, expectedNet, netRemitted, error: "Calculation discrepancy" });
      continue;
    }

    // Clean match: advance to REMITTED
    reconciledCount++;
    totalNetRemitted += netRemitted;

    await fastn.db.query(
      `UPDATE orders
       SET cod_remitted = $1, order_status = 'REMITTED', updated_at = NOW()
       WHERE tenant_id = $2 AND order_id = $3`,
      [netRemitted, tenantId, orderId]
    );

    const eventId = `EV-REMIT-${Date.now()}-${i}`;
    await fastn.db.query(
      `INSERT INTO events (id, tenant_id, type, order_id, payload, created_at)
       VALUES ($1, $2, 'order.remitted', $3, $4, NOW())`,
      [eventId, tenantId, orderId, JSON.stringify({ order_id: orderId, tracking_number: trackingNumber, net_remitted: netRemitted })]
    );
  }

  await fastn.db.query(
    `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
     VALUES ($1, 'settlement-ingest', 'SETTLEMENT_RECONCILED', NULL, NULL, $2)`,
    [tenantId, `Reconciled ${reconciledCount} orders (Net PKR ${totalNetRemitted}), Discrepancies: ${discrepancies.length}`]
  );

  return {
    status: 200,
    reconciled_count: reconciledCount,
    total_net_remitted: totalNetRemitted,
    discrepancies,
    event: "settlement.received"
  };
}