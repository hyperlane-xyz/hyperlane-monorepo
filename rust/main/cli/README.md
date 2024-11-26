# Hyper test CLI

Go to root directory and

```bash
cd rust/main/cli
```

## send

```bash
Usage: hyper send --origin-domain <ORIGIN_DOMAIN> --mailbox <MAILBOX> --rpc <RPC> --destination-domain <DESTINATION_DOMAIN> --destination-address <DESTINATION_ADDRESS> --msg <MSG> --private-key <PRIVATE_KEY>
```

Sample usage

```bash
cargo run send -o 11155111 -m fFAEF09B3cd11D9b20d1a19bECca54EEC2884766 --rpc <RPC> -d 421614 -a eDc1A3EDf87187085A3ABb7A9a65E1e7aE370C07 --msg "Hello Hyperlane" -p <PRIVATE_KEY>
```

## search

```bash
Usage: hyper search --origin-domain <ORIGIN_DOMAIN> --mailbox <MAILBOX> --rpc <RPC> --starting-block <STARTING_BLOCK>
```

Sample usage

```bash
cargo run search -o 11155111 -m fFAEF09B3cd11D9b20d1a19bECca54EEC2884766 --rpc <RPC> \
-d 421614 -s 7148322
```

We additionally ask user for a starting block number to search from.
