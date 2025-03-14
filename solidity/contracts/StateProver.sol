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
 * @title StateProver
 * @notice Contract for proving the state of accounts/contracts on remote chains
 * @dev Uses BlockHashRouter to verify block hashes from other chains and Merkle Patricia Trie verification for state proofs
 */
contract StateProver is OwnableUpgradeable, PackageVersioned {
    using RLPReader for RLPReader.RLPItem;
    using RLPReader for bytes;
    
    // ============ Events ============
    
    /**
     * @notice Emitted when a state proof is verified successfully
     * @param domain The domain ID of the chain
     * @param blockNumber The block number where the state was verified
     * @param account The address of the account whose state was proven
     * @param slot The storage slot that was proven (0 for account proof)
     */
    event StateVerified(
        uint32 indexed domain,
        uint256 indexed blockNumber,
        address indexed account,
        bytes32 slot
    );

    // ============ Structs ============
    
    /**
     * @notice Structure for an account proof
     * @param blockNumber The block number containing the state
     * @param address The account address
     * @param accountProof The Merkle proof of the account in the state trie
     * @param stateRoot The state root from the block header
     */
    struct AccountProof {
        uint256 blockNumber;
        address account;
        bytes accountProof;
        bytes32 stateRoot;
    }
    
    /**
     * @notice Structure for a storage proof
     * @param accountProof The proof for the account itself
     * @param storageKey The storage slot key
     * @param storageProof The Merkle proof of the storage slot
     * @param value The value stored at the slot (RLP encoded)
     */
    struct StorageProof {
        AccountProof accountProof;
        bytes32 storageKey;
        bytes storageProof;
        bytes value;
    }
    
    /**
     * @notice Account state from the state trie
     * @param nonce The account nonce
     * @param balance The account balance
     * @param storageRoot The root of the account's storage trie
     * @param codeHash The hash of the account's code
     */
    struct AccountState {
        uint256 nonce;
        uint256 balance;
        bytes32 storageRoot;
        bytes32 codeHash;
    }

    // ============ Storage ============
    
    /**
     * @notice The BlockHashRouter contract
     */
    BlockHashRouter public blockHashRouter;
    
    /**
     * @notice Cache of verified states to avoid re-verification
     * Maps domain => keccak256(blockNumber, account, slot) => bool
     */
    mapping(uint32 => mapping(bytes32 => bool)) public verifiedStates;

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
     * @notice Verifies an account proof on a remote chain
     * @param domain The domain ID of the remote chain
     * @param proof The account proof
     * @return success True if the proof is valid
     * @return state The account state
     */
    function verifyAccount(
        uint32 domain, 
        AccountProof calldata proof
    ) public returns (bool success, AccountState memory state) {
        // Calculate cache key
        bytes32 cacheKey = keccak256(
            abi.encodePacked(
                proof.blockNumber,
                proof.account,
                bytes32(0) // No storage slot for account proof
            )
        );
        
        // Check cache first
        if (verifiedStates[domain][cacheKey]) {
            // We need to extract and return the account state even for cached proofs
            (, state) = _verifyAccountProofRaw(proof);
            return (true, state);
        }
        
        // Get the block hash for the claimed block number from BlockHashRouter
        bytes32 blockHash = blockHashRouter.getBlockHash(domain, proof.blockNumber);
        
        // If we don't have this block hash, we can't verify
        if (blockHash == bytes32(0)) {
            return (false, state);
        }
        
        // Verify the account proof
        (bool verified, AccountState memory accountState) = _verifyAccountProofRaw(proof);
        
        if (!verified) {
            return (false, state);
        }
        
        // Store in cache
        verifiedStates[domain][cacheKey] = true;
        
        // Emit verification event
        emit StateVerified(domain, proof.blockNumber, proof.account, bytes32(0));
        
        return (true, accountState);
    }
    
    /**
     * @notice Verifies a storage slot proof on a remote chain
     * @param domain The domain ID of the remote chain
     * @param proof The storage proof
     * @return success True if the proof is valid
     * @return value The value stored at the slot
     */
    function verifyStorage(
        uint32 domain, 
        StorageProof calldata proof
    ) external returns (bool success, bytes memory value) {
        // Calculate cache key
        bytes32 cacheKey = keccak256(
            abi.encodePacked(
                proof.accountProof.blockNumber,
                proof.accountProof.account,
                proof.storageKey
            )
        );
        
        // Check cache first
        if (verifiedStates[domain][cacheKey]) {
            // For cached proofs, we can just return the provided value
            return (true, proof.value);
        }
        
        // First verify the account
        (bool accountVerified, AccountState memory state) = verifyAccount(domain, proof.accountProof);
        
        if (!accountVerified) {
            return (false, "");
        }
        
        // Verify the storage proof
        bool storageVerified = _verifyStorageProofRaw(
            state.storageRoot,
            proof.storageKey,
            proof.storageProof,
            proof.value
        );
        
        if (!storageVerified) {
            return (false, "");
        }
        
        // Store in cache
        verifiedStates[domain][cacheKey] = true;
        
        // Emit verification event
        emit StateVerified(domain, proof.accountProof.blockNumber, proof.accountProof.account, proof.storageKey);
        
        return (true, proof.value);
    }
    
    /**
     * @notice Get the EVM encoded storage value from RLP encoded value
     * @param rlpValue The RLP encoded value
     * @return The decoded EVM value
     */
    function decodeStorageValue(bytes calldata rlpValue) external pure returns (bytes32) {
        // If the value is 0 (special case in RLP), return 0
        if (rlpValue.length == 0) {
            return bytes32(0);
        }
        
        RLPReader.RLPItem memory item = rlpValue.toRlpItem();
        uint256 value = item.toUint();
        return bytes32(value);
    }
    
    // ============ Internal Functions ============
    
    /**
     * @notice Internal function to verify an account proof
     * @param proof The account proof
     * @return verified True if the proof is valid
     * @return state The account state
     */
    function _verifyAccountProofRaw(
        AccountProof calldata proof
    ) internal pure returns (bool verified, AccountState memory state) {
        // Create the account address path
        bytes memory path = _getPathForAddress(proof.account);
        
        // Expected format of RLP encoded account: [nonce, balance, storageRoot, codeHash]
        bytes memory accountRLP;
        
        // Verify account exists in state trie
        bool exists = MerklePatriciaProof.verify(
            accountRLP,
            path,
            proof.accountProof,
            proof.stateRoot
        );
        
        if (!exists) {
            return (false, state);
        }
        
        // Decode the account RLP
        RLPReader.RLPItem[] memory accountFields = accountRLP.toRlpItem().toList();
        
        // Ensure we have the correct number of fields
        if (accountFields.length != 4) {
            return (false, state);
        }
        
        // Extract account state
        state.nonce = accountFields[0].toUint();
        state.balance = accountFields[1].toUint();
        state.storageRoot = bytes32(accountFields[2].toUint());
        state.codeHash = bytes32(accountFields[3].toUint());
        
        return (true, state);
    }
    
    /**
     * @notice Internal function to verify a storage proof
     * @param storageRoot The storage root of the account
     * @param key The storage slot key
     * @param proof The storage proof
     * @param expectedValue The expected value stored at the slot
     * @return success True if the proof is valid
     */
    function _verifyStorageProofRaw(
        bytes32 storageRoot,
        bytes32 key,
        bytes memory proof,
        bytes memory expectedValue
    ) internal pure returns (bool success) {
        // Create the storage key path
        bytes memory path = _getPathForStorageSlot(key);
        
        // Verify storage slot exists in storage trie
        return MerklePatriciaProof.verify(
            expectedValue,
            path,
            proof,
            storageRoot
        );
    }
    
    /**
     * @notice Computes the path in the state trie for an address
     * @param addr The address
     * @return path The path in the state trie
     */
    function _getPathForAddress(address addr) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(addr)));
    }
    
    /**
     * @notice Computes the path in the storage trie for a storage slot
     * @param slot The storage slot
     * @return path The path in the storage trie
     */
    function _getPathForStorageSlot(bytes32 slot) internal pure returns (bytes memory) {
        return abi.encodePacked(keccak256(abi.encodePacked(slot)));
    }
}