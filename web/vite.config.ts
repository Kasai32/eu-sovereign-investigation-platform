import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Vite's dev server otherwise refuses to serve files outside this project's own root (its
// fs.allow default) — shared/ (PRD v1.1 N5's request/response schemas, imported by
// src/lib/api/*.ts) lives one level up, at the repo root.
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    strictPort: true,
    fs: { allow: [repoRoot] },
  },
});
