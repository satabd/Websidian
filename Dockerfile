FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=8080 MD2HTML_CONFIG=/config/md2html.config.json
EXPOSE 8080
VOLUME ["/vaults", "/config", "/app/.cache"]
CMD ["node", "src/server.js"]
