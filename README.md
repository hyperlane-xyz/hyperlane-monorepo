# Hyperlane Warp Routes

This repo contains contracts, deployment, and SDK tooling for Hyperlane Warp Routes. 

## Warp Route Architecture

A *warp route* is a collection of [`TokenRouter`](./contracts/libs/TokenRouter.sol) contracts deployed across a set of Hyperlane chains. These contracts leverage the `Router` pattern to implement access control and routing logic for remote token transfers. These contracts send and receive [`Message`](./contracts/libs/Message.sol)s which encode payloads containing a transfer `amount` and `recipient` address.

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

    HYP_E -. "router" .- HYP_P -. "router" .- HYP_G

```

The Token Router contract comes in several flavors and a warp route can be composed of a combination of these flavors.

- [`Native`](./contracts/HypNative.sol) - for warping native assets (e.g. ETH) from the canonical chain
- [`Collateral`](./contracts/HypERC20Collateral.sol) - for warping tokens, ERC20 or ERC721, from the canonical chain
- [`Synthetic`](./contracts/HypERC20.sol) - for representing tokens, Native/ERC20 or ERC721, on a non-canonical chain

## Interchain Security Models

Warp routes are unique amongst token bridging solutions because they provide modular security. Because the `TokenRouter` implements the `IMessageRecipient` interface, it can be configured with a custom interchain security module. Please refer to the relevant guide to specifying interchain security modules on the [Messaging API receive docs](https://docs.hyperlane.xyz/docs/apis/messaging-api/receive#interchain-security-modules).

## Remote Transfer Lifecycle Diagrams

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

**NOTE:** The [Relayer](https://docs.hyperlane.xyz/docs/protocol/agents/relayer) shown below must be compensated. Please refer to the relevant guide on [paying for interchain gas](https://docs.hyperlane.xyz/docs/build-with-hyperlane/guides/paying-for-interchain-gas) on the `messageID` returned from the `transferRemote` call.

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

## Versions

| Git Ref | Release Date | Notes |
| ------- | ------------ | ----- |
| [audit-v2-remediation]() | 2023-02-15 | Hyperlane V2 Audit remediation |
| [main]() | ~ | Bleeding edge |


## Setup for local development

```sh
# Install dependencies
yarn

# Build source and generate types
yarn build:dev
```


## Unit testing

```sh
# Run all unit tests
yarn test

# Lint check code
yarn lint
```

## Learn more

For more information, see the [Hyperlane documentation](https://docs.hyperlane.xyz/docs/introduction/readme).

