// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {ICrossL2ProverV2} from "@polymerdao/prover-contracts/contracts/interfaces/ICrossL2ProverV2.sol";
import {Message} from "../libs/Message.sol";

/**
 * @title PolymerISM
 * @author PolymerLabs
 * @notice A generic Interchain Security Module (ISM) for Hyperlane that verifies
 * messages using Polymer for foreign state read requests.
 *
 * @dev This ISM verifies the authenticity of a Polymer foreign state read request.
 * The request is expected to have been emitted by the Mailbox contract on the same chain.
 * 
 * The message payload is the response of the foreign state read request.
 */
contract PolymerISM is IInterchainSecurityModule {
    // --- Libraries ---
    using Message for bytes;

    // --- State Variables ---

    /// @notice The Polymer prover contract deployed on this (local) chain.
    ICrossL2ProverV2 public immutable polymerProver;

    // --- Events ---

    event PolymerISMConfigured(
        address indexed polymerProver
    );

    // --- Constructor ---

    /**
     * @notice Deploys and configures the PolymerISM.
     * @param _polymerProver Address of the ICrossL2ProverV2 contract on this chain.
     */
    constructor(address _polymerProver) {
        require(
            _polymerProver != address(0),
            "PolymerISM: Invalid polymer prover address"
        );

        polymerProver = ICrossL2ProverV2(_polymerProver);

        emit PolymerISMConfigured(
            _polymerProver
        );
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

        // Check 1: Verify that the FSR request was made from and to the same chain.
        // NB: This is not strictly necessary, but it minimizes application-specific checks.
        // We may want to enable a different read UX in the future.
        require(
            block.chainid == _message.origin() && block.chainid == _message.destination(),
            "PolymerISM: FSR request origin mismatch"
        );

        // Check 2: Combine topics and data into a complete EVM log
        // The complete log should be: [chainId, emittingContract, topics[], data]
        // The app must ensure that the chain ID and emitting contract are correct.
        bytes memory log = abi.encodePacked(
            chainId_from_proof,           // String ID
            emittingContract_from_proof,  // Address
            topics_from_proof,            // Topics array
            data_from_proof               // Data
        );

        // Check 3: Does the complete log match the message body?
        require(
            keccak256(log) == keccak256(_message.body()),
            "PolymerISM: Proof log content mismatch"
        );

        // If all checks pass, the ISM considers the message verified *at this level*.
        // Further application-specific checks (on sender/recipient within the message)
        // must be done by the receiving contract.
        return true;
    }
}
