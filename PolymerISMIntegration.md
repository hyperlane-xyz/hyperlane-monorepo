# PolymerISM Integration

## Purpose of the Work

This integration adds polymer ISM support to the Hyperlane ecosystem. Key changes include:

- **Contract Side:**
  - A new Polymer ISM contract (`PolymerIsm.sol`) has been introduced.
  - Mock hook contracts (e.g., `hyperlane-monorepo/solidity/contracts/mock/MockHook.sol`) are provided to demonstrate message relaying, bypassing Hyperlane's standard fee mechanisms.
- **Relayer Side:**
  - A new metadata builder module has been added to fetch proofs for events from the Polymer Prover API.
  - Assumptions related to multi-sig and Merkle proof verification, which are not applicable to the Polymer Prover API, have been removed.

## Network Information

The integration has been developed and tested on the following networks:

- **B3 Sepolia Testnet:**
  - Explorer: `https://sepolia.explorer.b3.fun/`
  - Chain ID: `1993`
- **Ape Chain Testnet (Curtis):**
  - Explorer: `https://curtis.explorer.caldera.xyz/`
  - Chain ID: `33111`

## Contract Deployment

Contract deployment is managed using Foundry scripts and `just` targets.

**Prerequisites:**

- Foundry installed.
- `just` command-line tool installed.

**General Instructions:**

- All deployment commands should be run from the `hyperlane-monorepo/solidity` directory.
- **Deployment Order:** Contracts have dependencies. Deploy them in the exact order specified below.
- **Updating `justfile`:** After each contract deployment, new contract addresses will be available in `hyperlane-monorepo/solidity/broadcast/<ScriptName>.s.sol/<ChainID>/run-latest.json`. You **must** update the corresponding variables at the top of `hyperlane-monorepo/solidity/justfile` with these new addresses before proceeding to the next deployment step. This ensures that subsequent scripts use the correct, newly deployed contract addresses.
  - Key variables to update in `solidity/justfile`:
    - `mailbox_contract_addr_b3`
    - `mailbox_contract_addr_ape`
    - `polymer_ism_addr_b3`
    - `polymer_ism_addr_ape`
    - `default_fallback_routing_ism_addr_b3`
    - `default_fallback_routing_ism_addr_ape`
    - `simple_sender_receiver_addr_b3`
    - `simple_sender_receiver_addr_ape`
  - Other variables like `polymer_prover_addr`, RPC endpoints, and chain IDs in `solidity/justfile` should also be verified for your target environment. The provided file contains example values.

---

## Deployment Steps

### 1. Deploy Mailbox Contracts

These contracts are the core message routers for Hyperlane.

- **Commands:**

  ```bash
  # On B3 Sepolia
  just deploy-mailbox-b3

  # On Ape Chain
  just deploy-mailbox-ape

  ```

- **After deployment:**
  1. Locate the `ERC1967Proxy` contract address for each Mailbox (e.g., in `broadcast/DeployMailbox.s.sol/1993/run-latest.json` for B3). This proxy address holds the state and is the one you should use.
  2. Update `mailbox_contract_addr_b3` and `mailbox_contract_addr_ape` variables in `hyperlane-monorepo/solidity/justfile` with these new proxy addresses.
  3. **Important:** Also update the `mailbox` addresses in the relayer configuration file (`hyperlane-monorepo/config/polymer_test_config.json`) to match these new addresses (see Section 4.1).

### 2. Deploy Polymer ISM Contracts

The Polymer ISM contracts are responsible for verifying messages using proofs from the Polymer Prover.

- **Prerequisites:** Ensure `mailbox_contract_addr_b3`, `mailbox_contract_addr_ape`, and `polymer_prover_addr` are correctly set in `solidity/justfile`.
- **Commands:**

  ```bash
  # On B3 Sepolia (origin is Ape Chain Mailbox)
  just deploy-polymer-ism-b3

  # On Ape Chain (origin is B3 Sepolia Mailbox)
  just deploy-polymer-ism-ape

  ```

- **After deployment:**
  1. Find the deployed Polymer ISM contract addresses from the `broadcast` directory.
  2. Update `polymer_ism_addr_b3` and `polymer_ism_addr_ape` variables in `hyperlane-monorepo/solidity/justfile`.

### 3. Deploy Default Fallback Routing ISM Contracts

These contracts will route incoming messages. For messages from known Polymer-enabled origins (Ape Chain on B3, B3 Sepolia on Ape Chain), they will use the respective `PolymerISM` deployed in Step 2. For all other origins, they will fall back to the Mailbox's default ISM.

- **Prerequisites:** Ensure `mailbox_contract_addr_b3/ape` and `polymer_ism_addr_b3/ape` are correctly set in `solidity/justfile`.
- **Commands:**

  ```bash
  # On B3 Sepolia
  just deploy-default-fallback-routing-ism-b3

  # On Ape Chain
  just deploy-default-fallback-routing-ism-ape
  ```

- **After deployment:**
  1. Find the deployed `DefaultFallbackRoutingIsm` contract addresses.
  2. Update `default_fallback_routing_ism_addr_b3` and `default_fallback_routing_ism_addr_ape` in `hyperlane-monorepo/solidity/justfile`.

### 4. Deploy Simple Sender/Receiver Contracts (Test Application)

These contracts demonstrate a basic cross-chain messaging application. They will be configured to use the `DefaultFallbackRoutingIsm` deployed in Step 3 as their ISM.

- **Prerequisites:** Ensure `mailbox_contract_addr_b3/ape` and `default_fallback_routing_ism_addr_b3/ape` are correctly set in `solidity/justfile`.
- **Commands:**

  ```bash
  # On B3 Sepolia
  just deploy-simple-app-b3

  # On Ape Chain
  just deploy-simple-app-ape

  ```

- **After deployment:**
  1. Find the deployed Simple Sender/Receiver contract addresses.
  2. Update `simple_sender_receiver_addr_b3` and `simple_sender_receiver_addr_ape` in `solidity/justfile`. These addresses are used by the `send-message-*` test targets.

### 5. Sanity Check Contract Deployments

You can perform a quick check to ensure the Mailbox contracts are deployed and accessible. These commands use the addresses configured in `solidity/justfile`.

- **Commands:**
  These commands call view functions like `requiredHook()` and `nonce()` on the Mailbox contract.

  ```bash # For B3 Sepolia Mailbox
  just test-mailbox-contract-deployment-b3

  # For Ape Chain Mailbox
  just test-mailbox-contract-deployment-ape
  ```

## Running the Relayer

The Hyperlane relayer is responsible for observing messages on the source chain and relaying them to the destination chain after fetching proof from the Polymer Prover API.

- All relayer commands should be run from the root of the `hyperlane-monorepo` directory.

### 1. Configure the Relayer

- An example configuration file is provided at `hyperlane-monorepo/config/polymer_test_config.json`.
- **Update the following in `config/polymer_test_config.json`:**
  - `chains.<chainName>.signer.key`: Replace `<replace_with_your_private_key>` with your actual private keys for both `apechain` and `b3`. These keys are used to sign transactions for relaying messages.
  - `chains.<chainName>.mailbox`: Ensure these addresses match the Mailbox proxy contract addresses you deployed in Step 3.1.
  - `chains.<chainName>.index.from`: Adjust the starting block number for indexing if necessary (e.g., to a block close to your contract deployments).
  - The `gasPaymentEnforcement` is set to `policy: "none"`, which aligns with demonstrating message relaying without standard Hyperlane fee enforcement, using the Polymer ISM.

### 2. Run the Relayer

- **Command (from `hyperlane-monorepo` root):**

  ```bash
  just run-polymer-test-relayer
  ```

  This command will: 1. Build the relayer: `cd rust/main/agents/relayer && cargo build` 2. Run the relayer: `rust/main/target/debug/relayer --config-path ./config/polymer_test_config.json`.

## Testing End-to-End Communication

Once contracts are deployed and the relayer is running, you can send test messages between the chains using the provided `just` targets.

- Ensure all relevant contract addresses (`simple_sender_receiver_addr_b3`, `simple_sender_receiver_addr_ape`, destination domain IDs, etc.) are correctly set in `hyperlane-monorepo/solidity/justfile`.
- Commands should be run from the `hyperlane-monorepo/solidity` directory.
- **Send a message from B3 Sepolia to Ape Chain:**
  ```bash
  just send-message-b3-to-ape
  ```
- **Send a message from Ape Chain to B3 Sepolia:**
  ```bash
  just send-message-ape-to-b3
  ```

Monitor the relayer logs for activity and check the destination chain's explorer for the relayed message.

## Example Transaction

An example end-to-end transaction flow using this integration:

- **Source Transaction (B3 Sepolia):**[`0xdc8875...ba7cf`](https://sepolia.explorer.b3.fun/tx/0xdc8875a0dbc4d9924e87a0ff7bfd7947fdb85d8986933a31b08154e9957ba7cf)
- **Destination Transaction (Ape Chain Curtis):**[`0x39a0c5...be1a`](https://curtis.explorer.caldera.xyz/tx/0x39a0c56f55fed7ad40eebce30f3f2fc0b681e9fa2b77651f33fd395e8d32be1a?tab=index)
- **Observed End-to-End Latency:** Approximately 13 seconds.

This example demonstrates a message sent from B3 Sepolia and successfully relayed and processed on Ape Chain using the Polymer Prover integration.
