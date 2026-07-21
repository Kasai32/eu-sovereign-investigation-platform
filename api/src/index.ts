import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
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

const MULTIPART_FILE_SIZE_LIMIT = 10 * 1024 * 1024; // 10MB, see the multipart registration below

// Global cap on request body size, set above the multipart file limit so CSV uploads aren't
// rejected before @fastify/multipart's own (more specific) limit ever gets a chance to apply.
const app = Fastify({ logger: true, bodyLimit: MULTIPART_FILE_SIZE_LIMIT + 1024 * 1024 });

await app.register(helmet);

// CORS origin is a comma-separated allowlist from config, never a wildcard — this API sits in
// front of classified data, and a wildcard origin plus credentials:true would let any site read
// an authenticated user's responses via their browser.
const allowedOrigins = (process.env.WEB_ORIGIN ?? "http://localhost:3000").split(",").map((o) => o.trim());
await app.register(cors, {
  origin: allowedOrigins,
  credentials: true,
});

// Global default; per-route limits (e.g. tighter on /ingestion/runs) are a natural next step
// once real usage patterns exist to tune against, not guessed at now.
await app.register(rateLimit, { max: 300, timeWindow: "1 minute" });

// 10MB cap on ingestion uploads — small enough to keep a bad file from tying up the process,
// large enough for the CSV exports this v1 targets (per the blueprint, no live connectors yet).
await app.register(multipart, { limits: { fileSize: MULTIPART_FILE_SIZE_LIMIT } });

app.get("/health", { config: { rateLimit: false } }, async () => ({ ok: true }));

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
