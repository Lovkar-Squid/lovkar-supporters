FROM node:22-alpine

# Small, production-only image
ENV NODE_ENV=production
WORKDIR /app

# Install deps first for better layer caching
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

# App source
COPY server.js ./
COPY public ./public

# Data lives on a volume so it survives container recreation
RUN mkdir -p /data && chown -R node:node /app /data
VOLUME ["/data"]

ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080

USER node

HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
