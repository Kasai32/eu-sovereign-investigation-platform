import type pg from "pg";

export type AuditParams = {
  userId: string;
  action: string;
  resourceType?: string | null;
  resourceId?: string | null;
  purpose: string;
  details?: Record<string, unknown>;
};

/** Every route that reads or writes classified data calls this — same table, same schema,
 * whether the caller is a human request or (later) the AI assistant layer. No separate log. */
export async function writeAudit(client: pg.PoolClient, p: AuditParams): Promise<void> {
  await client.query(
    `SELECT write_audit_log($1, $2, $3, $4, $5, $6::jsonb)`,
    [p.userId, p.action, p.resourceType ?? null, p.resourceId ?? null, p.purpose, JSON.stringify(p.details ?? {})],
  );
}
