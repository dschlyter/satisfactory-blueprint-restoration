FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY src/ src/

ENTRYPOINT ["node", "src/index.mjs"]
