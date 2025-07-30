# Hyperlane

https://github.com/hyperlane-xyz/hyperlane-monorepo/blob/main/README.md

```

Maintenance
    (in root)
        # recommend node v20^
        yarn install # crucial to also download turbo tool
        yarn build
        yarn clean
        yarn lint
    (in rust/main and rust/sealevel)
        cargo build

Testing
    Global (everything, to ensure no regressions, and correct merges/rebases etc)
        (in root)
            yarn test
        (in rust/main and rust/sealevel)
            cargo test
    Our stuff (our new logic, contracts etc)
        yarn test:forge --match-contract HypERC20MemoTest
        yarn test:forge --match-contract HypERC20CollateralMemoTest
        yarn test:forge --match-contract HypNativeMemoTest
        cargo test --test functional

Notes
    Ethereum
        HypERC20 = Synthetic
        HypERC20Collateral = Collateral
        HypNative = Native
    Solana
        hyperlane-sealevel-token = Synthetic
        hyperlane-sealevel-token-collateral = Collateral
        hyperlane-sealevel-token-native = Native

Change list
    Ethereum
        Copied HypERC20 and modified to include memo in transferFromSender
        Copied test for HypERC20 and added memo check
        Copied HypNative and modified to include memo in transferFromSender
        Copied test for HypNative and added memo check
        Extended HypERC20Collateral with override to include memo in transferFromSender
        Copied test for HypeERC20Collateral and added memo check
    Solana
        Added hyperlane-sealevel-token-native-memo
        Added hyperlane-sealevel-token-collateral-memo
        Added hyperlane-sealevel-token-memo

How to work on the typescript CLI (locally):
    The CLI depends on the SDK, so first do yarn build from typescript/sdk, and only then will yarn build from typescript/cli work
    How to rebuild and reinstall?
        # in top level (hyperlane-monorepo)
        yarn clean; yarn build; # CLEAN IS VERY IMPORTANT!
        #in typescript/cli
        npm uninstall -g @hyperlane-xyz/cli;
        yarn install
        yarn build
        yarn bundle
        npm install -g
        hyperlane --version

How to get the typescript CLI (our fork)
  TODO:

How to build rust agents:
    cd rust/main
    cargo build --release --bin relayer
    cargo build --release --bin validator
    TODO: scraper

How to manage solana versions:
    # Several versions needed
    # v1.14.20 for building programs,  v2 for launching a local node, v1.18.18 for deploying programs

    # initial install
    curl --proto '=https' --tlsv1.2 -sSfL https://solana-install.solana.workers.dev | bash
    # then agave-install or solana-install
    solana-install init v1.18.18
    solana-install init v1.14.20
    sh -c "$(curl -sSfL https://release.anza.xyz/v2.2.13/install)"


```
