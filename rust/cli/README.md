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
Simple hyperlane message sender and log checker

Usage: cli <COMMAND>

Commands:
  send   Send hyperlane message
  check  Check all hyperlane messages for given chain
  help   Print this message or the help of the given subcommand(s)

Options:
  -h, --help     Print help
  -V, --version  Print version
```

Example

```
❯ cargo r -- send  --mailbox-addr 0b48aF34f4c854F5ae1A3D587da471FeA45bAD52 --origin-rpc http://localhost:8500 --recipient 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d --destination-rpc http://localhost:8546 --sender 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
```

This will send "Hello this is Daksh from Hyperlane!!!" as the message body, we can add entry for custom bytes from the command line.

Message is currently hardcoded

To check

```
❯ cargo r -- check  --mailbox-addr 0b48aF34f4c854F5ae1A3D587da471FeA45bAD52 --origin-rpc http://localhost:8500
```

Output should be

```
[HYPERLANE-MSG] recipient_address: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d, Found sender_address: 0xf39f…2266, destination: 31338, message: zi��������j��ry���"fzjYƙ^�����If�SHello this is Daksh from Hyperlane!!!

[HYPERLANE-MSG] recipient_address: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d, Found sender_address: 0xf39f…2266, destination: 31338, message: zi��������j��ry���"fzjYƙ^�����If�SHello this is Daksh from Hyperlane!!!

[HYPERLANE-MSG] recipient_address: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d, Found sender_address: 0xf39f…2266, destination: 31338, message: zi��������j��ry���"fzjYƙ^�����If�SHello this is Daksh from Hyperlane!!!

[HYPERLANE-MSG] recipient_address: 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d, Found sender_address: 0xf39f…2266, destination: 31338, message: zi��������j��ry���"fzjYƙ^�����If�SHello this is Daksh from Hyperlane!!!
```

We can add integration test to send a hyperlane message to the local blockchain as test and log retirval
