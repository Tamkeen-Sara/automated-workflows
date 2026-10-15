export default async function (ctx) {
  const { input } = ctx;
  const {
    activeParcels = [
      { orderId: "ORD-101", trackingNumber: "PEX-1001", currentStatus: "BOOKED", customerName: "Ayesha", simulatedStatus: "IN_TRANSIT" }
    ],
    autoTrackingUpdates = true
  } = input || {};

  let updatedCount = 0;
  const trackingResults = [];

  for (const parcel of activeParcels) {
    const isDelivered = parcel.simulatedStatus === "DELIVERED";
    const isInTransit = parcel.simulatedStatus === "IN_TRANSIT" || parcel.currentStatus === "BOOKED";
    const newStatus = isDelivered ? "DELIVERED" : (isInTransit ? "IN_TRANSIT" : parcel.currentStatus);

    if (newStatus !== parcel.currentStatus) {
      updatedCount++;
    }

    trackingResults.push({
      orderId: parcel.orderId,
      trackingNumber: parcel.trackingNumber,
      previousStatus: parcel.currentStatus,
      newStatus,
      templatedMessageSent: autoTrackingUpdates && newStatus !== parcel.currentStatus
    });
  }

  const auditEntry = {
    timestamp: new Date().toISOString(),
    actor: "fastn_flow_dispatcher",
    action: "SCHEDULED_TRACKING_POLL",
    trigger: "cron_2hours",
    result: `Polled: ${activeParcels.length}, StatusUpdates: ${updatedCount}`
  };

  return {
    success: true,
    polledCount: activeParcels.length,
    updatedCount,
    parcels: trackingResults,
    audit: auditEntry,
    errors: 0
  };
}