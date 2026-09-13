# Single container, no browser, no sandbox (DESIGN.md rev 3). Snapshots are baked in.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm install --no-save tsx@4
COPY src ./src
COPY snapshots ./snapshots
ENV HOST=0.0.0.0 PORT=3000 SNAPSHOTS_DIR=/app/snapshots
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
CMD ["npx", "tsx", "src/main.ts"]
