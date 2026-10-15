export default async function (ctx) {
  const { input } = ctx;
  const {
    date = new Date().toISOString().split("T")[0],
    ordersDueToday = [
      { orderId: "ORD-DUE-01", items: "Chiffon Dupatta", customerName: "Sadia", city: "Lahore" }
    ],
    paymentsFlagged = [
      { orderId: "ORD-FLAG-02", amount: 3500, status: "PROBABLE" }
    ],
    pendingApprovals = [
      { approvalId: "APP-01", type: "BOOKING", orderId: "ORD-DUE-01" }
    ],
    parcelsInTransit = 3,
    cashHeldByCourier = 14200,
    lowStockItems = [
      { product: "Festive Velvet Shawl", stock: 1 }
    ],
    sellerEmail = "seller@hisaab.local",
    slackChannel = "#hisaab-seller-alerts"
  } = input || {};

  const digestMessage = [
    `☀️ Hisaab Subah Bakhair Digest — ${date}`,
    `Assalam-o-Alaikum Baji! Here is your daily operational briefing:`,
    ``,
    `🧵 MAKING & STITCHING SCHEDULE:`,
    `• Due today: ${ordersDueToday.length} order(s)`,
    ...ordersDueToday.map(o => `   - ${o.orderId}: ${o.items} for ${o.customerName} (${o.city})`),
    ``,
    `💳 PAYMENT HEALTH:`,
    `• Flagged payments requiring attention: ${paymentsFlagged.length}`,
    ...paymentsFlagged.map(p => `   - ${p.orderId}: PKR ${p.amount} [${p.status}]`),
    ``,
    `✍️ PENDING SELLER APPROVALS: ${pendingApprovals.length}`,
    ...pendingApprovals.map(a => `   - [${a.type}] ${a.approvalId} for ${a.orderId}`),
    ``,
    `🚚 LOGISTICS & COD:`,
    `• Parcels in transit: ${parcelsInTransit}`,
    `• COD Cash held by courier: PKR ${cashHeldByCourier.toLocaleString()}`,
    ``,
    `📦 LOW STOCK ALERTS: ${lowStockItems.length}`,
    ...lowStockItems.map(i => `   - ${i.product}: only ${i.stock} left in stock!`),
    ``,
    `May Allah grant barakah in your sales today! ✨`
  ].join("\n");

  const auditEntry = {
    timestamp: new Date().toISOString(),
    actor: "fastn_flow_munshi",
    action: "DAILY_DIGEST_DISPATCHED",
    trigger: "cron_9am_daily",
    result: `Dispatched digest for ${date} to ${slackChannel} and ${sellerEmail}`
  };

  return {
    success: true,
    date,
    channels: {
      slack: slackChannel,
      email: sellerEmail
    },
    digestMessage,
    metrics: {
      ordersDueCount: ordersDueToday.length,
      flaggedPaymentsCount: paymentsFlagged.length,
      pendingApprovalsCount: pendingApprovals.length,
      parcelsInTransit,
      cashHeldByCourier,
      lowStockCount: lowStockItems.length
    },
    audit: auditEntry,
    errors: 0
  };
}