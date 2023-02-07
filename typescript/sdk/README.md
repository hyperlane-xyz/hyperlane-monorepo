# Hyperlane SDK

The Hyperlane SDK helps developers create and manage interchain applications.

For details on how to use the various abstractions and utilities, [see the documentation](https://docs.hyperlane.xyz/docs/sdks/building-applications)

## Install

`yarn install @hyperlane-xyz/sdk`

## Contents

### Constants

The names and relevant metadata for all Hyperlane-supported chains are included in this SDK, including public RPC and Explorer urls. It also includes the addresses for all Hyperlane core contracts and middleware.

### Deployment, testing, and development classes

Classes for deploying, testing, and building applications using Hyperlane are included in the SDK. See [the docs](https://docs.hyperlane.xyz/docs/sdks/building-applications/nodejs-sdk) for details.

### Chain Logos

The SDK contains SVG files for all Hyperlane-supported chains. They can be imported from the `/logos` folder.

```js
import ArbitrumBlack from '@hyperlane-xyz/sdk/logos/black/arbitrum.svg';
import ArbitrumColor from '@hyperlane-xyz/sdk/logos/color/arbitrum.svg';
```

## License

Apache 2.0
