import type { FastifyPluginAsync } from "fastify";
import { withRequestContext } from "../db.js";

// Object type definitions are data, not code (per the ontology design) — this is what lets the
// frontend's type filters and mapping-template UI stay in sync with the ontology without a
// deploy. Closes the gap flagged in PHASE2_REVIEW.md where the search screen hardcoded its
// type list.
const objectTypesRoutes: FastifyPluginAsync = async (app) => {
  app.get("/object-types", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });

    const types = await withRequestContext(request.ctx, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, property_schema, version FROM object_types ORDER BY name`,
      );
      return rows;
    });

    reply.send({ objectTypes: types });
  });

  // Same rationale as /object-types, needed once edge-mapping templates (DECISIONS.md #45)
  // let an admin pick a relationship type from the UI instead of a hardcoded list.
  app.get("/relationship-types", async (request, reply) => {
    if (!request.ctx) return reply.code(401).send({ error: "unauthenticated" });

    const types = await withRequestContext(request.ctx, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name FROM relationship_types ORDER BY name`,
      );
      return rows;
    });

    reply.send({ relationshipTypes: types });
  });
};

export default objectTypesRoutes;
