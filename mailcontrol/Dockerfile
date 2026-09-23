FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig*.json vite.config.ts ./
COPY web ./web
COPY server ./server
COPY shared ./shared
RUN npm run build

FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-fund --no-audit && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY db ./db
RUN chmod 644 package.json package-lock.json && chmod -R a+rX dist db
USER node
EXPOSE 3000
CMD ["node", "dist/server/main.js"]
