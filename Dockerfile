# Multi-stage build: compile TS then run
FROM node:20-alpine AS build
WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci --only=production || npm i

# Install dev deps for build
COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime image
FROM node:20-alpine AS runtime
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./package.json
RUN npm ci --omit=dev

ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
