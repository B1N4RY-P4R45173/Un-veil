FROM node:22-alpine AS client
WORKDIR /app/client
COPY client/package*.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

# Debian-based image: TensorFlow's native library needs glibc.
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app/server
COPY server/package*.json ./
COPY server/scripts ./scripts
# Installs TensorFlow and downloads the moderation model (postinstall).
RUN npm ci --omit=dev
COPY server/ ./
COPY --from=client /app/client/dist /app/client/dist
USER node
EXPOSE 4000
CMD ["sh", "-c", "node scripts/migrate.js && node scripts/seed.js && node src/index.js"]
