export default async function (ctx) {
  const { input, headers } = ctx;
  const {
    referenceId,
    expectedAmount,
    currency = "PKR",
    beneficiaryAccount,
    checkGatewayHealth = false,
    maxAgeDays = 7
  } = input || {};

  // 1. Gateway operational health check
  if (checkGatewayHealth) {
    const health = await fastn.connector.nationalBankSwitch.getGatewayStatus({});
    return {
      verified: true,
      status: "HEALTHY",
      gatewayStatus: health.output?.status || "UP",
      timestamp: health.output?.timestamp || new Date().toISOString(),
      errors: 0
    };
  }

  // 2. Validate required receipt input
  if (!referenceId) {
    return {
      verified: false,
      status: "INVALID_INPUT",
      error: "Transaction referenceId is required to verify payment receipt",
      errors: 1,
      errorDetails: ["referenceId parameter is missing"]
    };
  }

  // 3. Anti-Replay Check (Idempotency & Fraud Prevention)
  const stateKey = `receipt:${referenceId}`;
  const existingReceipt = await fastn.state.get(stateKey);
  if (existingReceipt) {
    return {
      verified: false,
      status: "DUPLICATE_RECEIPT",
      referenceId,
      error: "Payment receipt reference has already been verified and processed",
      previousVerification: existingReceipt,
      errors: 1,
      errorDetails: [`Duplicate receipt reference: ${referenceId}`]
    };
  }

  // 4. Inquire National Bank Switch Clearing Network
  let bankResponse;
  try {
    const callResult = await fastn.connector.nationalBankSwitch.inquireTransaction({
      referenceId
    });
    bankResponse = callResult?.output;
  } catch (err) {
    return {
      verified: false,
      status: "SWITCH_ERROR",
      referenceId,
      error: err.message || "Failed to communicate with national bank switch",
      errors: 1,
      errorDetails: [err.message]
    };
  }

  if (!bankResponse) {
    return {
      verified: false,
      status: "EMPTY_RESPONSE",
      referenceId,
      error: "National bank switch returned empty response",
      errors: 1,
      errorDetails: ["Empty response from switch"]
    };
  }

  // 5. Verify Settlement Status on Network
  if (bankResponse.status === "NOT_FOUND" || bankResponse.responseCode === "99") {
    return {
      verified: false,
      status: "TRANSACTION_NOT_FOUND",
      referenceId,
      responseCode: bankResponse.responseCode || "99",
      error: "Transaction reference was not found on the clearing network",
      errors: 1,
      errorDetails: [bankResponse.message || "Transaction not found"]
    };
  }

  if (bankResponse.status !== "SETTLED" && bankResponse.status !== "SUCCESS") {
    return {
      verified: false,
      status: "NOT_SETTLED",
      referenceId,
      bankStatus: bankResponse.status,
      responseCode: bankResponse.responseCode,
      error: `Transaction is not settled (status: ${bankResponse.status})`,
      errors: 1,
      errorDetails: [`Bank status: ${bankResponse.status}`]
    };
  }

  // 6. Amount Matching Verification
  const settledAmount = Number(bankResponse.amount);
  if (expectedAmount !== undefined && expectedAmount !== null) {
    const claimedAmount = Number(expectedAmount);
    if (Math.abs(settledAmount - claimedAmount) > 0.01) {
      return {
        verified: false,
        status: "AMOUNT_MISMATCH",
        referenceId,
        expectedAmount: claimedAmount,
        settledAmount,
        currency: bankResponse.currency,
        error: `Amount mismatch: expected ${claimedAmount}, settled ${settledAmount}`,
        errors: 1,
        errorDetails: [`Amount mismatch: expected ${claimedAmount}, settled ${settledAmount}`]
      };
    }
  }

  // 7. Currency Matching Verification
  if (currency && bankResponse.currency && currency.toUpperCase() !== bankResponse.currency.toUpperCase()) {
    return {
      verified: false,
      status: "CURRENCY_MISMATCH",
      referenceId,
      expectedCurrency: currency.toUpperCase(),
      settledCurrency: bankResponse.currency.toUpperCase(),
      error: `Currency mismatch: expected ${currency}, settled ${bankResponse.currency}`,
      errors: 1,
      errorDetails: [`Currency mismatch: expected ${currency}, settled ${bankResponse.currency}`]
    };
  }

  // 8. Destination Account Verification
  if (beneficiaryAccount && bankResponse.beneficiaryAccount && beneficiaryAccount !== bankResponse.beneficiaryAccount) {
    return {
      verified: false,
      status: "BENEFICIARY_MISMATCH",
      referenceId,
      expectedAccount: beneficiaryAccount,
      settledAccount: bankResponse.beneficiaryAccount,
      error: "Beneficiary account on receipt does not match merchant receiving account",
      errors: 1,
      errorDetails: ["Beneficiary account mismatch"]
    };
  }

  // 9. Timestamp Window Verification (Anti-Stale Receipt)
  if (bankResponse.settledAt && maxAgeDays > 0) {
    const settledTime = new Date(bankResponse.settledAt).getTime();
    const now = Date.now();
    const ageDays = (now - settledTime) / (1000 * 60 * 60 * 24);
    if (ageDays > maxAgeDays) {
      return {
        verified: false,
        status: "RECEIPT_EXPIRED",
        referenceId,
        settledAt: bankResponse.settledAt,
        ageDays: Math.round(ageDays * 10) / 10,
        error: `Receipt date exceeds allowable verification window of ${maxAgeDays} days`,
        errors: 1,
        errorDetails: [`Receipt expired: settled ${Math.round(ageDays)} days ago`]
      };
    }
  }

  // 10. All Checks Passed - Mark Verified and Save State
  const verificationRecord = {
    verifiedAt: new Date().toISOString(),
    referenceId,
    settledAmount,
    currency: bankResponse.currency,
    settledAt: bankResponse.settledAt,
    payerAccount: bankResponse.payerAccount,
    payerName: bankResponse.payerName,
    beneficiaryAccount: bankResponse.beneficiaryAccount
  };

  await fastn.state.set(stateKey, verificationRecord);

  return {
    verified: true,
    status: "VERIFIED",
    referenceId,
    settledAmount,
    currency: bankResponse.currency,
    settledAt: bankResponse.settledAt,
    payerName: bankResponse.payerName,
    payerAccount: bankResponse.payerAccount,
    beneficiaryAccount: bankResponse.beneficiaryAccount,
    verifiedAt: verificationRecord.verifiedAt,
    errors: 0
  };
}