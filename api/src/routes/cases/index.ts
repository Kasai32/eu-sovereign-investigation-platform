import type { FastifyPluginAsync } from "fastify";
import casesQueueRoutes from "./queue.js";
import casesWorkspaceRoutes from "./workspace.js";
import casesLifecycleRoutes from "./lifecycle.js";

// Composes the case queue (S1), workspace (S2 — read/graph/notes/pin), and lifecycle
// (status transitions + S7 report export) route groups into the single plugin index.ts
// registers. Each group lives in its own file (see ARCHITECTURE_AUDIT.md §2 — this was the
// largest route file, flagged there as a splitting candidate but deliberately not split at
// the time); route paths and behavior are unchanged, this only reorganizes where the code lives.
const casesRoutes: FastifyPluginAsync = async (app) => {
  await app.register(casesQueueRoutes);
  await app.register(casesWorkspaceRoutes);
  await app.register(casesLifecycleRoutes);
};

export default casesRoutes;
