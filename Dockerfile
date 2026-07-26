FROM node:24.18.0-alpine

ENV HOST=0.0.0.0 \
    NODE_ENV=production \
    PORT=8080

WORKDIR /app
COPY --chown=node:node scripts/grm-relay.mjs ./scripts/grm-relay.mjs

USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:8080/healthz >/dev/null || exit 1

CMD ["node", "scripts/grm-relay.mjs"]
