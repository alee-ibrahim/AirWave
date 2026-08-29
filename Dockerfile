FROM node:26.8.1-bookworm-slim

# ffmpeg does the WebM/Opus -> HLS/AAC muxing.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

# pnpm via corepack (version pinned by package.json "packageManager").
# Node 26 no longer bundles corepack, so install it from npm first.
RUN npm install -g corepack@latest && corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

COPY server.js ./
COPY public ./public

ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
