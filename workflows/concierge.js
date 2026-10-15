export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  const eventType = input?.type || "message.received";
  const payload = input?.payload || input || {};
  const { channel = "whatsapp", customer_ref = "CUST-WA-7890", customer_name = "Customer", text = "", attachment_ref = null } = payload;

  const safeText = (text || "").replace(/\b\d{10,}\b/g, "[NUMBER]");

  // 1. If attachment is present (Payment Screenshot), bypass LLM completely
  if (attachment_ref) {
    const activeOrderRes = await fastn.db.query(
      `SELECT order_id, amount_pkr FROM orders
       WHERE tenant_id = $1 AND customer_ref = $2
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, customer_ref]
    );
    const orderId = activeOrderRes[0]?.order_id || `ORD-${Date.now()}`;

    const proofEventId = `EV-PROOF-${Date.now()}`;
    const proofPayload = {
      order_id: orderId,
      channel,
      customer_ref,
      customer_name,
      attachment_ref
    };

    await fastn.db.query(
      `INSERT INTO events (id, tenant_id, type, order_id, payload, created_at)
       VALUES ($1, $2, 'payment.proof', $3, $4, NOW())`,
      [proofEventId, tenantId, orderId, JSON.stringify(proofPayload)]
    );

    await fastn.db.query(
      `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
       VALUES ($1, 'concierge', 'PAYMENT_PROOF_ROUTED', $2, $3, $4)`,
      [tenantId, orderId, proofEventId, "Routed payment proof attachment to Cashier"]
    );

    return {
      status: 200,
      action: "payment_proof_routed",
      order_id: orderId,
      event: "payment.proof"
    };
  }

  // 2. Classify intent via privacy-preserving helper
  let intent = "inquiry";
  const lower = safeText.toLowerCase();
  if (lower.includes("confirm") || lower.includes("order") || lower.includes("buy") || lower.includes("address")) {
    intent = "order_confirmation";
  } else if (lower.includes("where") || lower.includes("tracking") || lower.includes("status") || lower.includes("kahan")) {
    intent = "where_is_my_order";
  } else {
    intent = "inquiry";
  }

  // Log privacy-guarded LLM task
  await fastn.db.query(
    `INSERT INTO llm_log (tenant_id, task, allowed_fields, request_body, response, created_at)
     VALUES ($1, 'intent_classification', $2, $3, $4, NOW())`,
    [tenantId, JSON.stringify(["customer_name", "text"]), JSON.stringify({ customer_name, text: safeText }), intent]
  );

  // 3. Handle INQUIRY
  if (intent === "inquiry") {
    const catalogRows = await fastn.db.query(
      "SELECT product, price_pkr, sizes, colors, making_days, stock FROM catalog WHERE tenant_id = $1",
      [tenantId]
    );

    const catalogText = catalogRows.map(r => `• ${r.product}: PKR ${r.price_pkr} (Sizes: ${r.sizes}, Making: ${r.making_days} days)`).join("\n");
    const draftReply = `Assalam-o-Alaikum ${customer_name}! Thank you for reaching out. Here are details of our available collection:\n${catalogText}\nPlease share your preferred size and city to place an order!`;

    const approvalId = `APP-REPLY-${Date.now()}`;
    await fastn.db.query(
      `INSERT INTO approvals (approval_id, order_id, type, proposal, approved, created_at, tenant_id)
       VALUES ($1, 'INQUIRY', 'REPLY', $2, 'PENDING', NOW(), $3)`,
      [approvalId, draftReply, tenantId]
    );

    const autoSend = await fastn.envConfig.get("AUTO_SEND_CATALOG_REPLIES");
    const nextEvent = (autoSend === "true") ? "reply.approved" : "reply.proposed";

    await fastn.db.query(
      `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
       VALUES ($1, 'concierge', 'INQUIRY_DRAFTED', 'INQUIRY', $2, $3)`,
      [tenantId, approvalId, `Drafted catalog reply (${nextEvent})`]
    );

    return {
      status: 200,
      intent: "inquiry",
      event: nextEvent,
      approval_id: approvalId,
      draft_reply: draftReply
    };
  }

  // 4. Handle ORDER_CONFIRMATION
  if (intent === "order_confirmation") {
    const catalogRows = await fastn.db.query(
      "SELECT product, price_pkr, making_days FROM catalog WHERE tenant_id = $1 LIMIT 1",
      [tenantId]
    );
    const defaultProduct = catalogRows[0]?.product || "Embroidered Cotton Kurti";
    const defaultPrice = catalogRows[0]?.price_pkr || 2500;
    const makingDays = catalogRows[0]?.making_days || 2;

    const city = lower.includes("karachi") ? "Karachi" : lower.includes("islamabad") ? "Islamabad" : "Lahore";
    const paymentMode = lower.includes("cod") ? "cod" : "jazzcash";
    const orderId = `ORD-${Date.now().toString().slice(-6)}`;

    // Deterministic date math
    const makeByDate = new Date();
    makeByDate.setDate(makeByDate.getDate() + makingDays);
    const shipByDate = new Date(makeByDate);
    shipByDate.setDate(shipByDate.getDate() + 1);

    const makeBy = makeByDate.toISOString().split("T")[0];
    const shipBy = shipByDate.toISOString().split("T")[0];

    await fastn.db.query(
      `INSERT INTO orders (
        order_id, channel, customer_ref, city, items, amount_pkr,
        payment_mode, payment_status, order_status, make_by, ship_by,
        cod_expected, tenant_id, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CONFIRMED', $9, $10, $11, $12, NOW(), NOW())`,
      [
        orderId, channel, customer_ref, city, `${defaultProduct} x 1`, defaultPrice,
        paymentMode, (paymentMode === "cod" ? "COD" : "UNPAID"),
        makeBy, shipBy, (paymentMode === "cod" ? defaultPrice : 0), tenantId
      ]
    );

    const eventId = `EV-CONF-${Date.now()}`;
    await fastn.db.query(
      `INSERT INTO events (id, tenant_id, type, order_id, payload, created_at)
       VALUES ($1, $2, 'order.confirmed', $3, $4, NOW())`,
      [eventId, tenantId, orderId, JSON.stringify({ order_id: orderId, amount: defaultPrice, payment_mode: paymentMode })]
    );

    await fastn.db.query(
      `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
       VALUES ($1, 'concierge', 'ORDER_CREATED', $2, $3, $4)`,
      [tenantId, orderId, eventId, `Order ${orderId} confirmed for PKR ${defaultPrice} (make_by: ${makeBy})`]
    );

    return {
      status: 200,
      intent: "order_confirmation",
      event: "order.confirmed",
      order_id: orderId,
      make_by: makeBy,
      ship_by: shipBy,
      amount: defaultPrice
    };
  }

  // 5. Handle WHERE_IS_MY_ORDER
  if (intent === "where_is_my_order") {
    const orderRows = await fastn.db.query(
      `SELECT order_id, order_status, tracking_number FROM orders
       WHERE tenant_id = $1 AND customer_ref = $2
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, customer_ref]
    );
    const order = orderRows[0];
    const tracking = order?.tracking_number || "Order being prepared for dispatch";
    const statusText = order?.order_status || "CONFIRMED";

    const draftReply = `Assalam-o-Alaikum ${customer_name}! Your order ${order?.order_id || ''} is currently '${statusText}'. Tracking: ${tracking}. Delivery expected in 2-3 business days!`;

    const approvalId = `APP-TRACK-${Date.now()}`;
    await fastn.db.query(
      `INSERT INTO approvals (approval_id, order_id, type, proposal, approved, created_at, tenant_id)
       VALUES ($1, $2, 'REPLY', $3, 'PENDING', NOW(), $4)`,
      [approvalId, order?.order_id || "UNKNOWN", draftReply, tenantId]
    );

    return {
      status: 200,
      intent: "where_is_my_order",
      approval_id: approvalId,
      draft_reply: draftReply
    };
  }

  return { status: 200, intent: "other" };
}