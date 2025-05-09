FROM golang:1.22

WORKDIR /app

# install latest updates and clean up
RUN apt update && apt upgrade -y \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Define a build argument for the branch name
ARG BRANCH_NAME=v1.0.0

# install hypd from the specified branch
RUN git clone --depth 1 --branch $BRANCH_NAME https://github.com/bcp-innovations/hyperlane-cosmos.git \
    && cd hyperlane-cosmos \
    && make build-simapp \
    && mv build/hypd /app \
    && /app/hypd init-sample-chain \
    && cd .. \
    && rm -rf hyperlane-cosmos

# rpc
EXPOSE 26657
# api
EXPOSE 1317

CMD ["/app/hypd", "start"]
