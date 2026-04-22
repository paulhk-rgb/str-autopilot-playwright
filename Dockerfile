# Pinned Playwright base image per spec §2.4 Part R2 (Codex P1-4):
# NEVER use :latest in production. Tag pinned; digest can be pinned via provisioner config.
FROM mcr.microsoft.com/playwright:v1.40.0-jammy AS builder

WORKDIR /app

# Install dependencies first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --ignore-scripts && \
    npm install --no-save typescript@5.6.3 @types/node@20.11.30 @types/express@4.17.21

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc && \
    # prune dev deps
    rm -rf node_modules && \
    npm install --omit=dev --ignore-scripts

# ---- runtime stage ----
FROM mcr.microsoft.com/playwright:v1.40.0-jammy

# Xvfb for headful Chromium — spec Section 2.4 notes headful is preferred to avoid Airbnb
# bot detection. The Playwright base image ships Xvfb + dbus preinstalled.
ENV DISPLAY=:99
ENV NODE_ENV=production

# Non-root user for runtime (the Playwright image ships a `pwuser` with UID 1000).
# Security: avoid running Chromium as root.
WORKDIR /app

# Copy built artifacts and prod-only node_modules from builder
COPY --chown=pwuser:pwuser --from=builder /app/dist ./dist
COPY --chown=pwuser:pwuser --from=builder /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser --from=builder /app/package.json ./package.json

# Persistent Playwright profile directory (Fly volume mount target in prod)
RUN mkdir -p /data/profile && chown -R pwuser:pwuser /data

USER pwuser

EXPOSE 8080

# Launch Xvfb in background, then the Node server.
# No shell script layer; exec form keeps signals (SIGTERM) delivered to Node for graceful shutdown.
CMD ["/bin/sh", "-c", "Xvfb :99 -screen 0 1280x800x24 -nolisten tcp & exec node dist/server.js"]
