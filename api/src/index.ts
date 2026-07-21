import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { authenticate } from "./auth.js";
import objectsRoutes from "./routes/objects.js";
import graphRoutes from "./routes/graph.js";
import casesRoutes from "./routes/cases.js";
import auditRoutes from "./routes/audit.js";
import objectTypesRoutes from "./routes/objectTypes.js";
import ingestionRoutes from "./routes/ingestion.js";
import resolutionQueueRoutes from "./routes/resolutionQueue.js";
import adminRoutes from "./routes/admin.js";

const app = Fastify({ logger: true });

// Local dev origin only. A real deployment would read this from config per environment rather
// than hardcoding it, and would never use a wildcard given the classified data behind this API.
await app.register(cors, {
  origin: [process.env.WEB_ORIGIN ?? "http://localhost:3000"],
  credentials: true,
});

// 10MB cap on ingestion uploads — small enough to keep a bad file from tying up the process,
// large enough for the CSV exports this v1 targets (per the blueprint, no live connectors yet).
await app.register(multipart, { limits: { fileSize: 10 * 1024 * 1024 } });

app.get("/health", async () => ({ ok: true }));

app.register(async (secured) => {
  secured.addHook("onRequest", authenticate);
  await secured.register(objectsRoutes);
  await secured.register(graphRoutes);
  await secured.register(casesRoutes);
  await secured.register(auditRoutes);
  await secured.register(objectTypesRoutes);
  await secured.register(ingestionRoutes);
  await secured.register(resolutionQueueRoutes);
  await secured.register(adminRoutes);
});

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
