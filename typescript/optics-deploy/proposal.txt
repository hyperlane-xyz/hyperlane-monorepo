Config is currently fragmented across three packages:

- optics-deploy
  - config/**/$NETWORK.ts
    - Chain object contains network name, domain, rpc info, deployer key, and tx gas settings
      - One object per network
      - Consumed by optics deploy in order to send transactions
    - CoreConfig/BridgeConfig objects contain info about how to parameterize the contracts (e.g. agent addresses).
      - One object per environment per network
      - Consumed by optics deploy in order to initialize contracts, verify on-chain state matches expectation
  - scripts/$ENVIRONMENT/agentConfig.ts
    - AgentConfig object contains gcloud/aws info, docker image  
      - One object per environment
      - Consumed by optics deploy in order to configure agent helm charts

- optics-provider
  - src/optics/domains/$ENVIRONMENT.ts
    - OpticsDomain object contains info about contract addresses, network domains, and pagination (for polygon)
      - One object per environment per network
      - Consumed by optics provider in order to instantiate contract objects

- rust
  - config/$ENVIRONMENT/$NETWORK_config.json
    - RustConfig (ts) / Settings (rust) object contains Home/Replica contract addresses, network domains, signer info, rpc info, tracing/db config
      - One file per network per environment
      - Consumed by the agents as a `Settings` object, used to configure DB, indexing, tracing, signers, and create contract objects
  - config/$ENVIRONMENT/$NETWORK_contracts.json
    - One file per network per environment
      - Consumed by optics-deploy to instantiate CoreContracts object, used for checking and modifying existing deploys
      - Seemingly unused by the rust agents
  - config/$ENVIRONMENT/$NETWORK_verification.json
    - One file per network per environment
      - Consumed by optics-deploy to verify contracts on etherscan(s)
      - Seemingly unused by the rust agents
---------------------------------------------------------

Proposal:

At a high level, my suggestion is to move as much config into `optics-deploy` as possible. This means removing unused config files in `rust`, and unifying the `OpticsDomain` type with what's saved in `optics-deploy`.

Specifically, I'm proposing the following:

- optics-deploy
  - config/networks/$NETWORK.ts
    - ChainConfig object contains network name and domain
    - Deployer object contains rpc info, deployer key, and tx gas settings
  - config/environments/$ENVIRONMENT/agent.ts
    - One AgentConfig object containing gcloud/aws info, docker image
  - config/environments/$ENVIRONMENT/core.ts
    - One CoreContractsConfig object per network containing info about how to initialize and configure contracts
  - config/environments/$ENVIRONMENT/bridge.ts
    - One BridgeConfig object per network containing info about how to initialize and configure contracts
  - config/environments/$ENVIRONMENT/contracts/$NETWORK_contracts.json
    - ContractAddresses object, which contains Core and Bridge contract addresses (and domains)
  -  config/environments/$ENVIRONMENT/contracts/$NETWORK_verification.json
    - A list of ContractVerification objects

- optics-provider
  - src/optics/domains/$ENVIRONMENT/$NETWORK_contracts.json
    - ContractAddresses object, copied over from optics-deploy.
    - To minimize changes to optics-provider (for now) we add code in optics-provider to parse into OpticsDomain
    - Can relatively easily follow up to remove `OpticsDomain` and use `ContractAddresses` instead
    - Can add a CI check to enforce files match those in `optics-deploy`

- rust
  - config/$ENVIRONMENT/$NETWORK.json
    - To minimize changes to agents we keep everything here the same
    - As at present, generated programmatically by `optics-deploy` from config that lives in `optics-deploy`
