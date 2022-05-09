## Setup
In `typescript/infra`
```shell
yarn ts-node scripts/output-env-vars.ts -e test -r checkpointer -c alfajores -f ../../rust/local.checkpointer.env
yarn ts-node scripts/output-env-vars.ts -e test -r relayer -c alfajores -f ../../rust/local.relayer.env
yarn ts-node scripts/output-env-vars.ts -e test -r validator -c alfajores -f ../../rust/local.validator.env
```

Example configuration files (these are not guaranteed to be up-to-date).

`rust/local.checkpointer.env`
```shell
OPT_BASE_OUTBOX_CONNECTION_URL=http://localhost:8545
OPT_BASE_INBOXES_KOVAN_CONNECTION_URL=http://localhost:8545
OPT_BASE_INBOXES_FUJI_CONNECTION_URL=http://localhost:8545
OPT_BASE_INBOXES_MUMBAI_CONNECTION_URL=http://localhost:8545

BASE_CONFIG=alfajores_config.json
RUN_ENV=test
OPT_BASE_METRICS=9090
OPT_BASE_TRACING_FMT=pretty
OPT_BASE_TRACING_LEVEL=info
OPT_BASE_DB=/tmp/local-checkpointer-alfajores-db
OPT_BASE_SIGNERS_ALFAJORES_KEY=8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61
OPT_BASE_SIGNERS_ALFAJORES_TYPE=hexKey
OPT_BASE_SIGNERS_KOVAN_KEY=f214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897
OPT_BASE_SIGNERS_KOVAN_TYPE=hexKey
OPT_BASE_SIGNERS_FUJI_KEY=701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82
OPT_BASE_SIGNERS_FUJI_TYPE=hexKey
OPT_BASE_SIGNERS_MUMBAI_KEY=a267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1
OPT_BASE_SIGNERS_MUMBAI_TYPE=hexKey
OPT_CHECKPOINTER_POLLINGINTERVAL=5
OPT_CHECKPOINTER_CREATIONLATENCY=5
```

`rust/local.relayer.env`
```shell
OPT_BASE_OUTBOX_CONNECTION_URL=http://localhost:8545
OPT_BASE_INBOXES_KOVAN_CONNECTION_URL=http://localhost:8545
OPT_BASE_INBOXES_FUJI_CONNECTION_URL=http://localhost:8545
OPT_BASE_INBOXES_MUMBAI_CONNECTION_URL=http://localhost:8545

BASE_CONFIG=alfajores_config.json
RUN_ENV=test
OPT_BASE_METRICS=9091 # Manually set this differently to avoid collisions
OPT_BASE_TRACING_FMT=pretty
OPT_BASE_TRACING_LEVEL=info
OPT_BASE_DB=/tmp/local-relayer-alfajores-db
OPT_BASE_SIGNERS_ALFAJORES_KEY=8166f546bab6da521a8369cab06c5d2b9e46670292d85c875ee9ec20e84ffb61
OPT_BASE_SIGNERS_ALFAJORES_TYPE=hexKey
OPT_BASE_SIGNERS_KOVAN_KEY=f214f2b2cd398c806f84e317254e0f0b801d0643303237d97a22a48e01628897
OPT_BASE_SIGNERS_KOVAN_TYPE=hexKey
OPT_BASE_SIGNERS_FUJI_KEY=701b615bbdfb9de65240bc28bd21bbc0d996645a3dd57e7b12bc2bdf6f192c82
OPT_BASE_SIGNERS_FUJI_TYPE=hexKey
OPT_BASE_SIGNERS_MUMBAI_KEY=a267530f49f8280200edf313ee7af6b827f2a8bce2897751d06a843f644967b1
OPT_BASE_SIGNERS_MUMBAI_TYPE=hexKey
OPT_RELAYER_POLLINGINTERVAL=5
OPT_RELAYER_SUBMISSIONLATENCY=5
OPT_RELAYER_MAXRETRIES=5
OPT_RELAYER_RELAYERMESSAGEPROCESSING=false
OPT_RELAYER_MULTISIGCHECKPOINTSYNCER_THRESHOLD=1
OPT_RELAYER_MULTISIGCHECKPOINTSYNCER_CHECKPOINTSYNCERS_0x70997970c51812dc3a010c7d01b50e0d17dc79c8_TYPE=localStorage
OPT_RELAYER_MULTISIGCHECKPOINTSYNCER_CHECKPOINTSYNCERS_0x70997970c51812dc3a010c7d01b50e0d17dc79c8_PATH=/tmp/validatorsignatures
```

`rust/local.validator.env`
```shell
OPT_BASE_OUTBOX_CONNECTION_URL=http://127.0.0.1:8545
OPT_BASE_INBOXES_KOVAN_CONNECTION_URL=http://127.0.0.1:8545
OPT_BASE_INBOXES_FUJI_CONNECTION_URL=http://127.0.0.1:8545
OPT_BASE_INBOXES_MUMBAI_CONNECTION_URL=http://127.0.0.1:8545

BASE_CONFIG=alfajores_config.json
RUN_ENV=test
OPT_BASE_METRICS=9092 # Manually set this differently to avoid collisions
OPT_BASE_TRACING_LEVEL=info
OPT_BASE_DB=/tmp/local-validator-alfajores-db
OPT_BASE_VALIDATOR_KEY=59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
OPT_BASE_VALIDATOR_TYPE=hexKey
OPT_VALIDATOR_REORGPERIOD=0
OPT_VALIDATOR_INTERVAL=5
OPT_VALIDATOR_CHECKPOINTSYNCER_THRESHOLD=1
OPT_VALIDATOR_CHECKPOINTSYNCER_TYPE=localStorage
OPT_VALIDATOR_CHECKPOINTSYNCER_PATH=/tmp/validatorsignatures
```

## Running
In `typescript/infra` to start the ethereum node with
```shell
yarn hardhat node
```

and then deploy (in a new shell) the abacus contracts
```shell
yarn abacus
```

In `rust` then start the agents (you will need one shell for each)
```shell
env $(xargs <local.checkpointer.env) cargo run --bin checkpointer
env $(xargs <local.relayer.env) cargo run --bin relayer
env $(xargs <local.validator.env) cargo run --bin validator
```

Then to test, start `kathy` which will generate messages.
In `typescript/infra`
```shell
yarn kathy
```
