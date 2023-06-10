# Usage

This is from the help output of the hl binary.

## hl

```
Usage: hl [OPTIONS] <URL> <CONTRACT> <COMMAND>

Commands:
  connect   Test chain connection and take no further action
  dispatch  Dispatch message to destination chain via Hyperlane mailbox contract
  pay       Pay for gas of delivery on destination chain via Hyperlane gas paymaster contract
  query     Query for Hyperlane messages sent from origin chain
  help      Print this message or the help of the given subcommand(s)

Arguments:
  <URL>       RCP URL for chain to call
  <CONTRACT>  Contract address as H160 hex string (40 characters), optionally prefixed with 0x

Options:
  -k, --key <KEY>        Private key (optional, if needed to sign), as H256 hex string (64 characters), optionally prefixed with 0x
  -o, --origin <ORIGIN>  Origin chain identifier (unsigned integer). If not specified, chain will be queried for chain ID
  -v, --verbose          Show verbose output (including transaction logs)
  -h, --help             Print help
  -V, --version          Print version
```

## hl connect

```
Test chain connection and take no further action

Usage: hl <URL> <CONTRACT> connect [OPTIONS]

Options:
  -h, --help       Print help
  -V, --version    Print version
```

## hl dispatch

```
Dispatch message to destination chain via Hyperlane mailbox contract

Usage: hl <URL> <CONTRACT> dispatch [OPTIONS] <DEST> <RECIPIENT>

Arguments:
  <DEST>       Destination chain identifier (unsigned integer)
  <RECIPIENT>  Recipient contract address as H160 hex string (40 characters), optionally prefixed with 0x

Options:
  -k, --key <KEY>          Private key (optional, if needed to sign), as H256 hex string (64 characters), optionally prefixed with 0x
  -p, --payload <PAYLOAD>  Hex encoded message payload to send, optionally prefixed with 0x
  -f, --file <FILE>        Input file for message payload (bytes) to send. (Alternative to --payload, specify one or the other.)
  -h, --help               Print help
  -V, --version            Print version
```

## hl pay

```
Pay for gas of delivery on destination chain via Hyperlane gas paymaster contract

Usage: hl <URL> <CONTRACT> pay [OPTIONS] <DEST> <MESSAGE_ID> [GAS]

Arguments:
  <DEST>        Destination chain identifier (unsigned integer)
  <MESSAGE_ID>  Id of message to pay for
  [GAS]         Gas to pay on destination chain (will be converted according gas price and exchange rate) [default: 10000]

Options:
  -k, --key <KEY>  Private key (optional, if needed to sign), as H256 hex string (64 characters), optionally prefixed with 0x
  -h, --help       Print help
  -V, --version    Print version
```

## hl query

```
Query for Hyperlane messages sent from origin chain

Usage: hl <URL> <CONTRACT> query [OPTIONS]

Options:
  -c, --criteria <CRITERIA>  Match criteria for messages to search for in either JSON or CSV format
  -k, --key <KEY>            Private key (optional, if needed to sign), as H256 hex string (64 characters), optionally prefixed with 0x
  -s, --start <START>        Start block number to search from. If not specified, will search last 100 blocks. If negative (-n), will search from latest block + 1 - n [default: -1000]
  -e, --end <END>            End block number to search to. If not specified, will search until latest block. If negative (-n), will search to latest block + 1 - n [default: -1]
  -d, --debug                Do not run; print extracted parameters and exit
  -h, --help                 Print help (see more with '--help')
  -V, --version              Print version
```

# Compilation

The build stage has a dependency on compiled contracts in `solidity/`, so before compilation of the CLI you will need to have successfully run:

```
cd path/to/hyperlane-monorepo/solidity
yarn install
npm run build
```

Alternatively you can skip the above step and instead remove the CLI project `rust/cli/build.rs` file and rely on the source files checked into git. There is no other need for `build.rs` and this will work fine.

Once the contracts are compiled (or `build.rs` removed):

```
cd path/to/hyperlane-monorepo/rust/cli

# Avoids git reporting changes, not needed if build.rs removed instead
cargo fmt
```

You can build and view the documentation:

```
cargo docs --no-deps --open
```

Build the binaries:

```
cargo build
```

# Test Walkthrough

I used the Sepolia Testnet settings on: https://docs.hyperlane.xyz/docs/resources/addresses

The CLI has fixed parameters and some that vary according to command. Running without parameters will print help information.

```
cd path/to/hyperlane-monorepo/rust/cli
cargo build

# You can also use: cargo run

../target/debug/hl
```

You will see there are two fixed arguments of (RPC) URL and CONTRACT (address) to use, followed by a command.

For the rest of this walkthrough I will presume you stay in the CLI project directory and have compiled the binary.

To check you can connect and report chain details:

```
../target/debug/hl https://rpc.sepolia.org/ 0xCC737a94FecaeC165AbCf12dED095BB13F037685 connect
```

You should see output as follows:

```
Connecting to: https://rpc.sepolia.org/
Connected, chain identified as: 11155111 Sepolia Ethereum Testnet
```

I have opted not to take a chain id as input. In my tests I was able to retrieve it from the chain. I have assumed the reported ID is reliable from a Hyperlane domain perspective.

For the following examples, set the environment variable PRIVATE_KEY to the private key to use for signing, or use an alternative mechanism to provide sufficient security for the private key that you are using. For example (but with the correct private key):

```
export PRIVATE_KEY=...
```

For later use, also set the sender address with the address coresponding to the private key:

```
export SENDER=...
```

For convenience and clarity of the examples also set following environment variables:

```
export RPC_URL=https://rpc.sepolia.org/
export ORIGIN=11155111
export DESTINATION=80001
export RECIPIENT=0x36FdA966CfffF8a9Cdc814f546db0e6378bFef35
export MAILBOX=0xCC737a94FecaeC165AbCf12dED095BB13F037685
export PAYMASTER=0xF987d7edcb5890cB321437d8145E3D51131298b6
```

I have used for MAILBOX and PAYMASTER the Mailbox and DefaultIsmInterchainGasPaymaster addresses for the Sepolia Testnet at https://docs.hyperlane.xyz/docs/resources/addresses. For these examples to work you need to have a wallet with funds on the chains you dispatch from.

To dispatch a message use the dispatch command. This calls the dispatch method of the Mailbox contract address supplied. Note that this does not pay for delivery on the destination chain, that comes later.

```
../target/debug/hl $RPC_URL $MAILBOX -k $PRIVATE_KEY dispatch $DESTINATION $RECIPIENT -p 0xC0FFEE
```

This will take longer to complete as it waits for confirmation the transaction has been written to a block.

Note the recipient address is taken from https://docs.hyperlane.xyz/docs/apis-and-sdks/messaging-api/send. It doesn't matter what you put for the these tests, as they are only seeking to verify that a message is successfully dispatched and paid for.

If all goes well you should get output that looks like the following, but your hash and message id will be different:

```
Connecting to: https://rpc.sepolia.org/
Connected, chain identified as: 11155111 Sepolia Ethereum Testnet
Transaction completed in block 3745872, hash: 0x995700cd767b4fd108fa85f7779eef2fcf559a323e2bbe223f1d640a6034cf0b
  Message ID: 0x8e9f26fe36fe8971adbc4c4b8da48a5a109dce760dd2ab0fdeff17d0c76ae163
```

You can go to https://sepolia.etherscan.io/, filter by the address corresponding to the private key that you signed with, and you should see the dispatched message (you can identify it by the transaction hash).

You can also run the query command, I'll come back to this later but you can use:

```
../target/debug/hl $RPC_URL $MAILBOX query -c :$SENDER::$RECIPIENT
```

Now set MSG_ID to the message id returned by the dispatch command, because Hyperlane contracts use this id:

```
export MSG_ID=...
```

You can now pay for delivery on the destination chain:

```
../target/debug/hl $RPC_URL $PAYMASTER -k $PRIVATE_KEY pay $DESTINATION $MSG_ID
```

You should see output like (with a different details):

```
Connecting to: https://rpc.sepolia.org/
Connected, chain identified as: 11155111 Sepolia Ethereum Testnet
Quote for 10000 gas on destination chain: 1985911200000000
Transaction completed in block 3747495, hash: 0xd1eddfc6f763759cf2552ab5d4f980fd5e88a3c4e8d72972b4f011a0b5c329be
```

Using the CLI, you can also perform a query on Mailbox logs. First run the command with the --debug flag, and it will show you the parameters being used. You can use this flag to confirm how the criteria supplied are interpreted.

```
../target/debug/hl $RPC_URL $MAILBOX query -c :$SENDER::$RECIPIENT --debug
```

The parameters can also be supplied in JSON format (with autodetection of format); the format shown is more convenient for CLI usage.

Now run without `--debug`:

```
../target/debug/hl $RPC_URL $MAILBOX query -c $ORIGIN:$SENDER:$DESTINATION:$RECIPIENT
```

Provided not too many new blocks have been written (by default looks at last 1000 blocks) you should see output that looks a bit like this:

```
Connecting to: https://rpc.sepolia.org/
Connected, chain identified as: 11155111 Sepolia Ethereum Testnet
Dispatch in block 3749393 to 80001 domain:
  Tx hash  : 0x919ece30ddaa7e276d97496cde6f663690737ac91127f1239139070d1f60f1b4
  Sender   : 0x05047e42f75eaff3f6c7a347930f778fb41c5dd0
  Recipient: 0x36fda966cffff8a9cdc814f546db0e6378bfef35
```

You can run it the other way around, you will need to setup the Mumbai URL with your own API key. I am using the same wallet, and the mailbox adderss is the same. I am using $ORIGIN instead of $DESTINATION to send to Sepolia. You can try the following sequence of commands:

```
export MUMBAI=https://polygon-mumbai.g.alchemy.com/v2/<your API key>
export M_PAYMASTER=0xF90cB82a76492614D07B82a7658917f3aC811Ac1

../target/debug/hl $MUMBAI $MAILBOX -k $PRIVATE_KEY dispatch $ORIGIN $RECIPIENT -p 0xC0FFEE

../target/debug/hl $MUMBAI $M_PAYMASTER -k $PRIVATE_KEY pay $ORIGIN <Message id from previous command>

../target/debug/hl $MUMBAI $MAILBOX query -c :$SENDER::$RECIPIENT

```

All should work as normal. But lets run the query on Sepolia again.

```
../target/debug/hl $RPC_URL $MAILBOX query -c :$SENDER::$RECIPIENT
```

My output was (I have done other test transactions):

```
Connecting to: https://rpc.sepolia.org/
Connected, chain identified as: 11155111 Sepolia Ethereum Testnet
Dispatch in block 3748705 to 80001 domain:
  Tx hash  : 0xca48a9711c0b9b3728ab59201c33fb59d2dd990be73dd1a84c47da714239d445
  Sender   : 0x05047e42f75eaff3f6c7a347930f778fb41c5dd0
  Recipient: 0x36fda966cffff8a9cdc814f546db0e6378bfef35
Dispatch in block 3748732 to 80001 domain:
  Tx hash  : 0x2f3a1c7b980d1153d33554e5a1b9c6ebf15457010f1a6ce33d470419ca8f75f7
  Sender   : 0x05047e42f75eaff3f6c7a347930f778fb41c5dd0
  Recipient: 0x36fda966cffff8a9cdc814f546db0e6378bfef35
Dispatch in block 3749393 to 80001 domain:
  Tx hash  : 0x919ece30ddaa7e276d97496cde6f663690737ac91127f1239139070d1f60f1b4
  Sender   : 0x05047e42f75eaff3f6c7a347930f778fb41c5dd0
  Recipient: 0x36fda966cffff8a9cdc814f546db0e6378bfef35
Process in block 3749591 to 80001 domain:
  Tx hash  : 0xa5575f5e78466a929e86738aad826384e8d799d8c23412bfc04deeee9135dcb5
  Sender   : 0x05047e42f75eaff3f6c7a347930f778fb41c5dd0
  Recipient: 0x36fda966cffff8a9cdc814f546db0e6378bfef35
```

Notice that the last log entry is not a Dispatch but a Process. The query command performed two underlying queries (ordering and deduplicating combined results, although in this case there would be no duplicates). One query on Dispatch events, and one on Process events.

The last Process item was relayed by a relayer from the Mumbai mailbox to the Sepolia mailbox. Hyperlane in action!

I suggested exploring the CLI options using --help (both at top and command level). Not everything has been equally well tested.

There are obvious ways to enhance the tool that I did not have time for:

1. Also read DispatchId and ProcessId logs, and use them to translate from transaction hashes to message ids. That will allow more complete and straightforward tracking of messages across chains and event types.
2. Also read (and link via message id) the GasPayment events of gas paymasters.
3. Support reading from both origin and destination chains from one query invocation and, by reading all event types and linking by message id, report the status of transactions (dispatched -> paid for -> processed).
4. Add reading of ReceivedMessage events of the TestRecipient contract, and/or other relevant events.
5. Consider if other information should be (optionally) extracted, for example the message sent.
6. There are a lot of rough edges (minimal unit tests, incomplete documentation, code to be cleanup up and refactored).

At time of writing there is a bug where specifying the origin and destination chains results in not all matching logs being displayed. I hope to fix it before creating the PR. It appears to work well with just using `:$SENDER::$RECIPIENT` as sufficiently restrictive query instead of `$ORIGIN:$SENDER:$DESTINATION:$RECIPIENT`, with the second not picking up Process events that should match.

Note that although not heavily tested, the tool supports providing multiple queries at once. For example for anything sent by $SENDER or to $RECIPIENT:

```
../target/debug/hl $RPC_URL $MAILBOX query -c :$SENDER:: -c :::$RECIPIENT
```

Using `--debug` you can see this results in two separate MatchItems. Underlying this, 4 (2 MatchItems, with a Dispatch and Process for each) log queries are made that are collectively ordered and deduplicated to achieve the combination of filtering on chain and convenience of seeing items only once and in order.

This design does have the tradeoff of making many queries, and could be done in much less code with a simpler approach that is likely 'good enough' in practice.

If no queries are specified, no results are returned, however an explicit anything (on $MAILBOX) query works (at least on Sepolia, queries that are too open might be rejected on some testnets):

```
../target/debug/hl $RPC_URL $MAILBOX query -c :::
```
