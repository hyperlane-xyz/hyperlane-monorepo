# Solana test validator image for SVM SDK e2e testing.
# Downloads the Agave binary release and runs solana-test-validator.
# Triggered manually via solana-validator-docker.yml workflow_dispatch.

FROM ubuntu:24.04

# When bumping, also update AGAVE_VERSION in src/testing/constants.ts.
ARG AGAVE_VERSION=v3.0.14
ARG AGAVE_SHA256=65614325423316a48f57f1ceeaa91ca78f4516e165e305b38c01873cf8c6b8b4

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fSL "https://github.com/anza-xyz/agave/releases/download/${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
    -o /tmp/solana.tar.bz2 \
    && echo "${AGAVE_SHA256}  /tmp/solana.tar.bz2" | sha256sum -c - \
    && tar jxf /tmp/solana.tar.bz2 -C /opt \
    && rm /tmp/solana.tar.bz2

RUN useradd -m -u 1000 solana
USER 1000

ENV PATH="/opt/solana-release/bin:${PATH}"

EXPOSE 8899

ENTRYPOINT ["solana-test-validator"]
