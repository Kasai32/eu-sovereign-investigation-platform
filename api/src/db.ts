import pg from "pg";

const { Pool } = pg;

// This pool MUST connect as the dedicated app_user role, never as postgres/owner — that's the
// specific mistake the build prompt calls out, and it's silent: RLS just stops filtering and
// nothing errors. See db/scripts/test-rls.sh for the proof this role boundary actually matters.
export const pool = new Pool({
  host: process.env.PGHOST ?? "localhost",
  port: Number(process.env.PGPORT ?? 5432),
  database: process.env.PGDATABASE ?? "platform",
  user: process.env.PGUSER ?? "app_user",
  password: process.env.PGPASSWORD ?? "app_user_local_dev_only",
  max: 10,
});

if ((process.env.PGUSER ?? "app_user") !== "app_user") {
  throw new Error(
    "Refusing to start: PGUSER must be the dedicated app_user role, not postgres/owner. " +
      "See db/migrations/005_roles_and_rls.sql and the Phase 0 self-review.",
  );
}

export type RequestContext = {
  userId: string;
  actorRole: "analyst" | "supervisor" | "compliance" | "admin";
  clearance: "PUBLIC" | "INTERNAL" | "SENSITIVE" | "RESTRICTED";
};

/**
 * Runs `fn` inside a transaction with the RLS session variables set via set_config (not string-
 * interpolated SET LOCAL) so parameter values can never be used for SQL injection. Every query
 * issued by the app must go through this — a route that grabs a raw pool client without setting
 * context will see nothing, thanks to FORCE ROW LEVEL SECURITY + fail-closed policies.
 */
export async function withRequestContext<T>(
  ctx: RequestContext,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `SELECT set_config('app.current_user_id', $1, true),
              set_config('app.actor_role', $2, true),
              set_config('app.current_clearance', $3, true)`,
      [ctx.userId, ctx.actorRole, ctx.clearance],
    );
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
