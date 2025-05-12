# Build image for the OffchainLookupServer server
FROM node:20 AS build

# Enalbed correct yarn version
RUN corepack enable && corepack prepare yarn@4.5.1 --activate

# Setup Typescript monorepo
WORKDIR /app

COPY yarn.lock .
COPY package.json .
COPY tsconfig.json .
COPY typescript/ ./typescript
COPY .yarn/ ./.yarn

RUN yarn install

# TODO: workaroud
RUN yarn config set nodeLinker node-modules

# Build actual server
WORKDIR /app/typescript/ccip-server
RUN yarn install
RUN yarn build-prod

# Output gets written to dist/.

# Actual run-image for the OffchainLookupServer server
#FROM node:20-slim AS runtime

# RUN apk add --no-cache bash

# Copy compiled server js file
#WORKDIR /app
#COPY --from=build /app/typescript/ccip-server/dist ./dist

# Start server at 8080
EXPOSE 8080
CMD ["node", "dist/server.js"]
