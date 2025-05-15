# Build stage
FROM rust:1.76-slim-bullseye as builder

WORKDIR /build

# Install build dependencies including OpenSSL dev packages, pkg-config, and libclang
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
    pkg-config \
    libssl-dev \
    clang \
    libclang-dev \
    make \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Copy the Rust code
COPY . .

# Build the relayer binary
RUN cd main/agents/relayer && cargo build --release

# Final stage
FROM debian:bullseye-slim

# Install runtime dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends ca-certificates libssl-dev && \
    rm -rf /var/lib/apt/lists/*

# Create app directory structure
WORKDIR /app
RUN mkdir -p config

# Copy the built binary from the builder stage
COPY --from=builder /build/main/target/release/relayer /app/relayer

# Set executable permissions
RUN chmod +x /app/relayer

# Command to run
ENTRYPOINT ["/app/relayer"]