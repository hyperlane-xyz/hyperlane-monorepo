FROM ubuntu:22.04

RUN apt-get update && apt-get install -y ca-certificates curl unzip \
    && rm -rf /var/lib/apt/lists/*

# Official prebuilt leo CLI release (musl static binary, no glibc dependency).
# See https://github.com/ProvableHQ/leo/releases
ARG LEO_RELEASE=leo-lang-v4.3.2
RUN curl --proto '=https' --tlsv1.2 -sSfL \
      -o /tmp/leo.zip \
      "https://github.com/ProvableHQ/leo/releases/download/${LEO_RELEASE}/${LEO_RELEASE}-x86_64-unknown-linux-musl.zip" \
    && unzip /tmp/leo.zip -d /usr/local/bin \
    && chmod +x /usr/local/bin/leo \
    && rm /tmp/leo.zip
