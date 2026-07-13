FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci && npm install -g serve
COPY src/ src/
COPY web/ web/
RUN node web/build.mjs

ENTRYPOINT ["node", "src/index.mjs"]
