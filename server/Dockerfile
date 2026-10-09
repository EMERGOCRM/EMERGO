# Build + runtime del API y del frontend estático.
# El contexto de build es la RAÍZ del proyecto (ver docker-compose.yml).

FROM node:20-alpine AS build
WORKDIR /app/server
COPY server/package.json ./
RUN npm install
COPY server/tsconfig.json ./
COPY server/scripts ./scripts
COPY server/src ./src
RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app/server
ENV NODE_ENV=production
COPY server/package.json ./
RUN npm install --omit=dev
COPY --from=build /app/server/dist ./dist

# Frontend estático (index.html + assets) servido por el mismo servicio.
COPY index.html /app/public/index.html
COPY assets /app/public/assets
ENV STATIC_DIR=/app/public

EXPOSE 3000
CMD ["node", "dist/index.js"]
