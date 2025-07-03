// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.0;

import {AbstractCcipReadIsm} from "./ccip-read/AbstractCcipReadIsm.sol";
import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {ICrossL2ProverV2} from "@polymerdao/prover-contracts/contracts/interfaces/ICrossL2ProverV2.sol";
import {Message} from "../libs/Message.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

/**
 * @title PolymerISM
 * @author PolymerLabs
 * @notice A generic Interchain Security Module (ISM) for Hyperlane that verifies
 * messages using Polymer for foreign state read requests via CCIP Read.
 *
 * @dev This ISM uses CCIP Read to fetch FSR proofs from configured servers
 * and verifies them using the Polymer prover contract.
 *
 * The message payload contains the FSR directive specifying what event to verify.
 */
contract PolymerISM is AbstractCcipReadIsm {
    // --- Libraries ---
    using Message for bytes;

    // --- Constants ---

    // Provider ID for Polymer
    uint8 public constant POLYMER_PROVIDER_ID = 0x0A;

    // --- State Variables ---

    /// @notice The Polymer prover contract deployed on this (local) chain.
    ICrossL2ProverV2 public polymerProver;

    // --- Events ---

    event PolymerISMConfigured(address indexed polymerProver);

    /**
     * @notice Emitted when log verification succeeds
     * @param messageId The Hyperlane message ID from the FSR header
     * @param chainId The chain ID from the verified event
     * @param emittingContract The contract that emitted the event
     * @param topics The topics from the verified log
     * @param data The data from the verified log
     */
    event LogVerified(
        bytes32 indexed messageId,
        uint256 indexed chainId,
        address indexed emittingContract,
        bytes topics,
        bytes data
    );

    // --- Constructor ---

    /**
     * @notice Constructor for upgradeable contract
     */
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the Polymer ISM
     * @param _owner The owner of the ISM
     * @param _polymerProver Address of the ICrossL2ProverV2 contract on this chain
     * @param _urls The CCIP Read server URLs
     */
    function initialize(
        address _owner,
        address _polymerProver,
        string[] memory _urls
    ) external initializer {
        require(
            _polymerProver != address(0),
            "PolymerISM: Invalid polymer prover address"
        );

        __Ownable_init();
        _transferOwnership(_owner);
        setUrls(_urls);

        polymerProver = ICrossL2ProverV2(_polymerProver);

        emit PolymerISMConfigured(_polymerProver);
    }

    // --- IInterchainSecurityModule Implementation ---

    /**
     * @notice Returns the module type for this ISM.
     * @dev This ISM uses FSR (Foreign State Read) pattern, overriding the CCIP_READ type from parent
     * @return uint8 The module type identifier (Types.FSR_READ)
     */
    function moduleType() external pure override returns (uint8) {
        return uint8(IInterchainSecurityModule.Types.FSR_READ);
    }

    // --- CCIP Read Implementation ---

    /**
     * @notice Generate the calldata for offchain lookup
     * @param _message The message containing FSR directive
     * @return The calldata to send to FSR servers
     */
    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal pure override returns (bytes memory) {
        // Just return the entire message for the FSR server to process
        return abi.encode(_message);
    }

    /**
     * @inheritdoc IInterchainSecurityModule
     * @notice Verifies a requested log by validating a Polymer proof fetched via CCIP Read
     * @param _metadata The FSR proof metadata from CCIP server
     * @param _message The message containing FSR directive
     * @return True if the Polymer proof is valid
     */
    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external override returns (bool) {
        return _verifyWithMetadata(_metadata, _message);
    }

    /**
     * @notice Internal verification logic with proof from CCIP server
     * @param proofBytes The FSR proof bytes from CCIP server
     * @param _message The message to verify
     * @return True if verification succeeds
     */
    function _verifyWithMetadata(
        bytes calldata proofBytes,
        bytes calldata _message
    ) internal returns (bool) {
        // Step 1: Validate event using Polymer prover
        (
            uint32 chainId_from_proof,
            address emittingContract_from_proof,
            bytes memory topics_from_proof,
            bytes memory data_from_proof
        ) = polymerProver.validateEvent(proofBytes);

        // Step 2: Verify message routing and extract data from FSR header

        (
            uint32 fsrOrigin,
            bytes32 messageId
        ) = _verifyMessageAndExtractOriginAndMessageID(_message);

        // Step 3: Verify that the origin from FSR header matches the chain ID from proof
        require(
            chainId_from_proof == fsrOrigin,
            "PolymerISM: FSR origin does not match proof chain ID"
        );

        // Step 4: Emit verification event
        emit LogVerified(
            messageId,
            chainId_from_proof,
            emittingContract_from_proof,
            topics_from_proof,
            data_from_proof
        );

        return true;
    }

    /**
     * @notice Verify message routing and extract data from FSR header
     * @param _message The message to verify
     * @return fsrOrigin The origin chain ID from the FSR header
     * @return messageId The Hyperlane message ID of the request from the FSR header
     */
    function _verifyMessageAndExtractOriginAndMessageID(
        bytes calldata _message
    ) internal view returns (uint32, bytes32) {
        // Verify FSR message routing: origin should be 0xFF0A (FSR sentinel with Polymer provider ID)
        // and destination should match this chain
        uint32 messageOrigin = _message.origin();
        uint32 messageDestination = _message.destination();

        // Check that origin is FSR format with Polymer provider ID (0xFF0A)
        require(
            messageOrigin == ((0xFF << 8) | POLYMER_PROVIDER_ID),
            "PolymerISM: message origin is not FSR Polymer format"
        );

        // Check that destination matches this chain's domain ID
        require(
            messageDestination == block.chainid,
            "PolymerISM: message destination mismatch"
        );

        // Extract FSR header from message body
        // Header format: [origin(4), directive_type(1), message_id(32)]
        bytes calldata messageBody = _message.body();
        require(messageBody.length >= 37, "PolymerISM: invalid message body");

        // Extract origin from FSR header (first 4 bytes)
        uint32 fsrOrigin = uint32(bytes4(messageBody[0:4]));

        // Extract message ID from FSR header (bytes 5-37)
        bytes32 messageId = bytes32(messageBody[5:37]);

        return (fsrOrigin, messageId);
    }
}
