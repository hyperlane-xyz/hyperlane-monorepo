# Hyperlane CLI

Install hyperlane cli

```
npm install -g @hyperlane-xyz/cli
```

Install Anvil (Foundry)

```
curl -L https://foundry.paradigm.xyz | bash
```

Set the private key

```
export HYP_KEY=<YOUR_PRIVATE_KEY>
```

Create folder

```
mkdir hyperlane-local-test && cd hyperlane-local-test
```

Run our first anvil node

```
anvil --port 8545 --chain-id 31337 --block-time 1
```

Run our second anvil node

```
anvil --port 8546 --chain-id 31337 --block-time 1
```

Inii hyperlane

```
hyperlane registry init
```

> [!NOTE]
> Make sure the name of the two nodes is not test1 and test2, the hyperlane cli was throwing an error because it was picking the "default" test chain configuration loaded in the typescript code of hyperlane-cli/sdk

```
hyperlane core init
```

Then deploy your contracts

```
hyperlane core deploy --chain <your-first-chain-node-name>
```

Deploy contracts for second chain

```
hyperlane core deploy --chain <your-second-chain-node-name>
```

Grab the address of the mailbox contract, and the RPC URL for the origin and destination chain

cd to this CLI here

```
cd hyperlane-monorepo/rust/cli
```

Run with the following commands

```
cargo r -- --mailbox-addr <mailbox-contract-addr> --origin-rpc <..> -- destination-rpc <..>
```

This will send "Hello this is Daksh from Hyperlane!!!" as the message body, we can add entry for custom bytes from the command line.

E.g.

```
cargo r -- --mailbox-addr 0b48aF34f4c854F5ae1A3D587da471FeA45bAD52 --origin-rpc http://localhost:8500 --destination-rpc http://localhost:8546
```
