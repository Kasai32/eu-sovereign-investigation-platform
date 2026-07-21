FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# Same entry point as the "start" script (tsx, no separate build step) — this image runs
# exactly what a developer runs locally, not a parallel production-only path.
ENV PORT=3001
EXPOSE 3001
CMD ["npm", "start"]
