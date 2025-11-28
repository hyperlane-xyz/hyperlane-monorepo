# HOW TO RUN VALIDATOR INSTANCE FOR BRIDGING DYMENSION <-> OTHER

As explained in the master [README.md](./README.md) you will run ONE validator containing TWO key pairs to facilitate sending various tokens between DYMENSION and ETHEREUM/BASE/BINANCE/SOLANA etc.

This doc contains TWO alternative instruction sets, one to use 'bare metal', i.e. systemd and locally available keys, and the other to run with AWS KMS and Docker etc.

Dymension did NOT write any special code for this type of validation. Here we give a brief help, but please refer to [official Hyperlane docs](https://docs.hyperlane.xyz/docs/operate/validators/run-validators) for comprehensive information. Note that we and HL team strongly encourage using AWS AND KMS.

## INSTRUCTIONS BARE METAL

Pure bare metal is not possible, in the sense that, it's a requirement for this type of validation to be able to post to an S3 bucket and for that S3 bucket to be publicly readable.

### PHASE 1: KEY GENERATION AND SHARING

You need to generate TWO keypairs.

The first is a permanent Ethereum style key pair which is used to sign merkle roots of the Hyperlane entity that exists on the Hub. The public key for this pair will be uploaded to contract state on Ethereum/Solana etc and allows HL messages to reach those chains. This pair must be kept safe. Roots signed with the key are uploaded to S3.

The second pair is a Cosmos pair and is less important. It's simply for sending a one-time [MsgAnnounceValidator](https://github.com/dymensionxyz/hyperlane-cosmos/blob/7fd657cc291b0ba11d8a991a4ec70e196dc2ccb4/x/core/01_interchain_security/keeper/msg_server.go#L220) message to the Hub which announces the S3 bucket location.

#### The Ethereum style merkle roots key

Generate the first keypair type, see [hex key instructions](https://docs.hyperlane.xyz/docs/operate/set-up-agent-keys#generate-a-hexadecimal-key).

To configure the binary to use the key, see [checkpoint signer instructions](https://docs.hyperlane.xyz/docs/operate/validators/run-validators#checkpoint-signer-configuration)

Share the generated address with Dymension team.

#### The Cosmos style announcement key

The validator only supports 'vanilla' cosmos key type, i.e. `/cosmos.crypto.secp256k1.PubKey`. It doesn't support `ethermint.crypto.v1.ethsecp256k1.PubKey`.

```bash
dymd keys add dymension-validator --key-type secp256k1
dymd keys export dymension-validator --unarmored-hex --unsafe
```

Fund the `dymension-validator` key with a small amount of DYM tokens (<1 DYM). This address will be used to submit the `MsgAnnounceValidator` message to the Hub.

### PHASE 2: CONFIG POPULATION AND RUNNING

#### Config

Set the `.signer.key` in the dymension sub object in the config. Make sure there is a `0x` prefix. It should look like

```json
{
    "chains": {
      "dymension": {
// ...
        "signer": {
          "type": "cosmosKey",
          "prefix": "dym",
          "key": "0x485a13000989c3dfe8f0981c9858447a84f0b24c5b0757c06c7daeffae894555",
          "accountAddressType": "Bitcoin"
        }
```

Remove the `.validator` sub object from the config (its only for AWS) and instead append `--validator.key` to the run cmd as instructed [here](https://docs.hyperlane.xyz/docs/operate/validators/run-validators#checkpoint-signer-configuration)

#### Running

Follow [run instructions](https://docs.hyperlane.xyz/docs/operate/validators/run-validators#setup) to run using docker

## INSTRUCTIONS AWS AND KMS

The architecture is to run using docker on a provisioned VM. The gist is to first setup the VM with dependencies, then use the key generation tool to generate keys, and then configure the validator application and run using docker.

### PHASE 0: MACHINE SETUP

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

running the validator in docker is taken from [official Hyperlane docs](https://docs.hyperlane.xyz/docs/operate/validators/run-validators#setup)

pull the validator container

```bash
docker pull --platform linux/amd64 gcr.io/abacus-labs-dev/hyperlane-agent:agents-v1.7.0
```

### PHASE 1: KEY GENERATION AND SHARING

Use the key generation tool to securely store two key pairs in AWS

```bash
mkdir -p ~/dym/{db,config,logs}
echo '<dymension_kms_key_arn>' > ~/dym/dymension-kms-key-arn

AWS_KMS_KEY_ID=$(cat ~/dym/dymension-kms-key-arn) cast wallet address --aws
# !! Give Dymension team the retrieved address !!
```

Create and retrieve the `hyperlane_announcement_priv_key`

```bash
# install `dymd` binary
git clone https://github.com/dymensionxyz/dymension.git --branch v4.0.1 --depth 1
cd dymension && make install && cd .. && rm -rf dymension
dymd version


dymd keys add hyperlane-announcement --key-type secp256k1 --keyring-backend test
dymd keys export hyperlane-announcement --unarmored-hex --unsafe --keyring-backend test

# save the exported key for later use. It will be necessary in the validator-config.json file
```

Fund the announcement key with a small amount of DYM, enough to pay gas for one transaction.

### PHASE 2: CONFIG POPULATION AND RUNNING

Work from inside the unzipped directory:

```bash
git clone https://github.com/dymensionxyz/hyperlane-monorepo.git --branch main-dym
cd hyperlane-monorepo/dymension/validators/bridge
```

Use `artifacts/<network>/config/dymension/validator-config.yaml` to configure the validator, once updated, copy the file to the remote host

```bash
cp artifacts/<network>/config/dymension/validator-config.json ${HOME}/dym/config/validator-config.json
cp artifacts/<network>/config/dymension/docker-compose.yaml ${HOME}/dym/docker-compose.yaml
```

Update all placeholders inside and `${HOME}/dym/config/validator-config.json` files.

1. Add a pointer to your AWS hosted key which allows will perform the signing

```json
// in the TOP LEVEL object
    "validator": {
        "id": "<dymension_kms_key_arn>",
        "type": "aws",
        "region": "eu-central-1"
    }
```

2. Add the s3 compatible bucket for storing signatures

```json
// in the TOP LEVEL object
    "checkpointSyncer": {
        "type": "s3",
        "bucket": "<dymension_s3_bucket_name>",
        "region": "eu-central-1"
    }
```

3. Add the `hyperlane_announcement_priv_key` to the `chains.dymension.signer.key` subobject

Start the validators on the remote host

```bash
# retrieve the AWS credentials from the instance metadata
ROLE_NAME=$(curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/)
creds=$(curl -s http://169.254.169.254/latest/meta-data/iam/security-credentials/$ROLE_NAME)

export AWS_ACCESS_KEY_ID=$(echo "$creds" | jq -r '.AccessKeyId')
export AWS_SECRET_ACCESS_KEY=$(echo "$creds" | jq -r '.SecretAccessKey')
export AWS_SESSION_TOKEN=$(echo "$creds" | jq -r '.Token')

cd ~/dym
docker compose up -d
```

4. Currently, hyperlane validator does not support automatic credential refresh. You need to manually refresh the credentials by running the following command:

4.1. save the `./scripts/refresh-aws-for-vals.sh` script on the validator vm at `/usr/local/bin/refresh_aws_for_vals.sh`
4.2. make it runnable

```bash
chmod +x /usr/local/bin/refresh_aws_for_vals.sh
touch /var/log/refresh_aws_dym.log 
```

3. create a cron job

```bash
crontab -e 
```

3.1 add this line:

```bash
SHELL=/bin/bash
HOME=/home/ubuntu

0 * * * * /usr/local/bin/refresh_aws_and_restart_dym.sh >> /var/log/refresh_aws_dym.log 2>&1
```