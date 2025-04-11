FROM golang:1.22

WORKDIR /app

# install latest updates
RUN apt update && apt upgrade -y

# install hypd
RUN git clone --depth 1 --branch v1.0.0-beta0 https://github.com/bcp-innovations/hyperlane-cosmos.git \
    && cd hyperlane-cosmos \
    && make build-simapp \
    && mv build/hypd /app \
    && /app/hypd init-sample-chain \
    && cd .. \
    && rm -r hyperlane-cosmos

# rpc
EXPOSE 26657
# api
EXPOSE 1317

CMD ["/app/hypd", "start"]
