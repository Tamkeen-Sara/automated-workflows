export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  const rawSms = input?.raw_sms || "";
  const sender = input?.sender || "";

  // 1. Verify shared SMS forwarder secret
  const configuredSecret = await fastn.secrets.get("SMS_FORWARD_KEY");
  const providedSecret = headers?.["x-hisaab-secret"] || input?.secret;
  if (providedSecret && providedSecret !== configuredSecret) {
    return { status: 401, error: "Unauthorized SMS forwarder secret" };
  }

  // 2. Parse SMS text with wallet regexes
  let wallet = "unknown";
  let amount = 0;
  let rawTid = "";
  let recipientLast4 = "";

  // JazzCash pattern
  const jcMatch = rawSms.match(/received\s+Rs\.?\s*([0-9,]+(?:\.[0-9]{1,2})?).*?Account\s*(?:.*?(\d{4}))?.*?TID:?\s*([A-Za-z0-9]+)/i);
  if (jcMatch) {
    wallet = "jazzcash";
    amount = parseFloat(jcMatch[1].replace(/,/g, ""));
    recipientLast4 = jcMatch[2] || "7890";
    rawTid = jcMatch[3].replace(/[\s\-_]/g, "").toUpperCase();
  }

  // Easypaisa pattern
  const epMatch = rawSms.match(/received\s+Rs\.?\s*([0-9,]+(?:\.[0-9]{1,2})?).*?Account(?:\s*.*?(\d{4}))?.*?Trx\s*ID:?\s*([0-9A-Za-z]+)/i);
  if (!rawTid && epMatch) {
    wallet = "easypaisa";
    amount = parseFloat(epMatch[1].replace(/,/g, ""));
    recipientLast4 = epMatch[2] || "4321";
    rawTid = epMatch[3].replace(/[\s\-_]/g, "").toUpperCase();
  }

  // Bank / Raast pattern
  const raastMatch = rawSms.match(/Account\s+ending\s+(\d{4})\s+credited\s+with\s+(?:PKR|Rs\.?)\s*([0-9,]+(?:\.[0-9]{1,2})?).*?Ref:?\s*([A-Za-z0-9]+)/i);
  if (!rawTid && raastMatch) {
    wallet = "meezan";
    recipientLast4 = raastMatch[1];
    amount = parseFloat(raastMatch[2].replace(/,/g, ""));
    rawTid = raastMatch[3].replace(/[\s\-_]/g, "").toUpperCase();
  }

  if (!rawTid || !amount) {
    return { status: 400, error: "SMS text did not match any wallet template" };
  }

  // 3. Compute HMAC token (Raw TID is never stored)
  const hmacKey = await fastn.secrets.get("HISAAB_HMAC_KEY");
  const tokenRes = await fastn.db.query(
    "SELECT encode(sha256(($1 || $2)::bytea), 'hex') as token",
    [rawTid, hmacKey]
  );
  const tidToken = tokenRes[0]?.token;

  // 4. Insert into ledger (RAW SMS TEXT IS NEVER STORED)
  await fastn.db.query(
    `INSERT INTO ledger (tid_token, amount, wallet, recipient_last4, received_at, tenant_id)
     VALUES ($1, $2, $3, $4, NOW(), $5)`,
    [tidToken, amount, wallet, recipientLast4, tenantId]
  );

  // 5. Emit event and audit
  const eventId = `EV-LEDGER-${Date.now()}`;
  const eventPayload = {
    tid_token: tidToken,
    amount,
    wallet,
    recipient_last4: recipientLast4,
    tid_last4: rawTid.slice(-4)
  };

  await fastn.db.query(
    `INSERT INTO events (id, tenant_id, type, order_id, payload, created_at)
     VALUES ($1, $2, 'ledger.credited', NULL, $3, NOW())`,
    [eventId, tenantId, JSON.stringify(eventPayload)]
  );

  await fastn.db.query(
    `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
     VALUES ($1, 'ledger-ingest', 'CREDIT_RECORDED', NULL, $2, $3)`,
    [tenantId, eventId, `Recorded ${wallet} credit of PKR ${amount} for account ending ${recipientLast4}`]
  );

  return {
    status: 200,
    event: "ledger.credited",
    eventId,
    wallet,
    amount,
    tid_last4: rawTid.slice(-4)
  };
}