# Build Stage
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies (including devDependencies needed for build)
RUN npm ci

# Copy source code
COPY . .

# Build the NestJS application
RUN npm run build

# Prune development dependencies to keep production ones only
RUN npm prune --omit=dev

# Runner Stage
FROM node:22-alpine AS runner

# Install curl for Coolify/Docker health checks
RUN apk add --no-cache curl

WORKDIR /app

# Set environment variables
ENV NODE_ENV=production
ENV PORT=3001
ENV AWS_SDK_JS_SUPPRESS_NODE_JS_WARNING=1

# Copy only production dependencies and built files from builder with correct ownership
COPY --from=builder --chown=node:node /app/package*.json ./
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist

# Switch to non-root user
USER node

# Expose the application port
EXPOSE 3001

# Health check using curl (note the /api prefix for NestJS)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3001/api || exit 1

# Start the application
CMD ["node", "dist/main"]
