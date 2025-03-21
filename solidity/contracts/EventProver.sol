// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {PackageVersioned} from "./PackageVersioned.sol";
import {client/BlockHashRouter} from "./client/BlockHashRouter.sol";

// ============ External Imports ============
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {MerklePatriciaProof} from "../lib/fx-portal/contracts/lib/MerklePatriciaProof.sol";
import {RLPReader} from "../lib/fx-portal/contracts/lib/RLPReader.sol";

/**
 * @title EventProver
 * @notice Contract for proving events were emitted in specific blocks on other chains
 * @dev Uses BlockHashRouter to verify block hashes from other chains
 */
contract EventProver is OwnableUpgradeable, PackageVersioned {
    using RLPReader for RLPReader.RLPItem;
    using RLPReader for bytes;
    
    // ============ Events ============
    
    /**
     * @notice Emitted when an event proof is verified successfully
     * @param domain The domain ID of the chain where the event was emitted
     * @param blockNumber The block number where the event was emitted
     * @param emitter The address of the contract that emitted the event
     * @param topic First topic (usually the event signature)
     */
    event EventVerified(
        uint32 indexed domain,
        uint256 indexed blockNumber,
        address indexed emitter,
        bytes32 topic
    );

    // ============ Structs ============
    
    /**
     * @notice Structure representing a receipt proof
     * @param blockNumber The block number containing the event
     * @param txIndex The index of the transaction in the block
     * @param receiptData RLP encoded transaction receipt data
     * @param receiptProof Merkle proof of the receipt
     * @param receiptRoot Receipt root from the block header
     */
    struct ReceiptProof {
        uint256 blockNumber;
        uint256 txIndex; 
        bytes receiptData;
        bytes receiptProof;
        bytes32 receiptRoot;
    }

    /**
     * @notice Structure representing an event proof
     * @param receiptProof The proof for the transaction receipt
     * @param logIndex The index of the log in the receipt
     * @param eventSchema The ABI encoded event schema (signature)
     */
    struct EventProof {
        ReceiptProof receiptProof;
        uint256 logIndex;
        bytes eventSchema;
    }

    // ============ Storage ============
    
    /**
     * @notice The BlockHashRouter contract
     */
    BlockHashRouter public blockHashRouter;
    
    /**
     * @notice Cache of verified events to avoid re-verification
     * Maps domain => keccak256(blockNumber, txIndex, logIndex) => bool
     */
    mapping(uint32 => mapping(bytes32 => bool)) public verifiedEvents;

    // ============ Initializer ============
    
    function initialize(
        address _blockHashRouter,
        address _owner
    ) external initializer {
        __Ownable_init();
        blockHashRouter = BlockHashRouter(_blockHashRouter);
        _transferOwnership(_owner);
    }

    // ============ External Functions ============
    
    /**
     * @notice Updates the BlockHashRouter address
     * @param _blockHashRouter The new BlockHashRouter address
     */
    function setBlockHashRouter(address _blockHashRouter) external onlyOwner {
        blockHashRouter = BlockHashRouter(_blockHashRouter);
    }

    /**
     * @notice Verifies that an event was emitted on a remote chain
     * @param domain The domain ID of the remote chain
     * @param proof The event proof
     * @return success True if the proof is valid
     */
    function verifyEventProof(uint32 domain, EventProof calldata proof) public returns (bool success) {
        // Calculate cache key
        bytes32 cacheKey = keccak256(
            abi.encodePacked(
                proof.receiptProof.blockNumber,
                proof.receiptProof.txIndex,
                proof.logIndex
            )
        );
        
        // Check cache first
        if (verifiedEvents[domain][cacheKey]) {
            return true;
        }
        
        // Get the block hash for the claimed block number from BlockHashRouter
        bytes32 blockHash = blockHashRouter.getBlockHash(domain, proof.receiptProof.blockNumber);
        
        // If we don't have this block hash, we can't verify
        if (blockHash == bytes32(0)) {
            return false;
        }
        
        // Verify receipt inclusion in the receipt trie
        bool receiptVerified = _verifyReceiptProof(
            proof.receiptProof.receiptData,
            proof.receiptProof.receiptProof,
            proof.receiptProof.txIndex,
            proof.receiptProof.receiptRoot
        );
        
        if (!receiptVerified) {
            return false;
        }
        
        // Extract and validate the log entry
        (bool logValid, address emitter, bytes32 topic, ) = _extractAndValidateLog(
            proof.receiptProof.receiptData,
            proof.logIndex
        );
        
        if (!logValid) {
            return false;
        }
        
        // Store in cache
        verifiedEvents[domain][cacheKey] = true;
        
        // Emit verification event
        emit EventVerified(domain, proof.receiptProof.blockNumber, emitter, topic);
        
        return true;
    }
    
    /**
     * @notice Verifies that an event was emitted by a specific contract on a remote chain
     * @param domain The domain ID of the remote chain
     * @param emitter The address of the contract that emitted the event
     * @param proof The event proof
     * @return success True if the proof is valid
     */
    function verifyEventFromEmitter(
        uint32 domain, 
        address emitter, 
        EventProof calldata proof
    ) external returns (bool success) {
        // First verify the event proof (this will check the cache)
        if (!verifyEventProof(domain, proof)) {
            return false;
        }
        
        // Extract log information
        (bool logValid, address logEmitter, , ) = _extractAndValidateLog(
            proof.receiptProof.receiptData,
            proof.logIndex
        );
        
        if (!logValid) {
            return false;
        }
        
        // Verify the emitter matches the expected one
        return logEmitter == emitter;
    }
    
    /**
     * @notice Extracts the event data from a log
     * @param proof The event proof
     * @return data The event data (ABI encoded parameters)
     */
    function extractEventData(EventProof calldata proof) external pure returns (bytes memory data) {
        // Parse the receipt data
        RLPReader.RLPItem memory item = proof.receiptProof.receiptData.toRlpItem();
        
        RLPReader.RLPItem[] memory receipt;
        if (item.isList()) {
            // Legacy transaction receipt
            receipt = item.toList();
        } else {
            // EIP-2718 typed transaction receipt - remove the type prefix
            bytes memory typedReceipt = proof.receiptProof.receiptData;
            bytes memory rlpReceipt = new bytes(typedReceipt.length - 1);
            for (uint256 i = 1; i < typedReceipt.length; i++) {
                rlpReceipt[i-1] = typedReceipt[i];
            }
            receipt = rlpReceipt.toRlpItem().toList();
        }
        
        // Extract logs
        RLPReader.RLPItem[] memory logs = receipt[3].toList();
        
        require(proof.logIndex < logs.length, "EventProver: INVALID_LOG_INDEX");
        
        // Extract the log
        RLPReader.RLPItem[] memory log = logs[proof.logIndex].toList();
        
        // Return log data (log[2] is the data field)
        return log[2].toBytes();
    }
    
    // ============ Internal Functions ============
    
    /**
     * @notice Verifies a receipt proof against a receipt root
     * @param receiptData The RLP encoded receipt data
     * @param proof The Merkle Patricia Trie proof
     * @param txIndex The index of the transaction in the block
     * @param receiptRoot The receipt root from the block header
     * @return success True if the proof is valid
     */
    function _verifyReceiptProof(
        bytes memory receiptData,
        bytes memory proof,
        uint256 txIndex,
        bytes32 receiptRoot
    ) internal pure returns (bool) {
        // The path in the receipt trie is the RLP encoding of the transaction index
        bytes memory path = _getPathForTxIndex(txIndex);
        
        // Verify the receipt is in the trie
        return MerklePatriciaProof.verify(
            receiptData,
            path,
            proof,
            receiptRoot
        );
    }
    
    /**
     * @notice Computes the path in the receipt trie for a transaction index
     * @param txIndex The transaction index
     * @return path The path in the receipt trie
     */
    function _getPathForTxIndex(uint256 txIndex) internal pure returns (bytes memory) {
        // The path in the receipt trie is the RLP encoding of the transaction index
        bytes memory path;
        if (txIndex < 128) {
            // For small values, RLP encoding is the value itself
            path = new bytes(1);
            path[0] = bytes1(uint8(txIndex));
        } else if (txIndex < 256) {
            // For values 128-255, RLP encoding is [0x81, value]
            path = new bytes(2);
            path[0] = 0x81;
            path[1] = bytes1(uint8(txIndex));
        } else {
            // For larger values (unlikely in practice for tx indices), use proper RLP encoding
            // This is a simplified version for values < 65536
            path = new bytes(3);
            path[0] = 0x82;
            path[1] = bytes1(uint8(txIndex >> 8));
            path[2] = bytes1(uint8(txIndex));
        }
        return path;
    }
    
    /**
     * @notice Extracts and validates a log entry from a receipt
     * @param receiptData The RLP encoded receipt data
     * @param logIndex The index of the log in the receipt
     * @return valid Whether the log is valid
     * @return emitter The address that emitted the event
     * @return topic The first topic (event signature)
     * @return data The event data
     */
    function _extractAndValidateLog(
        bytes memory receiptData,
        uint256 logIndex
    ) internal pure returns (
        bool valid,
        address emitter,
        bytes32 topic,
        bytes memory data
    ) {
        // Parse the receipt
        RLPReader.RLPItem memory item = receiptData.toRlpItem();
        
        RLPReader.RLPItem[] memory receipt;
        if (item.isList()) {
            // Legacy transaction receipt
            receipt = item.toList();
        } else {
            // EIP-2718 typed transaction receipt - remove the type prefix
            bytes memory typedReceipt = receiptData;
            bytes memory rlpReceipt = new bytes(typedReceipt.length - 1);
            for (uint256 i = 1; i < typedReceipt.length; i++) {
                rlpReceipt[i-1] = typedReceipt[i];
            }
            receipt = rlpReceipt.toRlpItem().toList();
        }
        
        // Extract logs
        RLPReader.RLPItem[] memory logs = receipt[3].toList();
        
        if (logIndex >= logs.length) {
            return (false, address(0), bytes32(0), "");
        }
        
        // Extract the log
        RLPReader.RLPItem[] memory log = logs[logIndex].toList();
        
        // log[0] is the address that emitted the event
        emitter = RLPReader.toAddress(log[0]);
        
        // log[1] is the topics array
        RLPReader.RLPItem[] memory topics = log[1].toList();
        
        if (topics.length == 0) {
            return (false, address(0), bytes32(0), "");
        }
        
        // First topic is the event signature
        topic = bytes32(topics[0].toUint());
        
        // log[2] is the data
        data = log[2].toBytes();
        
        return (true, emitter, topic, data);
    }
}