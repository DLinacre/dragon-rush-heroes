# Dragon Ball Heroes — production image.
#
# The application has zero runtime dependencies, so there is no install step:
# the image is the Node runtime plus source. That keeps it small, makes cold
# starts fast, and removes the entire npm supply-chain surface from production.
FROM node:20-alpine

WORKDIR /app

# Run as an unprivileged user (the node image ships one).
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DATA_DIR=/app/.data

# Persist the write-ahead log and snapshots across container restarts.
RUN mkdir -p /app/.data && chown -R node:node /app/.data
VOLUME /app/.data

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1

# SESSION_SECRET and GACHA_SECRET must be injected at runtime; the process
# deliberately refuses to boot in production without them.
CMD ["node", "server/index.js"]
