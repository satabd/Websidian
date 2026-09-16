FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# WEBSIDIAN_CONFIG is the current name; MD2HTML_CONFIG still works as an alias.
ENV NODE_ENV=production PORT=8080 WEBSIDIAN_CONFIG=/config/websidian.config.json
EXPOSE 8080
VOLUME ["/vaults", "/config", "/app/.cache"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/_health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/server.js"]
