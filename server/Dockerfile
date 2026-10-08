# harness-server image. Build context: the repository root, so the client modules the server reuses are available.
#   docker build -f server/Dockerfile -t harness-server:local .
# (deploy/harness-server/docker-compose.yml builds it the same way.) server/Dockerfile.dockerignore limits the context.

# The reused client modules (hashing, signatures, release checks) import only node: modules, so no npm package
# reaches the image.
FROM node:24-slim
# Every image of this service carries the label, the rollback tag included, so a cleanup that filters on it keeps them:
#   docker image prune -a --filter 'label!=moe.nymiro.keep=true'   (deploy/README.md, 第 4 节)
LABEL moe.nymiro.keep="true"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY harness/package.json harness/package.json
# Exactly the client files the server loads at run time; test/dockerfile.test.ts keeps this list in step with the imports.
COPY harness/src/app-release.ts harness/src/file-hash.ts harness/src/managed-pack-update.ts harness/src/official.ts harness/src/pack-hash.ts harness/src/
COPY harness/src/shared/sharing.ts harness/src/shared/candidate-report.ts harness/src/shared/
COPY server/package.json server/package.json
COPY server/src server/src
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
CMD ["node", "server/src/main.ts"]
