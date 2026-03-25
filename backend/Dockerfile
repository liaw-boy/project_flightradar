# ── Stage 1: Build Frontend ───────────────────────────────────────────────────
FROM node:24-alpine AS frontend-builder
WORKDIR /client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
# Output goes to /public-react (vite outDir: '../public-react')
RUN npm run build

# ── Stage 2: Backend Runtime ──────────────────────────────────────────────────
FROM node:24-alpine
WORKDIR /app

# Install production dependencies only
COPY backend/package*.json ./
RUN npm ci --omit=dev

# Copy backend source
COPY backend/ ./

# Copy root scripts for data seeding
COPY scripts/ /app/scripts-root/

# Copy built frontend from Stage 1
# __dirname is /app, so path.join(__dirname, '..', 'public-react') = /public-react
COPY --from=frontend-builder /public-react /public-react

EXPOSE 3000
CMD ["node", "server.js"]
