# Hyperlane Warp Route

This repo contains the base Hyperlane ERC20 and ERC721 tokens (HypERC20 and HypERC721). These tokens extend the base standards with an additional `transferRemote` function. Warp Routes make any token or native asset interchain without custom contracts. Read more about Warp Routes and how to deploy your own at [Warp API docs](https://docs.hyperlane.xyz/docs/developers/warp-api).

**NOTE:** ERC721 collateral variants are assumed to [enumerable](https://docs.openzeppelin.com/contracts/4.x/api/token/erc721#IERC721Enumerable) and [metadata](https://docs.openzeppelin.com/contracts/4.x/api/token/erc721#IERC721Metadata) compliant.

## Versions

| Git Ref | Release Date | Notes |
| ------- | ------------ | ----- |
| [audit-v2-remediation]() | 2023-02-15 | Hyperlane V2 Audit remediation |
| [main]() | ~ | Bleeding edge |

## Remote Transfer Lifecycle

```mermaid
%%{ init: {
  "theme": "neutral",
  "themeVariables": {
    "mainBkg": "#025AA1",
    "textColor": "white",
    "clusterBkg": "beige"
  },
  "themeCSS": ".edgeLabel { color: black }"
}}%%

graph TB
    Alice((Alice))
    Bob((Bob))
    Validator((Validator))
    Relayer((Relayer))
    %% Watcher((Watcher))

    subgraph "Ethereum"
        Token_E[ERC20]
        HYP_E[HYP-ERC20]
        M_E[(Mailbox)]
        %% POS_E[Proof of Stake]
    end

    Alice == "0. approve(HYP, infinity)" ==> Token_E
    Alice == "1. transferRemote(Polygon, Bob, 5)" ==> HYP_E
    Token_E -- "2. transferFrom(Alice, 5)" --> HYP_E
    HYP_E -- "3. dispatch(Polygon, HYP, (Bob, 5))" --> M_E

    M_E-."indexing".->Relayer
    %% M_E-."indexing".->Watcher
    M_E -. "indexing" .-> Validator

    %% Validator == "staking" ==> POS_E
    %% Watcher == "slashing" ==> POS_E
    Validator -. "signing" .-> ISM_STORE

    subgraph "Cloud Storage"
        ISM_STORE[(ISM\nMetadata)]
    end

    ISM_STORE -. "metadata" .-> Relayer
    ISM_STORE -. "moduleType" .- ISM_P
    %% Watcher -. "indexing" .- ISM_P

    Relayer == "4. process(metadata, Ethereum, HYP, (Bob, 5))"==> M_P

    subgraph "Polygon"
        ISM_P[ISM]
        M_P[(Mailbox)]
        HYP_P[HYP-ERC20]

        M_P -- "6. handle(Ethereum, (Bob, 5))" --> HYP_P
        M_P -- "5. verify(metadata, Ethereum, (Bob, 5))" --> ISM_P
    end

    ISM_P -. "interchainSecurityModule" .- HYP_P
    HYP_P -- "7. mint(Bob, 5)" --> Bob

```

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
