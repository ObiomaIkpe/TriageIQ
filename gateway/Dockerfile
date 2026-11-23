# Stage 1: build with dev dependencies (Nest CLI, TypeScript).
FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build

# Stage 2: production dependencies only.
FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Stage 3: slim runtime, non-root, compiled app only.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
# The operator script that creates API client keys on the server (deploy/README.md): node scripts/make-client-key.ts <name> <role>.
# Node strips the types, so the two source files are copied as they are. The script only prints; it reads no config and writes no file.
COPY scripts/make-client-key.ts ./scripts/make-client-key.ts
COPY src/auth/client-key.ts ./src/auth/client-key.ts
COPY package.json ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
