import Fastify from "fastify";
import { authenticate } from "./auth.js";
import objectsRoutes from "./routes/objects.js";
import graphRoutes from "./routes/graph.js";
import casesRoutes from "./routes/cases.js";
import auditRoutes from "./routes/audit.js";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true }));

app.register(async (secured) => {
  secured.addHook("onRequest", authenticate);
  await secured.register(objectsRoutes);
  await secured.register(graphRoutes);
  await secured.register(casesRoutes);
  await secured.register(auditRoutes);
});

const port = Number(process.env.PORT ?? 3001);
app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
