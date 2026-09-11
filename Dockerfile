# Stage 1: Build TypeScript Backend
FROM node:22-alpine AS builder

WORKDIR /app/backend
COPY backend/package*.json ./
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npx tsc

# Stage 2: Production Runtime
FROM node:22-alpine AS runner

WORKDIR /app

# Install required system packages:
# - iputils: for icmp ping
# - ca-certificates & curl: to download and install Russian Trusted Root CA for MAX Bot API
RUN apk add --no-cache iputils curl ca-certificates && \
    curl -k -fsSL -o /usr/local/share/ca-certificates/russian_trusted_root_ca.crt \
    https://gu-st.ru/content/lending/russian_trusted_root_ca_pem.crt 2>/dev/null || true && \
    update-ca-certificates 2>/dev/null || true

# Set Node to trust the Russian Root CA for MAX messenger
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/russian_trusted_root_ca.crt \
    NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/data

# Copy production node_modules and built server files
COPY --from=builder /app/backend/node_modules ./backend/node_modules
COPY --from=builder /app/backend/dist ./backend/dist
COPY --from=builder /app/backend/package*.json ./backend/

# Copy frontend static assets
COPY frontend ./frontend

# Create persistent data directory
RUN mkdir -p /app/data

VOLUME ["/app/data"]
EXPOSE 3000

WORKDIR /app/backend
CMD ["node", "dist/server.js"]
