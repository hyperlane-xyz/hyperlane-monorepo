# Solana test validator image for SVM SDK e2e testing.
# Downloads the Agave binary release and runs solana-test-validator.
# Triggered manually via solana-validator-docker.yml workflow_dispatch.

FROM ubuntu:24.04

ARG AGAVE_VERSION=v3.0.14

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl bzip2 \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fSL "https://github.com/anza-xyz/agave/releases/download/${AGAVE_VERSION}/solana-release-x86_64-unknown-linux-gnu.tar.bz2" \
    -o /tmp/solana.tar.bz2 \
    && tar jxf /tmp/solana.tar.bz2 -C /opt \
    && rm /tmp/solana.tar.bz2

ENV PATH="/opt/solana-release/bin:${PATH}"

EXPOSE 8899

ENTRYPOINT ["solana-test-validator"]
