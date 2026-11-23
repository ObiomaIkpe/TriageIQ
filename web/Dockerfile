# The web UI as a static site. Stage 1 builds it with Node; stage 2 is a small non-root nginx that only serves files.
#
# VITE_TURNSTILE_SITE_KEY is the PUBLIC Cloudflare Turnstile site key (it is visible in every page that loads the widget):
# it is a build argument, not a secret. It is baked into the JavaScript at build time, so a different key means a new image.
#   docker build --build-arg VITE_TURNSTILE_SITE_KEY=0x4AAAA... -t triageiq-web ./web
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY index.html tsconfig.json vite.config.ts ./
COPY src ./src
ARG VITE_TURNSTILE_SITE_KEY=
ENV VITE_TURNSTILE_SITE_KEY=${VITE_TURNSTILE_SITE_KEY}
RUN npm run build

# nginx-unprivileged: the official nginx image built to run as a non-root user (uid 101) on port 8080, with no capabilities needed.
FROM nginxinc/nginx-unprivileged:1.29-alpine
COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY nginx/security-headers.conf /etc/nginx/security-headers.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1
