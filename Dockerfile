FROM node:24-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY frontend/package.json frontend/
RUN npm ci
COPY . .
RUN npm run build && npm run build:server

FROM node:24-slim
# What reads PDF, Word and spreadsheet attachments.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates poppler-utils unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/bin bin
COPY --from=build /app/dist dist
COPY --from=build /app/frontend/dist frontend/dist
RUN ln -s /app/bin/tabellar.js /usr/local/bin/tabellar && mkdir /data && chown node:node /data
ENV TABELLAR_HOME=/data
VOLUME /data
USER node
CMD ["tabellar", "serve"]
