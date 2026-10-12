# Build from the repository root:
#   docker build -f relay/Dockerfile -t dropovpn-relay .
FROM node:24-alpine
WORKDIR /app
COPY electron/websocket.mjs electron/mux.mjs electron/
COPY relay/server.mjs relay/
ENV NODE_ENV=production PORT=8080
USER node
EXPOSE 8080
CMD ["node", "relay/server.mjs"]
