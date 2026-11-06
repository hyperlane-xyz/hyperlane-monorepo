# syntax=docker/dockerfile:1.7
ARG RUST_BUILDER_IMAGE=docker.io/library/rust:1.98.0-bookworm
ARG RUST_BUILDER_DIGEST_A=82150a52ec202c1b14d7817e14516c39
ARG RUST_BUILDER_DIGEST_B=2bb7f5cfebd88f1ed531cb37ebd39922
ARG DEBIAN_RUNTIME_IMAGE=docker.io/library/debian:bookworm-slim
ARG DEBIAN_RUNTIME_DIGEST_A=734a72b3d6142a71993b4bc580ca01d8
ARG DEBIAN_RUNTIME_DIGEST_B=ca687f77a2c422d96a961d3376b179bc
ARG PYTHON_BUILDER_IMAGE=docker.io/library/python:3.12-bookworm
ARG PYTHON_BUILDER_DIGEST_A=1bc6cb484acf8d7b0393d547ab55c3f1
ARG PYTHON_BUILDER_DIGEST_B=47d641bef8adafbf7dfec5ba4d2d99e0
ARG CURL_DEBIAN_VERSION=8.14.1-2+deb13u2~bpo13+1

FROM ${PYTHON_BUILDER_IMAGE}@sha256:${PYTHON_BUILDER_DIGEST_A}${PYTHON_BUILDER_DIGEST_B} AS python312

FROM ${RUST_BUILDER_IMAGE}@sha256:${RUST_BUILDER_DIGEST_A}${RUST_BUILDER_DIGEST_B} AS build-base
ARG BUILD_JOBS=4
ARG CURL_DEBIAN_VERSION
ENV DEBIAN_FRONTEND=noninteractive \
    CARGO_BUILD_JOBS=${BUILD_JOBS} \
    PATH=/usr/local/cargo/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin
COPY --from=python312 /usr/local /usr/local
RUN printf 'deb http://deb.debian.org/debian bookworm-backports main\n' > /etc/apt/sources.list.d/bookworm-backports.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        build-essential clang cmake libclang-dev "libcurl4=${CURL_DEBIAN_VERSION}" \
        "libcurl4-openssl-dev=${CURL_DEBIAN_VERSION}" libpq-dev \
        libssl-dev make nodejs pkg-config python3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /work
COPY . /work
RUN rustc +1.98.0 --version \
    && cargo +1.98.0 --version \
    && python3 -c 'import sys; assert sys.version_info >= (3, 12), sys.version' \
    && python3 zig/tools/fixture_pack.py restore-locks \
    && python3 zig/tools/native_deps.py --restore-only \
    && cargo +1.98.0 fetch --locked --manifest-path zig/native/rocks/Cargo.toml

FROM build-base AS native-db
RUN python3 zig/tools/native_deps.py --offline --jobs "${BUILD_JOBS}" \
        --target-dir /work/zig/native/rocks/target-container \
        --output /opt/hyperlane-native --format json \
    && ZIG="$(python3 zig/tools/bootstrap.py)" \
    && LIBS="$(python3 -c 'import json; print(json.load(open("/opt/hyperlane-native/manifest.json"))["native_db_libs"])')" \
    && LIBPQ="$(readlink -f "$(pkg-config --variable=libdir libpq)/libpq.so.5")" \
    && GNU_UNWIND="$(readlink -f "$(c++ -print-file-name=libgcc_s.so.1)")" \
    && LIBS="${LIBS},${GNU_UNWIND}" \
    && readelf -h "${LIBPQ}" "${GNU_UNWIND}" \
    && HYPERLANE_CURL_LIBRARY=libcurl.so.4 HYPERLANE_LIBCRYPTO_LIBRARY=libcrypto.so.3 \
        python3 zig/tools/native_http_tests.py --timeout-seconds 3600 -- \
        python3 zig/tools/zig.py --compiler "${ZIG}" build -j4 native-db-test relayer validator \
        -Doptimize=ReleaseSafe "-Dnative-db-libs=${LIBS}" --summary all \
    && python3 zig/tools/zig.py --compiler "${ZIG}" build -j4 scraper \
        -Doptimize=ReleaseSafe "-Dlibpq-library=${LIBPQ}" \
    && python3 zig/tools/container_check.py write-probe --output /tmp/native-runtime-probe.c \
    && cc -O2 -Wall -Wextra -Werror /tmp/native-runtime-probe.c \
        -I/usr/include/postgresql -lcurl -lpq -lcrypto -o /opt/hyperlane-native-runtime-probe

FROM native-db AS native-starknet
RUN python3 zig/src/starknet/testing/locked.py --toolchain 1.98.0 \
    && ZIG="$(python3 zig/tools/bootstrap.py)" \
    && LIBS="$(python3 -c 'import json; print(json.load(open("/opt/hyperlane-native/manifest.json"))["native_db_libs"])')" \
    && GNU_UNWIND="$(readlink -f "$(c++ -print-file-name=libgcc_s.so.1)")" \
    && LIBS="${LIBS},${GNU_UNWIND}" \
    && export HYPERLANE_STARKNET_CRYPTO_LIBRARY=/work/zig/src/starknet/native-crypto/target/release/libziggy_starknet_crypto.so \
        HYPERLANE_CURL_LIBRARY=libcurl.so.4 HYPERLANE_LIBCRYPTO_LIBRARY=libcrypto.so.3 \
    && python3 zig/tools/zig.py --compiler "${ZIG}" test src/starknet_batch_tests.zig -O ReleaseSafe -lc --test-filter Starknet \
    && python3 zig/tools/native_http_tests.py --timeout-seconds 3600 -- \
        python3 zig/tools/zig.py --compiler "${ZIG}" build -j4 native-db-test \
        -Doptimize=ReleaseSafe "-Dnative-db-libs=${LIBS}" --summary all

FROM native-db AS native-aleo
RUN python3 zig/src/aleo/testing/locked.py --toolchain 1.98.0 \
    && ZIG="$(python3 zig/tools/bootstrap.py)" \
    && python3 zig/tools/zig.py --compiler "${ZIG}" build -j4 aleo-vm-worker -Doptimize=ReleaseSafe

FROM native-db AS native-regex
RUN python3 zig/src/ops/tools/locked.py --toolchain 1.98.0

FROM build-base AS migration
RUN cargo +1.98.0 build --locked --release --manifest-path rust/main/Cargo.toml -p migration --bin init-db -j 2

FROM ${DEBIAN_RUNTIME_IMAGE}@sha256:${DEBIAN_RUNTIME_DIGEST_A}${DEBIAN_RUNTIME_DIGEST_B} AS runtime-base
ARG CURL_DEBIAN_VERSION
ENV DEBIAN_FRONTEND=noninteractive
RUN printf 'deb http://deb.debian.org/debian bookworm-backports main\n' > /etc/apt/sources.list.d/bookworm-backports.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates "libcurl4=${CURL_DEBIAN_VERSION}" libpq5 libssl3 libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 hyperlane \
    && useradd --uid 10001 --gid hyperlane --no-create-home --home-dir /var/lib/hyperlane hyperlane \
    && mkdir -p /etc/hyperlane /var/lib/hyperlane /opt/hyperlane/bin /opt/hyperlane/libexec /opt/hyperlane/share/native \
    && chown -R hyperlane:hyperlane /etc/hyperlane /var/lib/hyperlane /opt/hyperlane

FROM runtime-base AS runtime-core
COPY --from=native-db /work/zig/zig-out/bin/relayer /opt/hyperlane/bin/relayer
COPY --from=native-db /work/zig/zig-out/bin/validator /opt/hyperlane/bin/validator
COPY --from=native-db /work/zig/zig-out/bin/scraper /opt/hyperlane/bin/scraper
COPY --from=native-db /opt/hyperlane-native-runtime-probe /opt/hyperlane/libexec/native-runtime-probe
COPY --from=native-db /opt/hyperlane-native/manifest.json /opt/hyperlane/share/native/manifest.json
COPY --from=native-db /opt/hyperlane-native/licenses /opt/hyperlane/share/native/licenses
COPY --from=native-regex /work/zig/src/ops/regex-native/target/release/libziggy_regex.so /opt/hyperlane/lib/libziggy_regex.so
COPY zig/entrypoint.sh /usr/local/bin/hyperlane-entrypoint
RUN chmod 0755 /usr/local/bin/hyperlane-entrypoint /opt/hyperlane/bin/* /opt/hyperlane/libexec/native-runtime-probe
ENV HYPERLANE_ZIG_DEFAULTS=/etc/hyperlane \
    HYPERLANE_CURL_LIBRARY=libcurl.so.4 \
    HYPERLANE_LIBCRYPTO_LIBRARY=libcrypto.so.3 \
    HYPERLANE_REGEX_LIBRARY=/opt/hyperlane/lib/libziggy_regex.so
VOLUME ["/etc/hyperlane", "/var/lib/hyperlane"]
USER 10001:10001
WORKDIR /var/lib/hyperlane
ENTRYPOINT ["/usr/local/bin/hyperlane-entrypoint"]
CMD ["relayer"]
LABEL org.opencontainers.image.title="Hyperlane Zig agents (alpha, core SDK)" \
      org.opencontainers.image.description="Nonroot experimental relayer, validator and scraper; no production configuration or credentials" \
      org.opencontainers.image.base.name="docker.io/library/debian:bookworm-slim"

# Fixture-only migration image; the core runtime never contains init-db.
FROM runtime-base AS migration-image
USER 10001:10001
COPY --from=migration /work/rust/main/target/release/init-db /opt/hyperlane/libexec/init-db

FROM runtime-core AS runtime-starknet
COPY --from=native-starknet /work/zig/src/starknet/native-crypto/target/release/libziggy_starknet_crypto.so /opt/hyperlane/lib/libziggy_starknet_crypto.so
ENV HYPERLANE_STARKNET_CRYPTO_LIBRARY=/opt/hyperlane/lib/libziggy_starknet_crypto.so
LABEL org.opencontainers.image.title="Hyperlane Zig agents (alpha, core + Starknet SDK)"

FROM runtime-core AS runtime-aleo
COPY --from=native-aleo /work/zig/src/aleo/native-crypto/target/release/libziggy_aleo_crypto.so /opt/hyperlane/lib/libziggy_aleo_crypto.so
COPY --from=native-aleo /work/zig/src/aleo/native-vm/target/release/libziggy_aleo_vm.so /opt/hyperlane/lib/libziggy_aleo_vm.so
COPY --from=native-aleo /work/zig/zig-out/bin/hyperlane-aleo-vm-worker /opt/hyperlane/bin/hyperlane-aleo-vm-worker
ENV HYPERLANE_ALEO_CRYPTO_LIBRARY=/opt/hyperlane/lib/libziggy_aleo_crypto.so \
    HYPERLANE_ALEO_VM_LIBRARY=/opt/hyperlane/lib/libziggy_aleo_vm.so \
    HYPERLANE_ALEO_VM_WORKER=/opt/hyperlane/bin/hyperlane-aleo-vm-worker
LABEL org.opencontainers.image.title="Hyperlane Zig agents (alpha, core + Aleo SDK; external proving parameters required)"

FROM runtime-aleo AS runtime-full-sdk
COPY --from=native-starknet /work/zig/src/starknet/native-crypto/target/release/libziggy_starknet_crypto.so /opt/hyperlane/lib/libziggy_starknet_crypto.so
ENV HYPERLANE_STARKNET_CRYPTO_LIBRARY=/opt/hyperlane/lib/libziggy_starknet_crypto.so
LABEL org.opencontainers.image.title="Hyperlane Zig agents (alpha, core + Aleo + Starknet SDK; external proving parameters required)"

# An untargeted build remains the minimal core image; SDK variants are opt-in.
FROM runtime-core AS runtime
