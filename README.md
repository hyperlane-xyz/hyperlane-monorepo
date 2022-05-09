# Abacus

## Overview

Abacus is a cross-chain communication system. It handles passing raw buffers
between blockchains cheaply, and with minimal fuss. Like IBC and other
cross-chain communication systems, Abacus creates channels between chains, and
then passes its messages over the channel. Once a channel is established, any
application on the chain can use it to send messages to any other chain.

Compared to IBC and PoS light client based cross-chain communication, Abacus
has weaker security guarantees. However, Abacus may be implemented on any smart
contract chain, with no bespoke light client engineering. Because it does not run
a light client, Abacus does not spend extra gas verifying remote chain block headers.

In other words, Abacus is designed to prioritize:

- Cost: No header verification or state management.
- Speed of implementation: Requires only simple smart contracts, no complex
  cryptography.
- Ease of use: Simple interface for maintaining application connections.

You can read more about Abacus' architecture in the [documentation](https://docs.useabacus.network/).

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
See [this guide](./running-locally.md) for how to run the agents locally and perform a full end-to-end test.

#### Building Agent Images

There exists a docker build for the agent binaries. These docker images are used for deploying the agents in a production environment.

```bash
cd rust
./build.sh <image_tag>
./release.sh <image_tag>
```

# What is Abacus?

We present Abacus — a system for sending messages between consensus systems
without paying header validation costs by creating the illusion of cross-chain
communication. Similar to an atomic swap, Abacus uses non-global protocol
validation to simulate cross-chain communication. Abacus can carry arbitrary
messages (raw byte vectors), uses a single-producer multi-consumer model, and
has protocol overhead sublinear in the number of messages being sent.

## Key Points

System sketch:

1. An "outbox" chain commits messages in a merkle tree
2. Bonded "validators" attest to the commitment via "checkpoints"
3. Attested checkpoints are relayed to any number of "inbox" chains

As a result, one of the following is always true:

1. All inboxes have a valid commitment to messages from the outbox chain
2. Misbehaving validators can be slashed on the outbox chain

This guarantee, although weaker than header-chain validation, is still likely
acceptable for most applications.

## Summary

Abacus is a new strategy for simulating cross-chain communication without
validating headers. The goal is to create a single short piece of state (a
32-byte hash) that can be updated regularly. This hash represents a merkle tree
containing a set of cross-chain messages being sent by a single chain (the
"outbox" chain for the Abacus system). Contracts on the outbox chain can submit
messages, which are put into a merkle tree (the "message tree"). The message
tree's root may be transferred to any number of "inbox" chains.

The outbox chain designates validators. A validator places a bond ensuring
her good behavior. She is responsible for producing signed attestations of the
new message tree root. These attestations are relayed to inbox chains.

The inbox accepts a checkpoint attestation signed by validators. Because this root
contains a commitment of all messages sent by the outbox chain, these messages
can be proven (using the inbox's root) and then dispatched to contracts on the
inbox chain.

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
