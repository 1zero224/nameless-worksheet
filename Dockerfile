FROM node:24-bookworm-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@12.15.0 --activate

FROM base AS build
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm build
RUN pnpm --filter @nw/server deploy --prod --legacy /app/server

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV WEB_DIST_DIR=/app/web-dist

COPY --from=build /app/server /app
COPY --from=build /repo/apps/server/dist /app/dist
COPY --from=build /repo/apps/server/drizzle /app/drizzle
COPY --from=build /repo/apps/web/dist /app/web-dist

RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/main.js"]
