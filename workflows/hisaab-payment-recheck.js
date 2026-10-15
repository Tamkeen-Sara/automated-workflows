export default async function (ctx) {
  const { input } = ctx;
  const { vaultUrl = "http://localhost:8000", maxWaitHours = 2 } = input || {};

  const waitingOrders = input?.waitingOrders || [
    { orderId: "ORD-WAIT-001", amount: 2500, wallet: "jazzcash", waitingSinceHours: 0.5, tidToken: "tok_123" }
  ];

  let verifiedCount = 0;
  let expiredCount = 0;
  const processed = [];

  for (const order of waitingOrders) {
    if (order.waitingSinceHours >= maxWaitHours) {
      expiredCount++;
      processed.push({
        orderId: order.orderId,
        previousStatus: "WAITING",
        newStatus: "NEEDS_FIX",
        reason: `Payment verification timed out after ${maxWaitHours} hours without bank confirmation`
      });
    } else if (order.ledgerMatched) {
      verifiedCount++;
      processed.push({
        orderId: order.orderId,
        previousStatus: "WAITING",
        newStatus: "VERIFIED",
        reason: "Matched bank SMS ledger credit"
      });
    } else {
      processed.push({
        orderId: order.orderId,
        previousStatus: "WAITING",
        newStatus: "WAITING",
        reason: "Still within allowable confirmation window"
      });
    }
  }

  const auditEntry = {
    timestamp: new Date().toISOString(),
    actor: "fastn_flow_cashier",
    action: "SCHEDULED_PAYMENT_RECHECK",
    trigger: "cron_10min",
    result: `Checked: ${waitingOrders.length}, Verified: ${verifiedCount}, Expired: ${expiredCount}`
  };

  return {
    success: true,
    checkedCount: waitingOrders.length,
    verifiedCount,
    expiredCount,
    processed,
    audit: auditEntry,
    errors: 0
  };
}