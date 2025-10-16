# Hyperlane Tokens and Warp Routes

This repo contains contracts and SDK tooling for Hyperlane-connected ERC20 and ERC721 tokens. The contracts herein can be used to create [Hyperlane Warp Routes](https://docs.hyperlane.xyz/docs/reference/applications/warp-routes) across different chains.

For instructions on deploying Warp Routes, see [the deployment documentation](https://docs.hyperlane.xyz/docs/deploy-hyperlane#deploy-a-warp-route) and the [Hyperlane CLI](https://www.npmjs.com/package/@hyperlane-xyz/cli).

## Warp Route Architecture

A Warp Route is a collection of [`TokenRouter`](./libs/TokenRouter.sol) contracts deployed across a set of Hyperlane chains. These contracts leverage the `Router` pattern to implement access control and routing logic for remote token transfers. These contracts send and receive [`Messages`](./libs/TokenMessage.sol) which encode payloads containing a transfer `amount` and `recipient` address.

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph LR
    subgraph "Ethereum"
        HYP_E[TokenRouter]
        style HYP_E fill:orange
        Mailbox_E[(Mailbox)]
    end

    subgraph "Polygon"
        HYP_P[TokenRouter]
        style HYP_P fill:orange
        Mailbox_P[(Mailbox)]
    end


    subgraph "Gnosis"
        HYP_G[TokenRouter]
        style HYP_G fill:orange
        Mailbox_G[(Mailbox)]
    end

    HYP_E -. "TokenMessage" .- HYP_P -. "TokenMessage" .- HYP_G

```

The Token Router contract comes in several flavors and a warp route can be composed of a combination of these flavors.

- [`Native`](./HypNative.sol) - for warping native assets (e.g. ETH) from the canonical chain
- [`Collateral`](./HypERC20Collateral.sol) - for warping tokens, ERC20 or ERC721, from the canonical chain
- [`Synthetic`](./HypERC20.sol) - for representing tokens, Native/ERC20 or ERC721, on a non-canonical chain

## Interchain Security Models

Warp routes are unique amongst token bridging solutions because they provide modular security. Because the `TokenRouter` implements the `IMessageRecipient` interface, it can be configured with a custom interchain security module. Please refer to the relevant guide to specifying interchain security modules on the [Messaging API receive docs](https://docs.hyperlane.xyz/docs/reference/messaging/messaging-interface).

## Remote Transfer Lifecycle

To initiate a remote transfer, users call the `TokenRouter.transferRemote` function with the `destination` chain ID, `recipient` address, and transfer `amount`.

```solidity
interface TokenRouter {
  function transferRemote(
    uint32 destination,
    bytes32 recipient,
    uint256 amount
  ) public returns (bytes32 messageId);
}
```

**NOTE:** The [Relayer](https://docs.hyperlane.xyz/docs/operate/relayer/run-relayer) shown below must be compensated. Please refer to the details on [paying for interchain gas](https://docs.hyperlane.xyz/docs/protocol/interchain-gas-payment).

Depending on the flavor of TokenRouter on the source and destination chain, this flow looks slightly different. The following diagrams illustrate these differences.

### Transfer Alice's `amount` native ETH from Ethereum to Bob on Polygon

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph TB
    Bob((Bob))
    style Bob fill:black
    Alice((Alice))
    style Alice fill:black

    Relayer([Relayer])

    subgraph "Ethereum"
        HYP_E[NativeTokenRouter]
        style HYP_E fill:orange
        Mailbox_E[(Mailbox)]
    end

    Alice == "transferRemote(Polygon, Bob, amount)\n{value: amount}" ==> HYP_E
    linkStyle 0 color:green;
    HYP_E -- "dispatch(Polygon, (Bob, amount))" --> Mailbox_E

    subgraph "Polygon"
        HYP_P[SyntheticTokenRouter]
        style HYP_P fill:orange
        Mailbox_P[(Mailbox)]
    end

    Mailbox_E -. "indexing" .-> Relayer

    Relayer == "process(Ethereum, (Bob, amount))" ==> Mailbox_P
    Mailbox_P -- "handle(Ethereum, (Bob, amount))" --> HYP_P

    HYP_E -. "router" .- HYP_P

    HYP_P -- "mint(Bob, amount)" --> Bob
    linkStyle 6 color:green;
```

### Transfer Alice's ERC20 `amount` from Ethereum to Bob on Polygon

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph TB
    Alice((Alice))
    Bob((Bob))
    style Alice fill:black
    style Bob fill:black

    Relayer([Relayer])

    subgraph "Ethereum"
        Token_E[ERC20]
        style Token_E fill:green
        HYP_E[CollateralTokenRouter]
        style HYP_E fill:orange
        Mailbox_E[(Mailbox)]
    end

    Alice == "approve(CollateralTokenRouter, infinity)" ==> Token_E
    Alice == "transferRemote(Polygon, Bob, amount)" ==> HYP_E
    Token_E -- "transferFrom(Alice, amount)" --> HYP_E
    linkStyle 2 color:green;
    HYP_E -- "dispatch(Polygon, (Bob, amount))" --> Mailbox_E

    subgraph "Polygon"
        HYP_P[SyntheticRouter]
        style HYP_P fill:orange
        Mailbox_P[(Mailbox)]
    end

    Mailbox_E -. "indexing" .-> Relayer

    Relayer == "process(Ethereum, (Bob, amount))" ==> Mailbox_P
    Mailbox_P -- "handle(Ethereum, (Bob, amount))" --> HYP_P

    HYP_E -. "router" .- HYP_P
    HYP_P -- "mint(Bob, amount)" --> Bob
    linkStyle 8 color:green;
```

### Transfer Alice's `amount` synthetic MATIC from Ethereum back to Bob as native MATIC on Polygon

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "white"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph TB
    Bob((Bob))
    style Bob fill:black
    Alice((Alice))
    style Alice fill:black

    Relayer([Relayer])

    subgraph "Ethereum"
        HYP_E[SyntheticTokenRouter]
        style HYP_E fill:orange
        Mailbox_E[(Mailbox)]
    end

    Alice == "transferRemote(Polygon, Bob, amount)" ==> HYP_E
    Alice -- "burn(Alice, amount)" --> HYP_E
    linkStyle 1 color:green;
    HYP_E -- "dispatch(Polygon, (Bob, amount))" --> Mailbox_E

    subgraph "Polygon"
        HYP_P[NativeTokenRouter]
        style HYP_P fill:orange
        Mailbox_P[(Mailbox)]
    end

    Mailbox_E -. "indexing" .-> Relayer

    Relayer == "process(Ethereum, (Bob, amount))" ==> Mailbox_P
    Mailbox_P -- "handle(Ethereum, (Bob, amount))" --> HYP_P

    HYP_E -. "router" .- HYP_P
    HYP_P -- "transfer(){value: amount}" --> Bob
    linkStyle 7 color:green;
```

**NOTE:** ERC721 collateral variants are assumed to [enumerable](https://docs.openzeppelin.com/contracts/4.x/api/token/erc721#IERC721Enumerable) and [metadata](https://docs.openzeppelin.com/contracts/4.x/api/token/erc721#IERC721Metadata) compliant.

## Bridging Fees

Warp routes may charge additional fees for bridging to cover the costs of relaying, security, and liquidity management.

To quote the fees charged by a warp route, users call the `TokenRouter.quoteTransferRemote` function with the same parameters to `transferRemote`.

```solidity
struct Quote {
  address token; // address(0) for the native token
  uint256 amount;
}

interface TokenRouter {
  function quoteTransferRemote(
    uint32 destination,
    bytes32 recipient,
    uint256 amount
  ) public returns (Quote[] quotes);
}
```

We recommend performing this quote offchain and populating the value and token approvals accordingly. If you must quote onchain, there is a [`Quotes` utility library](./libs/Quotes.sol) for extracting the fees charged in specific denominations.

### Funding Pseudocode

```solidity
Quotes[] memory quotes = tokenRouter.quoteTransferRemote(destination, recipient, amount);

uint256 nativeFee = quotes.extract(address(0));

address token = tokenRouter.token();
uint256 tokenFee = quotes.extract(token);
IERC20(token).approve(tokenRouter, tokenFee);

tokenRouter.transferRemote{value: nativeFee}(destination, recipient, amount);
```

### Fee Recipients

Warp routes have configurable fees/fee recipients which are a function of the `transferRemote` parameters.

```solidity
interface TokenRouter {
  function feeRecipient() public view returns (address);
}
```

These fees will be surfaced in the `quoteTransferRemote` API response (if configured). These fees are charged at `transferRemote` time through the `TokenRouter` such that the above funding strategy applies.

### External Fees

Warp routes may wrap external bridges like [CCTP V2](./TokenBridgeCctpV2.sol) or [Everclear](./bridge/EverclearTokenBridge.sol) that have their own fee models. These are also exposed in the `quoteTransferRemote` API and charged at `transferRemote` time before being forwarded to the external bridge.

## Learn more

For more information, see the [Hyperlane introduction documentation](https://docs.hyperlane.xyz/docs/intro).
