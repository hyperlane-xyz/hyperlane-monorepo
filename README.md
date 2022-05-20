# Abacus

## Overview

Abacus is an interchain messaging protocol that allows applications to communicate between blockchains.

Developers can use Abacus to share state between blockchains, allowing them to build interchain applications that live natively across multiple chains.

To read more about interchain applications, how the protocol works, and how to integrate with Abacus, please see the documentation. 

You can read more about Abacus' architecture in the [documentation](https://docs.useabacus.network/).


Abacus is an interchain messaging protocol. It handles passing generalized messages
between blockchains cheaply, enabling genuine interchain applications. Inspired by IBC,
Abacus creates channels between chains. In that respect, Abacus is a network between blockchains,
and then passes messages between applications over these channels. Channels can be used 
by numerous applications on any source or destination chain. Abacus is implemented wholly in
smart contracts, and thus can be implemented in any turing complete smart contract chain.

Unfortunately, while Abacus might feel like magic, it isn't actually magic. Something's got to give.
When contrasted against IBC and other communication protocols based on PoS light clients, 
Abacus does have weaker security guarantees. It trades off generalizability, economies of scale
and ease of implementation against securuity guarantees. That said, Abacus augments 
it's PoS security model with what we call Sovereign Consensus, which allows 
any Abacus application to define arbitrary rules which are a pre-condition
for messages being processed. You can read more about Sovereign Consensus [here](https://docs.useabacus.network/abacus-docs/protocol/security/sovereign-consensus)

Other than its unique security model, Abacus is different from IBC and other 
interchain communication protocols in a major way; Abacus may be implemented on any smart
contract platform without a need for light client engineering. Since it does not run
a light client, Abacus doesn't need to spend extra gas verifying block headers,
a major efficiency gain for such a system. 


Said succintly, Abacus was built to prioritize:

- Simplicity: A simple interface for establishing and maintaining connection between applications.
- Speed of implementation: Can be impelemented on any smart contract chain, PoS + SC security model for lower latency.
- Cost: No header verification or state management. Economies of scale in messaging overhead.




## Integrating with Abacus

Abacus establishes communication channels with other chains, but it's up to app
developers to use those. This repo provides a standard pattern for integrating
Abacus channels, and ensuring that communication is safe and secure.

Integrations require a few key components:

- A `Outbox` and any number of `Inbox` contracts deployed on the chain already.
  These contracts manage Abacus communication channels and will be used by the
  app to send and receive messages.

- An `AbacusConnectionManager` (in `solidity/core/contracts`). This
  contract connects the app to Abacus by allowing the app admin to enroll new
  `Outbox` and `Inbox` contracts. Enrolling and unenrolling channels is the
  primary way to ensure that your app handles messages correctly. Apps may
  deploy their own connection manager, or share one with other apps.

- A `Message` library. Abacus sends raw byte arrays between chains. The app
  must define a message specification that can be serialized for sending, and
  deserialized for handling on the remote chain

- A `Router` contract. The router translates between the Abacus cross-chain
  message format, and the local chain's call contract. It also implements the
  business logic of the app. It exposes the user-facing interface, handles
  messages coming in from other chains, and dispatches messages being sent to
  other chains.

Solidity developers interested in implementing their own `Message` library and
`Router` contract should check out the [apps](./solidity/apps/) package. It contains several example applications.

You can find current testnet deploy configurations in the `rust/config/`
directory. These deployments happen frequently and are unstable. Please feel
free to try out integrations using the deployed contracts in the LATEST config.

## Working on Abacus

### Commit signature verification

Commits (and tags) for this repo require [signature verification](https://docs.github.com/en/github/authenticating-to-github/managing-commit-signature-verification/about-commit-signature-verification). If you'd like to contribute to Abacus, make sure that your commits are signed locally.

### Workspaces

This monorepo uses [Yarn Workspaces](https://yarnpkg.com/features/workspaces). Installing dependencies, building, testing, and running prettier for all packages can be done from the root directory of the repository.

- Installing dependencies

  ```bash
  yarn install
  ```

- Building

  ```bash
  yarn build
  ```

- Running prettier

  ```bash
  yarn prettier
  ```

If you are using [VSCode](https://code.visualstudio.com/), you can launch the [multi-root workspace](https://code.visualstudio.com/docs/editor/multi-root-workspaces) with `code mono.code-workspace`, install the recommended workspace extensions, and use the editor settings.

### Rust

- install [`rustup`](https://rustup.rs)
- see `rust/README.md`

### Running Agents Locally
See [this guide](rust/running-locally.md) for how to run the agents locally and perform a full end-to-end test.

#### Building Agent Images

There exists a docker build for the agent binaries. These docker images are used for deploying the agents in a production environment.

```bash
cd rust
./build.sh <image_tag>
./release.sh <image_tag>
```


## Key Points

System outline:

1. An "outbox" contract on a source chain receives messages from applications and commits messages in a merkle tree
2. Staking "validators" attest to the commitment via "checkpoints"
3. Attested checkpoints are relayed to any number of "inbox" contract on any number of destination chains
4. Messages are processed, not before they are checked against the Sovereign Consensus rules of destination applications.

As a result, one of the following is always true:

1. All inboxes have a valid commitment to messages from the outbox chain
2. Misbehaving validators can be slashed on the outbox chain

While this guarantee may be weaker than header verification in its own right, when augmented with Sovereign Consensus we believe it is more than sufficient for even the most high stakes applications.

## Summary

Abacus is a protocol for interchain communication. The protocol's goal is to use generalized messaging between smart contract blockchains to enable interchain applications. 
To enable this capability Abacus creates a succinct piece of state, a 32 byte hash, that is updated regularly. This enables the protocol to have economies of scale with respect to messaging frequency.
This hash is effectively a merkle tree containing a set of interchain messages sent by a collection of applications on a source chain via an Outbox. The root of the merkle tree can be relayed to any number of destination chains via an Inbox. 


The outbox chain designates validators. A validator places a bond as stake ensuring
their good behavior. They are responsible for producing signed attestations of the
new message tree root. These attestations are relayed to inboxes on destination chains.

The inbox accepts a checkpoint attestation signed by validators. Because this root
contains a commitment of all messages sent by the source chain outbox, these messages
can be proven (using the inbox's root) and then dispatched to contracts on the
destination chain inbox.

## Deploy Procedure

The contract addresses of each deploy can be found in `rust/config`. The latest
deploy will be at `rust/config/[latest timestamp]` with bridge contracts within
that same folder under `/bridge/[latest timestamp]`.

The agents are set up to point at one environment at a time.

When agents are deployed to point at a new environment, they cease to point at
the old ones. We **do not** continue to operate off-chain agents on old contract
deploys. Contracts not supported by the agents will cease to function (i.e.
messages will not be relayed between chains).

Off-chain agents are **not** automatically re-deployed when new contract deploys
are merged. Auto-redeploys will be implemented at some future date.
