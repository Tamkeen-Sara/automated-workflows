export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  if (input?.["hub.mode"] === "subscribe") {
    if (input?.["hub.verify_token"] === "hisaab-meta-webhook-verify-token-nascon-2026") {
      return { status: 200, challenge: input["hub.challenge"] };
    }
    return { status: 403, error: "Verification token mismatch" };
  }

  const entry = input?.entry?.[0];
  let channel = "whatsapp";
  let senderId = null;
  let senderName = "Customer";
  let messageText = "";
  let attachmentRef = null;
  let messageId = `msg_${Date.now()}`;

  if (entry?.changes?.[0]?.value?.messages?.[0]) {
    channel = "whatsapp";
    const val = entry.changes[0].value;
    const msg = val.messages[0];
    messageId = msg.id || messageId;
    senderId = msg.from;
    senderName = val.contacts?.[0]?.profile?.name || "WhatsApp Customer";
    if (msg.type === "text") {
      messageText = msg.text?.body || "";
    } else if (msg.type === "image") {
      attachmentRef = msg.image?.id || "wa_img_mock";
      messageText = msg.image?.caption || "[Payment Screenshot Attachment]";
    }
  } else if (entry?.messaging?.[0]) {
    channel = "instagram";
    const msgItem = entry.messaging[0];
    senderId = msgItem.sender?.id;
    senderName = "Instagram User";
    messageId = msgItem.message?.mid || messageId;
    messageText = msgItem.message?.text || "";
    if (msgItem.message?.attachments?.[0]?.type === "image") {
      attachmentRef = msgItem.message.attachments[0].payload?.url || "ig_img_mock";
    }
  } else {
    channel = input?.channel || "whatsapp";
    senderId = input?.customer_ref || "03001234567";
    senderName = input?.customer_name || "Test Customer";
    messageText = input?.text || "";
    attachmentRef = input?.attachment_ref || null;
    messageId = input?.message_id || messageId;
  }

  const safeText = messageText.replace(/\b\d{10,}\b/g, "[NUMBER]");
  const safeCustomerRef = `CUST-${channel.slice(0, 2).toUpperCase()}-${String(senderId).slice(-4)}`;

  const eventPayload = {
    channel,
    customer_ref: safeCustomerRef,
    raw_sender: senderId,
    customer_name: senderName,
    text: safeText,
    attachment_ref: attachmentRef,
    message_id: messageId
  };

  const eventId = `EV-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
  await fastn.db.query(
    `INSERT INTO events (id, tenant_id, type, order_id, payload, created_at)
     VALUES ($1, $2, 'message.received', NULL, $3, NOW())
     ON CONFLICT (id, tenant_id) DO NOTHING`,
    [eventId, tenantId, JSON.stringify(eventPayload)]
  );

  await fastn.db.query(
    `INSERT INTO audit (tenant_id, actor, action, order_id, event_id, result)
     VALUES ($1, 'meta-inbound', 'MESSAGE_RECEIVED', NULL, $2, $3)`,
    [tenantId, eventId, `Received ${channel} message from ${safeCustomerRef}`]
  );

  return {
    status: 200,
    event: "message.received",
    eventId,
    payload: eventPayload
  };
}