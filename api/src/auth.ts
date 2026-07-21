import { createRemoteJWKSet, jwtVerify } from "jose";
import type { FastifyReply, FastifyRequest } from "fastify";
import { pool, type RequestContext } from "./db.js";

const issuer = process.env.KEYCLOAK_ISSUER ?? "http://localhost:8080/realms/platform";
const jwks = createRemoteJWKSet(new URL(`${issuer}/protocol/openid-connect/certs`));

// Ordered most-privileged first: if a token somehow carries more than one of our roles, the
// higher one wins rather than being ambiguous.
const KNOWN_ROLES = ["admin", "compliance", "supervisor", "analyst"] as const;

declare module "fastify" {
  interface FastifyRequest {
    ctx?: RequestContext;
  }
}

/**
 * Authenticates via Keycloak (proves identity) then looks up role/clearance from app_users
 * (our own admin-managed authorization data — S7), never trusting authorization claims from
 * the token itself. This is deliberate: it keeps a single place (app_users, editable by admins
 * in-app) as the source of truth for who can see what, and means deactivating a user in
 * app_users takes effect on their very next request without waiting for token expiry.
 */
export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    reply.code(401).send({ error: "missing bearer token" });
    return;
  }

  const token = header.slice("Bearer ".length);
  let email: string | undefined;
  let realmRoles: string[] = [];
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer });
    email = payload.email as string | undefined;
    realmRoles = ((payload.realm_access as { roles?: string[] } | undefined)?.roles) ?? [];
  } catch {
    reply.code(401).send({ error: "invalid or expired token" });
    return;
  }

  if (!email) {
    reply.code(401).send({ error: "token missing email claim" });
    return;
  }

  const matchedRole = KNOWN_ROLES.find((r) => realmRoles.includes(r));
  if (!matchedRole) {
    reply.code(403).send({ error: "token carries no recognized application role" });
    return;
  }

  const { rows } = await pool.query<{ id: string; role: RequestContext["actorRole"]; clearance: RequestContext["clearance"]; is_active: boolean }>(
    `SELECT id, role, clearance, is_active FROM app_users WHERE email = $1`,
    [email],
  );
  const user = rows[0];
  if (!user || !user.is_active) {
    reply.code(403).send({ error: "unknown or inactive user" });
    return;
  }

  request.ctx = { userId: user.id, actorRole: user.role, clearance: user.clearance };
}
