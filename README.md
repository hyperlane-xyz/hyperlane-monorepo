# Hyperlane Warp Route

This repo contains the base Hyperlane ERC20 and ERC721 tokens (HypERC20 and HypERC721). These tokens extend the base standards with an additional `transferRemote` function. Warp Routes are way of arranging these contracts to make existing assets interchain. Read more about Warp Routes and how to deploy your own at [Warp API docs](https://docs.hyperlane.xyz/docs/developers/warp-api).

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
    Relayer((Relayer))

    subgraph "Ethereum"
        HYP_E[HYP]
        M_E[(Mailbox)]
    end

    subgraph "Polygon"
        HYP_P[HYP]
        M_P[(Mailbox)]
    end

    Bob((Bob))

    Alice -- "transferRemote(Polygon, Bob, 5)" --> HYP_E
    HYP_E -- "dispatch(Polygon, (Bob, 5))" --> M_E
    M_E-.->Relayer
    Relayer -- "process(Ethereum, (Bob, 5))" --> M_P
    M_P-->|"handle(Ethereum, (Bob, 5))"|HYP_P
    HYP_P-.->Bob
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

For more information, see the [Hyperlane documentation](https://docs.hyperlane.xyz/docs/developers/getting-started).
