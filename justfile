run-polymer-test-relayer:
    cd rust/main/agents/relayer && cargo build
    rust/main/target/debug/relayer

build-relayer-docker:
    docker build -t hyperlane-polymer-relayer:latest -f docker/relayer.dockerfile rust/
