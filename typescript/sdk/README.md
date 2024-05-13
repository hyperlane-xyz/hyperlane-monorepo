# Hyperlane SDK

The Hyperlane SDK helps developers create and manage interchain applications.

For more details on Hyperlane concepts, [see the documentation](https://docs.hyperlane.xyz)

## Install

```bash
# Install with NPM
npm install @hyperlane-xyz/sdk

# Or with Yarn
yarn add @hyperlane-xyz/sdk
```

Note, this package uses [ESM Modules](https://gist.github.com/sindresorhus/a39789f98801d908bbc7ff3ecc99d99c#pure-esm-package)

## Contents

### Constants

The names and relevant metadata for all Hyperlane-supported chains are included in this SDK, including public RPC and Explorer urls. It also includes the addresses for all Hyperlane core contracts and middleware.

### Classes for development, deployment, and testing

The SDK includes various classes for building, deploying, and testing multi-chain applications. Different abstractions serve different use cases. A few common utilities include:

- `MultiProvider` / `MultiProtocolProvider`: A utility for managing chain metadata, and RPC providers.
- `HyperlaneApp` / `MultiProtocolApp`: A base to extend for a multi-chain app.
- `HyperlaneCore` / `MultiProtocolCore`: A class for common interactions with Hyperlane core deployments.
- `HyperlaneDeployer`: The base class for executing multi-chain contract deployments.
- `Token` & `WarpCore`: Utilities for interacting with Warp Route deployments.

### Chain Logos

The SDK contains SVG files for all Hyperlane-supported chains. They can be imported from the `/logos` folder.

```js
import ArbitrumBlack from '@hyperlane-xyz/sdk/logos/black/arbitrum.svg';
import ArbitrumColor from '@hyperlane-xyz/sdk/logos/color/arbitrum.svg';
```

## License

Apache 2.0
