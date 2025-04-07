FROM bufbuild/buf:1.50.1 as BUILDER
FROM node:20-alpine

RUN npm install -g ts-proto@v1.181.2

COPY --from=BUILDER /usr/local/bin /usr/local/bin

# Inject user id and group id to avoid permission issues when running as a root user
ARG USER_ID=1000
ARG USER_GID=1000

# Create group if it doesn't exist
RUN if ! getent group $USER_GID; then \
    addgroup -g $USER_GID mygroup; \
    fi

# Create user if it doesn't exist
RUN if ! getent passwd $USER_ID; then \
    adduser -D -u $USER_ID -G $(getent group $USER_GID | cut -d: -f1) myuser; \
    fi

RUN apk add --no-cache git openssh-client

WORKDIR /app

COPY buf.gen.yaml ./

# Create a mount point for the types directory
VOLUME /app/types

# Override default entrypoint
ENTRYPOINT []

# Use shell form of CMD
CMD ["/bin/sh", "-c", "\
    set -eo pipefail && \
    git clone --depth 1 https://github.com/bcp-innovations/hyperlane-cosmos.git && \
    cp -rf hyperlane-cosmos/proto/* ./ && \
    rm -rf hyperlane-cosmos && \
    buf generate && \
    rm -rf ./types/amino*"]