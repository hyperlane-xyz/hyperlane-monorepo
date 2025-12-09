FROM ubuntu:22.04

RUN apt-get update && apt-get install -y build-essential pkg-config libssl-dev clang cmake lld binutils llvm curl

ENV RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:$PATH

RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y

RUN apt-get install -y git

RUN git clone https://github.com/ProvableHQ/leo.git /opt/leo \
    && cd /opt/leo \
    && git checkout feat/leo-devnode \
    && cargo build --release \
    && cp /opt/leo/target/release/leo /usr/local/cargo/bin/
