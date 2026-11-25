FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM node:24-slim AS app
# What reads PDF, Word and spreadsheet attachments.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates poppler-utils unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/bin bin
COPY --from=build /app/dist dist
COPY --from=build /app/frontend/dist frontend/dist
RUN ln -s /app/bin/tabellar.js /usr/local/bin/tabellar && mkdir /data && chown node:node /data
ENV TABELLAR_HOME=/data

# A Tabellar+ server: the disk it is given belongs to root, so it is handed over
# before Tabellar starts as node. It begins from a `tabellar move` file if one is there.
FROM app AS hosted
CMD ["sh", "-c", "chown node: /data && [ ! -f /data/tabellar.move ] || set -- /data/tabellar.move; exec setpriv --reuid=node --regid=node --init-groups tabellar serve \"$@\"", "serve"]

# The Tabellar+ service (plus/README.md).
FROM node:24-slim AS plus
WORKDIR /app
COPY package.json ./
COPY plus plus
CMD ["node", "plus/server.ts"]

FROM app
VOLUME /data
USER node
CMD ["tabellar", "serve"]
