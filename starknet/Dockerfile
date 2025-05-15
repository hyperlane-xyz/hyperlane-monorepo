FROM rust:1.86

WORKDIR /app

# Create a mount point for the types directory
VOLUME /app/contracts

RUN wget https://github.com/software-mansion/scarb/releases/download/v2.10.1/scarb-v2.10.1-x86_64-unknown-linux-musl.tar.gz
RUN tar -xvzf scarb-v2.10.1-x86_64-unknown-linux-musl.tar.gz
RUN mv scarb-v2.10.1-x86_64-unknown-linux-musl scarb

# Override default entrypoint
ENTRYPOINT []

# Use shell form of CMD
CMD ["/bin/sh", "-c", "\
    git clone --depth 1 --branch v0.3.2 https://github.com/hyperlane-xyz/hyperlane_starknet && \
    cd hyperlane_starknet/cairo && \
    /app/scarb/bin/scarb build && \
    cp -r target/dev/* /app/contracts && \
    cd ../.. && \
    rm -r hyperlane_starknet"]
