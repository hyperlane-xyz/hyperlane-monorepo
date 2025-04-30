// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {ICrossL2ProverV2} from "@polymerdao/prover-contracts/contracts/interfaces/ICrossL2ProverV2.sol";
import {Message} from "../libs/Message.sol";

/**
 * @title PolymerISM
 * @author PolymerLabs
 * @notice A generic Interchain Security Module (ISM) for Hyperlane that verifies
 * messages using Polymer proofs of Hyperlane Mailbox `Dispatch` events.
 *
 * @dev This ISM verifies the authenticity of a `Dispatch` event from a specific
 * Mailbox contract on an origin chain, ensuring it targeted this local chain
 * and that the message content matches the proof. It *does not* perform
 * application-specific checks on the message content (e.g., original sender or
 * intended recipient specified within the event data). Such checks should be
 * implemented by the Hyperlane message recipient contract.
 *
 * This ISM expects the `_metadata` field in `verify` to contain *only* the
 * raw `polymerProofBytes` obtained from the Polymer proof service for the
 * corresponding `Dispatch` event on the origin chain.
 */
contract PolymerISM is IInterchainSecurityModule {
    // --- Libraries ---
    using Message for bytes;

    // --- Constants ---

    /**
     * @dev The keccak256 hash of the signature of the Hyperlane Mailbox Dispatch event.
     * keccak256("Dispatch(address,uint32,bytes32,bytes)")
     * Used to ensure the Polymer proof corresponds to the correct event type.
     */
    bytes32 public constant DISPATCH_EVENT_SIGNATURE =
        0x8a14c3cf157c13a16c714580a137977637f7e9e699b36f5b7ad738f3d04d36d1;

    // --- State Variables ---

    /// @notice The Polymer prover contract deployed on this (local) chain.
    ICrossL2ProverV2 public immutable polymerProver;

    /// TODO: Add support for multiple Mailbox contract addresses.
    /// @notice The Hyperlane Mailbox contract address on the origin chain.
    /// @dev This is the contract expected to emit the Dispatch event proven by Polymer.
    /// This naive appraoch assumes the Mailbox contract is deployed to the same address on all chains.
    /// This approach does not scale to multiple Mailbox contract addresses.
    address public immutable originMailbox;

    // --- Events ---

    event PolymerISMConfigured(
        address indexed polymerProver,
        address indexed originMailbox
    );

    // --- Constructor ---

    /**
     * @notice Deploys and configures the PolymerISM.
     * @param _polymerProver Address of the ICrossL2ProverV2 contract on this chain.
     * @param _originMailbox Address of the Mailbox contract on the origin chain.
     */
    constructor(address _polymerProver, address _originMailbox) {
        require(
            _polymerProver != address(0),
            "PolymerISM: Invalid polymer prover address"
        );
        require(
            _originMailbox != address(0),
            "PolymerISM: Invalid origin mailbox address"
        );

        polymerProver = ICrossL2ProverV2(_polymerProver);
        originMailbox = _originMailbox;

        emit PolymerISMConfigured(_polymerProver, _originMailbox);
    }

    // --- IInterchainSecurityModule Implementation ---
    /**
     * @notice Returns the module type for this ISM.
     * @dev This ISM implements a Polymer-specific verification scheme.
     * @return uint8 The module type identifier (Types.POLYMER)
     */
    function moduleType() external view override returns (uint8) {
        return uint8(Types.POLYMER);
    }

    /**
     * @inheritdoc IInterchainSecurityModule
     * @notice Verifies a Hyperlane message by validating a Polymer proof of the
     * corresponding `Dispatch` event from the configured origin Mailbox.
     * @param _metadata The raw Polymer proof bytes (`polymerProofBytes`) for the Dispatch event.
     * @param _message The Hyperlane message bytes being verified. This *must* correspond
     * to the `message` field within the proven Dispatch event.
     * @return True if the Polymer proof is valid and confirms a `Dispatch` event
     * from the origin chain targeting this chain with matching `message` content
     * matching `message` content was emitted. False otherwise.
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external override returns (bool) {
        // Step 1: Assume metadata is the raw Polymer proof bytes
        bytes calldata polymerProofBytes = _metadata;
        // Basic check: ensure proof is not empty
        require(polymerProofBytes.length > 0, "PolymerISM: Empty proof");

        // Step 2: Call Polymer Prover to validate the event proof and extract details.
        // This reverts if the proof itself is invalid according to the Polymer contract.
        (
            uint32 chainId_from_proof,
            address emittingContract_from_proof,
            bytes memory topics_from_proof,
            bytes memory data_from_proof
        ) = polymerProver.validateEvent(polymerProofBytes);

        // --- Perform Generic Verification Checks ---

        // Check 1: Verify message origin matches the chain ID from the proof
        require(
            _message.origin() == chainId_from_proof,
            "PolymerISM: Message origin mismatch"
        );

        // Check 2: Verify the event was emitted by the correct Mailbox contract
        require(
            emittingContract_from_proof == originMailbox,
            "PolymerISM: Proof emitter mismatch (origin mailbox)"
        );

        // Check 3: Does the proven event match the Hyperlane Dispatch event signature?
        // Dispatch has signature + 3 indexed topics = 4 total topics.
        require(
            topics_from_proof.length == 128,
            "PolymerISM: Invalid packed topics length for Dispatch event"
        );
        // Extract topic0 (event signature)
        bytes32 signature_from_proof;
        assembly {
            signature_from_proof := mload(add(topics_from_proof, 0x20)) // 0x20 is the offset for the first element in a bytes array
        }
        require(
            signature_from_proof == DISPATCH_EVENT_SIGNATURE,
            "PolymerISM: Invalid event signature in proof"
        );

        // Check 4: Decode the indexed 'destination' topic. Must be this local domain.
        // Extract topic2 (destination domain)
        bytes32 destination_topic;
        assembly {
            destination_topic := mload(add(topics_from_proof, 0x60)) // Offset for the third topic (0x20 + 2*0x20 = 0x60)
        }
        // Topic 2: uint32 indexed destination (Hyperlane Mailbox Dispatch event format)
        uint32 destination_from_proof = uint32(uint256(destination_topic));
        require(
            destination_from_proof == block.chainid,
            "PolymerISM: Proof destination mismatch (local domain)"
        );

        // Check 5: Decode the non-indexed 'message' data from the proof's data field.
        // The 'data' field of the Dispatch event contains only the abi.encode(bytes message).
        bytes memory message_from_proof = abi.decode(data_from_proof, (bytes));

        // Check 6: Does the *full message* content from the proof match the *full message* being verified?
        require(
            keccak256(message_from_proof) == keccak256(_message),
            "PolymerISM: Proof message content mismatch"
        );

        // If all checks pass, the ISM considers the message verified *at this level*.
        // Further application-specific checks (on sender/recipient within the message)
        // must be done by the receiving contract.
        return true;
    }
}
