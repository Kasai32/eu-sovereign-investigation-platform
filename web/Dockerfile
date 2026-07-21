# Vite bakes VITE_* env vars into the static bundle at build time, not runtime — build args
# below must be the actual public URL the browser will use (the deploy script passes the
# tunnel's URL), not a placeholder to swap later.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
ARG VITE_API_URL
ARG VITE_KEYCLOAK_URL
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_KEYCLOAK_URL=${VITE_KEYCLOAK_URL}
RUN npm run build

# Caddy serves the built static app AND reverse-proxies /api and Keycloak's paths, all from one
# origin/port — the single thing the tunnel needs to expose. This also means the browser talks
# to everything same-origin (no CORS to configure for the tunnel's rotating hostname).
FROM caddy:2-alpine
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
