FROM node:22-alpine AS base
RUN corepack enable pnpm

# Build stage
FROM base AS builder
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# Production stage
FROM node:22-alpine AS runner
RUN corepack enable pnpm
WORKDIR /app

COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0

EXPOSE 3000

# Mount your OpenClaw config via volume:
# docker run -v ~/.openclaw:/root/.openclaw ...
# Or set OPENCLAW_CONFIG_PATH env var.

CMD ["node", "dist/index.js"]
