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
contract PolymerISM is AbstractCcipReadIsm, Initializable {
    // --- Libraries ---
    using Message for bytes;

    // --- Constants ---

    // Magic number for FSR directive identification
    bytes32 public constant FSR_MAGIC_NUMBER =
        0xFAF09B8DEEC3D47AB5A2F9007ED1C8AD83E602B7FDAA1C47589F370CDA6BF2E1;

    // Directive type for EVM log FSR
    uint8 public constant EVM_LOG_DIRECTIVE = 0x01;

    // --- State Variables ---

    /// @notice The Polymer prover contract deployed on this (local) chain.
    ICrossL2ProverV2 public polymerProver;

    // --- Events ---

    event PolymerISMConfigured(address indexed polymerProver);

    /**
     * @notice Emitted when FSR verification succeeds
     * @param messageId The message ID that was verified
     * @param chainId The chain ID from the verified event
     * @param emittingContract The contract that emitted the event
     * @param eventHash The hash of the verified event data
     */
    event FsrVerified(
        bytes32 indexed messageId,
        uint256 indexed chainId,
        address indexed emittingContract,
        bytes32 eventHash
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
     * @dev This ISM uses FSR (Foreign State Read) pattern
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
        // Extract the directive from message body
        bytes calldata messageBody = _message.body();

        // The message body should contain the FSR directive
        // Format: [MAGIC_NUMBER, [DIRECTIVE_TYPE, [CHAIN_ID, BLOCK_NUMBER, TX_INDEX, LOG_INDEX]]]
        require(
            messageBody.length >= 32,
            "PolymerISM: invalid message body length"
        );

        bytes32 magicNumber = bytes32(messageBody[0:32]);
        require(
            magicNumber == FSR_MAGIC_NUMBER,
            "PolymerISM: invalid magic number"
        );

        // Return the entire message body as calldata for the FSR server
        return abi.encode(messageBody);
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
     * @notice Internal verification logic with metadata from CCIP server
     * @param _metadata The FSR proof metadata from CCIP server
     * @param _message The message to verify
     * @return True if verification succeeds
     */
    function _verifyWithMetadata(
        bytes calldata _metadata,
        bytes calldata _message
    ) internal returns (bool) {
        // Decode the FSR server response
        // Expected format: abi.encode(result, proof)
        (string memory result, bytes memory polymerProofBytes) = abi.decode(
            _metadata,
            (string, bytes)
        );

        // Basic check: ensure proof is not empty
        require(polymerProofBytes.length > 0, "PolymerISM: Empty proof");

        // Call Polymer Prover to validate the event proof and extract details.
        // This reverts if the proof itself is invalid according to the Polymer contract.
        (
            uint32 chainId_from_proof,
            address emittingContract_from_proof,
            bytes memory topics_from_proof,
            bytes memory data_from_proof
        ) = polymerProver.validateEvent(polymerProofBytes);

        // Verify that the FSR request was made from and to the same chain.
        require(
            block.chainid == _message.origin() &&
                block.chainid == _message.destination(),
            "PolymerISM: FSR request origin mismatch"
        );

        // Extract and verify the directive from message body
        bytes calldata messageBody = _message.body();
        require(messageBody.length >= 32, "PolymerISM: invalid message body");

        bytes32 magicNumber = bytes32(messageBody[0:32]);
        require(
            magicNumber == FSR_MAGIC_NUMBER,
            "PolymerISM: invalid magic number"
        );

        // Parse the directive to extract expected parameters
        bytes calldata directiveData = messageBody[32:];
        (uint8 directiveType, bytes memory params) = abi.decode(
            directiveData,
            (uint8, bytes)
        );

        require(
            directiveType == EVM_LOG_DIRECTIVE,
            "PolymerISM: unsupported directive type"
        );

        // Parse EVM log parameters: [chainId, blockNumber, txIndex, logIndex]
        (
            uint64 expectedChainId,
            uint64 blockNumber,
            uint32 txIndex,
            uint32 logIndex
        ) = abi.decode(params, (uint64, uint64, uint32, uint32));

        // Verify the chain ID matches
        require(
            chainId_from_proof == expectedChainId,
            "PolymerISM: chain ID mismatch"
        );

        // Calculate event hash for logging
        bytes32 eventHash = keccak256(
            abi.encodePacked(
                chainId_from_proof,
                emittingContract_from_proof,
                topics_from_proof,
                data_from_proof
            )
        );

        // Emit verification event
        emit FsrVerified(
            _message.id(),
            chainId_from_proof,
            emittingContract_from_proof,
            eventHash
        );

        return true;
    }
}
