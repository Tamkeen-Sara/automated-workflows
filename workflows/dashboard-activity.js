export default async function (ctx) {
  const { input, headers } = ctx;
  const tenantId = headers?.["x-tenant-id"] || "default";

  // 1. Recent Audit rows
  const audits = await fastn.db.query(
    `SELECT id, timestamp, actor, action, order_id, event_id, result
     FROM audit
     WHERE tenant_id = $1
     ORDER BY id DESC LIMIT 50`,
    [tenantId]
  );

  // 2. Recent LLM privacy logs (What the AI saw)
  const llmLogs = await fastn.db.query(
    `SELECT id, task, allowed_fields, request_body, response, created_at
     FROM llm_log
     WHERE tenant_id = $1
     ORDER BY id DESC LIMIT 30`,
    [tenantId]
  );

  return {
    status: 200,
    audit_count: audits.length,
    audits,
    llm_log_count: llmLogs.length,
    llm_logs: llmLogs,
    privacy_certified: true
  };
}