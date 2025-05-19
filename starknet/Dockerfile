FROM rust:1.86

WORKDIR /app

# Create a mount point for the types directory
VOLUME /app/release

RUN wget https://github.com/software-mansion/scarb/releases/download/v2.10.1/scarb-v2.10.1-x86_64-unknown-linux-musl.tar.gz
RUN tar -xvzf scarb-v2.10.1-x86_64-unknown-linux-musl.tar.gz
RUN mv scarb-v2.10.1-x86_64-unknown-linux-musl scarb

# Override default entrypoint
ENTRYPOINT []

# Use shell form of CMD
CMD ["/bin/sh", "-c", "\
    git clone --depth 1 --branch v0.3.2 https://github.com/hyperlane-xyz/hyperlane-starknet && \
    cd hyperlane-starknet/cairo && \
    /app/scarb/bin/scarb build && \
    cp -r target/dev/* /app/release && \
    cd ../.. && \
    rm -r hyperlane-starknet"]
