# Optional: run the proxy and the manual together in a container.
# Build from the repository root:  docker build -f proxy/Dockerfile -t manuel .
# Run:  docker run -p 8787:8787 -e GEMINI_API_KEY=... manuel
FROM node:22-alpine
WORKDIR /app
COPY index.html ./
COPY manuel ./manuel
COPY img ./img
COPY res ./res
COPY proxy/package.json proxy/server.js ./proxy/
COPY proxy/src ./proxy/src
WORKDIR /app/proxy
ENV STATIC_DIR=.. PORT=8787
EXPOSE 8787
USER node
CMD ["node", "server.js"]
