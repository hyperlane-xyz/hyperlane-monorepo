export BASE_PATH="/Users/danwt/Documents/dym/d-hyperlane-monorepo"

#########################################################################################
#########################################################################################
# Q: WHAT IS THIS?
# A: It's not a script, but rather some commands, which should be copy pasted as appropriate per the instructions, while in the right directories.
#########################################################################################

###########################
# STEP: BUILD THE PROGRAMS/CONTRACTS
cd rust/sealevel/programs

# MUST USE SOLANA v1.14.20
# (Make sure memo tokens are included in TOKEN_PROGRAM_PATHS in build-programs.sh)
# Build the token programs (.so files)
./build-programs.sh token

###########################
# STEP: START LOCAL SOLANA INSTANCE 

# first set up some environment variables (needed in every terminal)

export SOL_ENV_DIR="$BASE_PATH/dymension/solana_native_memo_test/environments"
export SOL_PROG_DIR="$BASE_PATH/rust/sealevel/target/deploy"
export SOL_KEY_PATH="$BASE_PATH/dymension/solana_native_memo_test/key.json"
export SOL_CFG_PATH="$HOME/.config/solana/cli/config.yml"
export SOL_ENVIR="local-e2e"
export IGP_PROG_ID="GwHaw8ewMyzZn9vvrZEnTEAAYpLdkGYs195XWcLDCN4U"
export PUB_KEY="2SzyV1kdJNcDYfAqrs5sDFKfHSB6CPrzKhhRb2PyaWre"
export DEPLOYER_PUB_KEY="E9VrvAdGRvCguN2XgXsgu9PNmMM3vZsU8LSUrM68j8ty"
export HUB_DOMAIN=1260813472 
export ETH_DOMAIN=31337

# MUST USE SOLANA v2
solana-test-validator --reset # launch
solana config set --url localhost # adjust client
solana config set --keypair $SOL_KEY_PATH # adjust client

###########################
# STEP: SETUP INDEXER TO BE ABLE TO OBSERVE MESSAGES
cd rust/main

## build the indexer
cargo build --release --bin scraper --bin init-db

# start a db
docker run --rm --name scraper-testnet-postgres -e POSTGRES_PASSWORD=47221c18c610 -p 5432:5432 postgres:14 &

# in another tab, populate the db with tables etc
HYP_DB="postgresql://postgres:47221c18c610@localhost:5432/postgres" \
./target/release/init-db

# start the scraper
# (if it errors, just try again)
RUST_BACKTRACE=full \
HYP_LOG_LEVEL=debug \
HYP_LOG_FORMAT=compact \
HYP_METRICSPORT=9093 \
HYP_DB="postgresql://postgres:47221c18c610@localhost:5432/postgres" \
HYP_CHAINSTOSCRAPE="sealeveltest1" \
./target/release/scraper

# in another tab, shell into the db to be able to run queries
docker exec -it scraper-testnet-postgres psql -U postgres
\dt # list tables

###########################
# STEP: DEPLOY CONTRACTS
cd rust/sealevel/client

# Prelims:
# - need protoc installed locally
# e.g. protoc --version
# libprotoc 29.3

# MUST USE SOLANA v1.18.18

# core
cargo run -- -k $SOL_KEY_PATH --config $SOL_CFG_PATH \
    core deploy \
    --environment $SOL_ENVIR \
    --environments-dir $SOL_ENV_DIR \
    --built-so-dir $SOL_PROG_DIR \
    --chain sealeveltest1 \
    --local-domain "$ETH_DOMAIN" # todo, solana domain

# igp, not optional
cargo run -- -k $SOL_KEY_PATH --config $SOL_CFG_PATH \
    igp configure\
    --gas-oracle-config-file $SOL_ENV_DIR/$SOL_ENVIR/gas-oracle-configs.json \
    --chain-config-file $SOL_ENV_DIR/$SOL_ENVIR/chain-config.json \
    --program-id $IGP_PROG_ID \
    --chain sealeveltest1

# warp route. This is configured for our token nativeMemo (different than upstream!)
cargo run -- -k $SOL_KEY_PATH --config $SOL_CFG_PATH \
    warp-route deploy \
    --environment $SOL_ENVIR \
    --environments-dir $SOL_ENV_DIR \
    --token-config-file $SOL_ENV_DIR/$SOL_ENVIR/warp-routes/testwarproute/token-config.json \
    --built-so-dir $SOL_PROG_DIR \
    --warp-route-name testwarproute \
    --chain-config-file $SOL_ENV_DIR/$SOL_ENVIR/chain-config.json \
    --ata-payer-funding-amount 1000000000

PROGRAM_ID=$(jq -r '.sealeveltest1.base58' $SOL_ENV_DIR/$SOL_ENVIR/warp-routes/testwarproute/program-ids.json)

###########################
# STEP: TRANSFER 

DUMMY_RECIPIENT="FeSKs7MbwF86PVuofzhKmzWVVFjyVtBTYXJZqQkBYzB6"
EXAMPLE_MEMO="0x0ac7010a087472616e7366657212096368616e6e656c2d301a4b0a446962632f394131454143443533413641313937414443383144463941343946304334413236463746463638354143463431354545373236443744353937393645373141371203313030222a64796d317133303476717239677870766c366b766c656b747238637867743532747879636138347333782a2b6574686d3161333079306839356137703338706c6e76357330326c7a72676379306d3078756d7130796d6e320038a0f2daf1f5c0a89a18122c0a2a64796d31327637353033616664356e7763397030636438766632363464617965646671767a6b657a6c34"
# note: can rederive them memo with this if needed (requires appropriate dymd binary)
# `dymd q forward memo-hl-to-ibc "channel-0" ethm1a30y0h95a7p38plnv5s02lzrgcy0m0xumq0ymn 100ibc/9A1EACD53A6A197ADC81DF9A49F0C4A26F7FF685ACF415EE726D7D59796E71A7 5m dym12v7503afd5nwc9p0cd8vf264dayedfqvzkezl4`

# initate the transfer, it should result in the message being included with a memo in the outbound messages box
cargo run -- -k $SOL_KEY_PATH --config $SOL_CFG_PATH \
    token transfer-remote-memo \
    --program-id $PROGRAM_ID \
    $SOL_KEY_PATH 100 $HUB_DOMAIN $DUMMY_RECIPIENT native $EXAMPLE_MEMO

###########################
# STEP: USE INDEXER TO CHECK THE RESULT

# in the psql tab
select msg_body from message;
# it should have a long body with a 000...00064 part (amt=100) and then a long memo part afterwards

# sanity check other cli cmds
cargo run -- -k $SOL_KEY_PATH --config $SOL_CFG_PATH token query native-memo
