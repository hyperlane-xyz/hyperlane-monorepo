# How to be a Kaspa bridge validator

## Key Generation

TODO: art complete

## Config

The validator uses AWS Secrets Manager and KMS for secure key management. To configure the agent to use the key, edit your agent-config.json template:

```json
{
  "chains": {
    "kaspatest10": {
      "kaspaKey": {
        "type": "aws",
        "secretId": "kaspa-validator-escrow-key",
        "kmsKeyId": "<your-kms-key-id>",
        "region": "eu-central-1"
      }
    }
  },
}
```

Ensure your AWS credentials are configured with IAM permissions for:

- `secretsmanager:GetSecretValue` on the secret
- `kms:Decrypt` on the KMS key

Set AWS credentials as environment variables:

```bash
export AWS_ACCESS_KEY_ID=<your-access-key>
export AWS_SECRET_ACCESS_KEY=<your-secret-key>
export AWS_REGION=<your-region>
```

## Running

Copy the dummy kaspa.mainnet.wallet to ~/.kaspa/kaspa.wallet: `cp <dummy> ~/.kaspa/kaspa.wallet. This wallet is just to stop the Kaspa client crashing. Signing uses the validator_escrow_secret generated before.

Make a database directory in place of your choosing

### Build

```bash
# in hyperlane-monorepo/rust/main
cd ${HOME}/hyperlane-monorepo/rust/main
cargo build --release --bin validator
```

### Setup Environment Variables

```bash
export CONFIG_FILES=<path to populated agent-config.json>
export DB_VALIDATOR=<your database directory>
export ORIGIN_CHAIN=kaspatest10  # or mainnet
```

### Option 1: Run with systemd (recommended)

```bash
# Create systemd service
sudo tee <<EOF >/dev/null /etc/systemd/system/validator.service
[Unit]
Description=Kaspa Bridge Validator
After=network-online.target
[Service]
WorkingDirectory=${HOME}/hyperlane-monorepo/rust/main
User=$USER
Environment="CONFIG_FILES=${CONFIG_FILES}"
ExecStart=${HOME}/hyperlane-monorepo/rust/main/target/release/validator \
--db ${DB_VALIDATOR} \
--originChainName ${ORIGIN_CHAIN} \
--reorgPeriod 1 \
--checkpointSyncer.type localStorage \
--checkpointSyncer.path ARBITRARY_VALUE_FOOBAR \
--metrics-port 9090 \
--log.level info
Restart=on-failure
RestartSec=10
LimitNOFILE=65535
[Install]
WantedBy=multi-user.target
EOF

# Reload systemd and start the service
sudo systemctl daemon-reload
sudo systemctl enable validator
sudo systemctl start validator

# View logs
journalctl -u validator -f -o cat
```

### Option 2: Run with tmux

```bash
tmux
echo $DB_VALIDATOR && echo $CONFIG_FILES && sleep 3s
cd ${HOME}/hyperlane-monorepo/rust/main
./target/release/validator \
--db $DB_VALIDATOR \
--originChainName $ORIGIN_CHAIN \
--reorgPeriod 1 \
--checkpointSyncer.type localStorage \
--checkpointSyncer.path ARBITRARY_VALUE_FOOBAR \
--metrics-port 9090 \
--log.level info
```

### Managing the systemd Service

```bash
# Check status
sudo systemctl status validator

# Restart
sudo systemctl restart validator

# Stop
sudo systemctl stop validator

# Disable autostart
sudo systemctl disable validator

# View logs
journalctl -u validator -f -o cat
```

## Exposure

Make sure 9090 or whatever chosen metrics-port is exposed and tell Dymension team. Your validator will answer queries at that port.
