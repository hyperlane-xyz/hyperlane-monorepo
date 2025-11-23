# HOW TO RUN VALIDATOR INSTANCE FOR BRIDGING DYMENSION <-> KASPA

As explained in the master [README.md](./README.md) you will run ONE validator containing TWO key pairs to facilitate sending KAS token from KASPA network to DYMENSION.

This doc contains TWO _alternative_ instruction sets, one to use 'bare metal', i.e. systemd and locally available keys, and the other to run with AWS KMS and Docker etc.

BOTH methods have the same structure 

1. Generate key pairs (⚠️ _the keys don't need to be funded_ ⚠️)
2. Share pub keys to Dymension team
3. Await config template file from Dymension team
4. Fill in template with own info (keys or key locations)
5. Run

## HARDWARE REQUIREMENTS

- 2GB of RAM
- 2 CPU cores
- 128GB of disk space

## INSTRUCTIONS BARE METAL

### PHASE 1: KEY GENERATION AND SHARING

In `hyperlane-monorepo/dymension/libs/kaspa/tooling` do `cargo run validator create local -o kaspa-bridge-keys.json`.

It outputs (to file) something like

```
[
  {
    "validator_ism_addr": "0x2541ca4d67d89897d51c2bf25b1fb602eca4ae5c",
    "validator_ism_priv_key": "92940b5c00eb0e8c62f4c0d344b4fee4064c3ac51297159bf77874744e47e016",
    "validator_escrow_secret": "\"b55335e614dacb747ee4bfb5bd95e9cdb7291d32542b27924f06cb1299a2cc5a\"",
    "validator_escrow_pub_key": "0200b77b8e8f871121cda5a5c98938c7057ddee9aed930eea0dbb86dd23cbfd300",
    "multisig_escrow_addr": null
  }
]
```

Give Dymension team `validator_ism_addr` and `validator_escrow_pub_key`. Don't worry about `multisig_escrow_addr`, its not used. Backup the private keys.

### PHASE 2: CONFIG POPULATION AND RUNNING

#### Config

Use the config json template provided by Dymension team at: `hyperlane-monorepo/dymension/validators/bridge/artifacts/<network>/config/kaspa/validator-config.json`. 

Note: `<network>` palceholder should be replaced with either `blubmus` or `mainnet`

Populate `.chains.<kaspa-network-name>.kaspaEscrowPrivateKey` with the escrow secret value `validator_escrow_secret` (keep quotes ⚠️). Also populate `.validator.key` with validator_ism_priv_key and prefix with '0x'. Your file should look something like:

```
{
    "chains": {
      "<kaspa-network-name>": {
        // ...
        "kaspaEscrowPrivateKey": "\"b230e7e6dc106593e55049ecb594e10f5be7576cc654a580c8d8494c34ffd832\"",
        // ...
      }
    },
    // ...
    "validator": {
      "key": "0x6fa2337092f165023e045e78e0f0711ccfd91467762f66b19eae71363581390c"
    }
}
```

#### Running

Copy the dummy `kaspa.wallet` from `hyperlane-deployments/validators/artifacts/<network>/config/kaspa/kaspa.wallet` to `~/.kaspa/kaspa.wallet`: `cp <dummy> ~/.kaspa/kaspa.wallet`. This wallet is just to stop the Kaspa query client crashing because it expects a key. Signing uses the `validator_escrow_secret` generated before!

Make a database directory in place of your choosing (such as `mkdir valdb`)

*Build*

```bash
cd ${HOME}/hyperlane-monorepo/rust/main
cargo build --release --bin validator
```

*Setup Environment Variables*

```bash
export CONFIG_FILES=<absolute path to populated agent-config.json> # REQUIRED!!
export DB_VALIDATOR=<your database directory>
export ORIGIN_CHAIN=kaspatest10  # or mainnet
```

*Option 1: Run with systemd (recommended)*

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

*Option 2: Run with tmux*

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

*Managing the systemd Service*

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

*Exposure*

Make sure 9090 or whatever chosen metrics-port is exposed and tell Dymension team. Your validator will answer queries at that port.

Now you are finished

## INSTRUCTIONS AWS AND KMS

The architecture is to run using docker on a provisioned VM. The gist is to first setup the VM with dependencies, then use the key generation tool to generate keys, and then configure the validator application and run using docker.

### PHASE 0: MACHINE SETUP

use the `terraform/README.md` to provision the infrastructure. once the infrastructure is provisioned, proceed with the following steps.

connect to the remote VM and clone the dymension's hyperlane-monorepo fork.

```bash
ssh -i /path/to/your/private-key.pem \
  <user>@<remote-host>

git clone https://github.com/dymensionxyz/hyperlane-monorepo.git --branch main-dym && cd hyperlane-monorepo/dymension/validators/bridge
```

install dependencies by running `scripts/install-dependencies.sh`

```bash
chmod +x scripts/install-dependencies.sh
scripts/install-dependencies.sh
```

install docker

```bash
# Add Docker's official GPG key
sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

# Install Docker Engine
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

# Add user to docker group
sudo usermod -aG docker $(whoami)
```

log out of the VM and log back in and verify installation

```bash
docker --version
docker compose version

go
foundryup
```

build the validator container (takes time), you can proceed with most of other steps in another terminal window while the container is building. Note - `<network>` placeholder in the following path should be replaced with either `blumbus` or `mainnet`:

⚠️ - It may require running as `sudo` 

```bash
docker build -t hyperlane-kaspa-validator \
  -f ~/hyperlane-monorepo/dymension/validators/bridge/artifacts/<network>/config/kaspa/Dockerfile \
  ~/hyperlane-monorepo
```

### PHASE 1: KEY GENERATION AND SHARING

Use the key generation tool to securely store two key pairs in AWS

```bash
mkdir -p ~/kaspa/{db,config,logs}
echo '<kaspa_kms_key_arn>' > ~/kaspa/kaspa-kms-key-arn
echo '<kaspa_secret_path>' > ~/kaspa/kaspa-secret-path

cd ~/hyperlane-monorepo/dymension/libs/kaspa/tooling

cargo run validator create aws --path $(cat ~/kaspa/kaspa-secret-path) --kms-key-id $(cat ~/kaspa/kaspa-kms-key-arn)

echo '<kaspa_dym_kms_key_arn>' > ~/kaspa/dym-kms-key-arn

AWS_KMS_KEY_ID=$(cat ~/kaspa/dym-kms-key-arn) cast wallet address --aws
```

Give Dymension team `validator_ism_addr` and `validator_escrow_pub_key`

### PHASE 2: CONFIG POPULATION AND RUNNING

Work from inside the unzipped directory:

```bash
cd validators
```

Use `artifacts/<network>/config/kaspa/validator-config.yaml` to configure the validator, once updated, copy the file to the remote host

```bash
cp artifacts/<network>/config/kaspa/validator-config.json ${HOME}/kaspa/config/validator-config.json
cp artifacts/<network>/config/kaspa/docker-compose.yaml ${HOME}/kaspa/docker-compose.yaml
cp artifacts/<network>/config/kaspa/kaspa.wallet ${HOME}/kaspa/config/kaspa.wallet 
```

Update all placeholders inside  and `${HOME}/kaspa/config/validator-config.json` files. Concretely this requires THREE things:

1. Add a pointer to your AWS hosted key which allows minting of KAS on Dymension (replacing the preexisting 'validator' subobject)

```json
// in the TOP LEVEL object
    "validator": {
        "id": "<kaspa_dym_kms_key_arn>",
        "type": "aws",
        "region": "eu-central-1"
    }
```

2. Add a pointer to your AWS hosted key which allows release KAS escrow

```json
// in the chains.kaspatest10 object
   "kaspaKey": {
          "type": "aws",
          "secretId": "<kaspa_secret_arn>",
          "kmsKeyId": "<kaspa_kms_key_arn>",
          "region": "eu-central-1"
      }
```

3. Zero out the `kaspaEscrowPrivateKey` field
```json
  "kaspaEscrowPrivateKey":"",
```

Start the validators on the remote host

```bash
cd ~/kaspa
docker compose up -d
```
