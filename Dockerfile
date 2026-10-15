FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run typecheck && npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3001 DATABASE_PATH=/data/team.sqlite
WORKDIR /app
RUN groupadd --gid 10001 team && useradd --uid 10001 --gid team --no-create-home team && mkdir /data && chown team:team /data
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/migrations ./migrations
USER 10001:10001
EXPOSE 3001
CMD ["node", "dist-server/server/main.js"]
