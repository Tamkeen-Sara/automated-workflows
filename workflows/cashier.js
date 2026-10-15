export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  const eventType = input?.type || "payment.proof";
  const payload = input?.payload || input || {};
  const orderId = input?.order_id || payload.order_id || "ORD-TEST-01";
  const attachmentRef = payload.attachment_ref || "wa_img_001";
  const receiptText = payload.receipt_text || "JazzCash Transaction Successful Txn ID: 01234567890 Amount: Rs. 2,500.00 To: 0300***7890 Date: 15 Oct 2026";

  // 1. Fetch Order
  const orderRows = await fastn.db.query(
    "SELECT order_id, amount_pkr, payment_status, order_status FROM orders WHERE tenant_id = $1 AND order_id = $2",
    [tenantId, orderId]
  );
  const expectedAmount = parseFloat(orderRows[0]?.amount_pkr || "2500");

  // 2. Deterministic regex parsing of receipt text
  let wallet = "unknown";
  let amount = 0;
  let rawTid = "";
  let recipientLast4 = "";

  const jcMatch = receiptText.match(/(?:Txn\s*ID|TID|Transaction\s*ID)[\s:]*([A-Za-z0-9]+)/i);
  if (jcMatch) rawTid = jcMatch[1].replace(/[\s\-_]/g, "").toUpperCase();

  const amtMatch = receiptText.match(/(?:Rs\.?|PKR|Amount)[\s:]*([0-9,]+(?:\.[0-9]{1,2})?)/i);
  if (amtMatch) amount = parseFloat(amtMatch[1].replace(/,/g, ""));

  const recMatch = receiptText.match(/(?:Account|Mobile|To)[\s:]*.*?(\d{4})/i);
  if (recMatch) recipientLast4 = recMatch[1];

  wallet = receiptText.toLowerCase().includes("easypaisa") ? "easypaisa" : "jazzcash";

  if (!rawTid || !amount) {
    return {
      status: 200,
      order_id: orderId,
      claim_status: "UNREADABLE",
      event: "payment.flagged",
      reason: "OCR failed to identify valid transaction ID and amount"
    };
  }

  // 3. HMAC Tokenization (Zero raw TID storage)
  const hmacKey = await fastn.secrets.get("HISAAB_HMAC_KEY");
  const tokenRes = await fastn.db.query(
    "SELECT encode(sha256(($1 || $2)::bytea), 'hex') as token",
    [rawTid, hmacKey]
  );
  const tidToken = tokenRes[0]?.token;

  // 4. Matching Logic
  // Check if token already claimed (SUSPECTED_REUSE)
  const claimedCheck = await fastn.db.query(
    "SELECT order_id FROM payment_claims WHERE tenant_id = $1 AND tid_token = $2 AND status = 'VERIFIED' AND order_id != $3",
    [tenantId, tidToken, orderId]
  );
  if (claimedCheck.length > 0) {
    await fastn.db.query(
      `INSERT INTO payment_claims (order_id, tid_token, amount, wallet, recipient_last4, status, reason, tenant_id)
       VALUES ($1, $2, $3, $4, $5, 'SUSPECTED_REUSE', $6, $7)`,
      [orderId, tidToken, amount, wallet, recipientLast4, `TID token already used by order ${claimedCheck[0].order_id}`, tenantId]
    );
    await fastn.db.query(
      "UPDATE orders SET payment_status = 'SUSPECTED_REUSE', updated_at = NOW() WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, orderId]
    );
    return { status: 200, order_id: orderId, claim_status: "SUSPECTED_REUSE", event: "payment.flagged" };
  }

  // Check Amount shortage (NEEDS_FIX)
  if (amount < expectedAmount) {
    await fastn.db.query(
      `INSERT INTO payment_claims (order_id, tid_token, amount, wallet, recipient_last4, status, reason, tenant_id)
       VALUES ($1, $2, $3, $4, $5, 'NEEDS_FIX', $6, $7)`,
      [orderId, tidToken, amount, wallet, recipientLast4, `Amount PKR ${amount} is short of required PKR ${expectedAmount}`, tenantId]
    );
    await fastn.db.query(
      "UPDATE orders SET payment_status = 'NEEDS_FIX', updated_at = NOW() WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, orderId]
    );
    return { status: 200, order_id: orderId, claim_status: "NEEDS_FIX", event: "payment.flagged" };
  }

  // Check Ledger match
  const ledgerMatch = await fastn.db.query(
    "SELECT id, amount, received_at FROM ledger WHERE tenant_id = $1 AND tid_token = $2 AND claimed_by_order IS NULL",
    [tenantId, tidToken]
  );

  let claimStatus = "WAITING";
  let nextEvent = "payment.waiting";

  if (ledgerMatch.length > 0) {
    claimStatus = "VERIFIED";
    nextEvent = "payment.verified";

    // Bind ledger credit to this order
    await fastn.db.query(
      "UPDATE ledger SET claimed_by_order = $1 WHERE id = $2",
      [orderId, ledgerMatch[0].id]
    );

    // Update order status
    await fastn.db.query(
      "UPDATE orders SET payment_status = 'VERIFIED', order_status = 'PAID', updated_at = NOW() WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, orderId]
    );
  } else {
    await fastn.db.query(
      "UPDATE orders SET payment_status = 'WAITING', updated_at = NOW() WHERE tenant_id = $1 AND order_id = $2",
      [tenantId, orderId]
    );
  }

  // Record claim
  await fastn.db.query(
    `INSERT INTO payment_claims (order_id, tid_token, amount, wallet, recipient_last4, status, tenant_id)\n     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [orderId, tidToken, amount, wallet, recipientLast4, claimStatus, tenantId]
  );

  // Record audit
  await fastn.db.query(
    `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)\n     VALUES ($1, 'cashier', 'PAYMENT_CLAIM_PROCESSED', $2, NULL, $3)`,
    [tenantId, orderId, `Claim status ${claimStatus} for PKR ${amount} (${wallet})`]
  );

  return {
    status: 200,
    order_id: orderId,
    claim_status: claimStatus,
    amount,
    wallet,
    tid_last4: rawTid.slice(-4),
    event: nextEvent
  };
}