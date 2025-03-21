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
import {Router} from "./Router.sol";
import {GasRouter} from "./GasRouter.sol";

/**
 * @title BlockHashRouter
 * @notice Router for tracking block hashes from remote chains
 * @dev This router stores and retrieves block hashes from remote chains at specific block heights
 */
contract BlockHashRouter is GasRouter {
    // ============ Events ============
    
    /**
     * @notice Emitted when a block hash is stored
     * @param domain The domain of the block hash
     * @param height The block height
     * @param blockHash The block hash
     */
    event BlockHashStored(uint32 indexed domain, uint256 indexed height, bytes32 blockHash);
    
    /**
     * @notice Emitted when a block hash request is sent
     * @param domain The domain to request from
     * @param height The block height requested
     * @param messageId The ID of the message sent
     */
    event BlockHashRequested(uint32 indexed domain, uint256 indexed height, bytes32 messageId);

    // ============ Mutable Storage ============
    
    /**
     * @notice Maps domain => block height => block hash
     */
    mapping(uint32 => mapping(uint256 => bytes32)) public blockHashes;
    
    /**
     * @notice Maps domain => latest block height stored
     */
    mapping(uint32 => uint256) public latestBlockHeights;

    // ============ Constructor ============
    
    constructor(address _mailbox) GasRouter(_mailbox) {}

    // ============ External Functions ============
    
    /**
     * @notice Initialize the router with initial settings
     * @param _hook The hook to use for dispatching messages
     * @param _interchainSecurityModule The ISM to use for message verification
     * @param _owner The owner of the router
     */
    function initialize(
        address _hook,
        address _interchainSecurityModule, 
        address _owner
    ) external initializer {
        _MailboxClient_initialize(
            _hook,
            _interchainSecurityModule,
            _owner
        );
    }

    /**
     * @notice Returns the block hash for a given domain and height
     * @param _domain The domain to query
     * @param _height The block height to query
     * @return The block hash, or bytes32(0) if not found
     */
    function getBlockHash(uint32 _domain, uint256 _height) external view returns (bytes32) {
        return blockHashes[_domain][_height];
    }

    /**
     * @notice Returns the latest known block height for a domain
     * @param _domain The domain to query
     * @return The latest block height stored
     */
    function getLatestBlockHeight(uint32 _domain) external view returns (uint256) {
        return latestBlockHeights[_domain];
    }

    /**
     * @notice Request a block hash from a remote chain
     * @param _destinationDomain The domain to request from
     * @param _height The block height to request
     * @return messageId The ID of the dispatched message
     */
    function requestBlockHash(uint32 _destinationDomain, uint256 _height) external payable returns (bytes32) {
        // Encode the message: request type (1) and the block height
        bytes memory message = abi.encode(uint8(1), _height);
        
        // Dispatch the message to the remote chain
        bytes32 messageId = _GasRouter_dispatch(
            _destinationDomain,
            msg.value,
            message,
            address(hook)
        );
        
        emit BlockHashRequested(_destinationDomain, _height, messageId);
        
        return messageId;
    }

    /**
     * @notice Send a block hash to a remote chain
     * @param _destinationDomain The domain to send to
     * @param _height The block height
     * @param _blockHash The block hash to send
     * @return messageId The ID of the dispatched message
     */
    function sendBlockHash(uint32 _destinationDomain, uint256 _height, bytes32 _blockHash) external payable returns (bytes32) {
        // Encode the message: response type (2), block height, and block hash
        bytes memory message = abi.encode(uint8(2), _height, _blockHash);
        
        // Dispatch the message to the remote chain
        bytes32 messageId = _GasRouter_dispatch(
            _destinationDomain,
            msg.value,
            message,
            address(hook)
        );
        
        return messageId;
    }

    // ============ Internal Functions ============
    
    /**
     * @notice Handle an incoming message from a remote router
     * @param _origin The origin domain
     * @param _sender The sender address (remote router)
     * @param _message The message containing block hash data
     */
    function _handle(
        uint32 _origin,
        bytes32 _sender,
        bytes calldata _message
    ) internal override {
        // Decode the message
        (uint8 messageType, uint256 height, bytes32 blockHash) = _decodeMessage(_message);
        
        if (messageType == 1) {
            // This is a request for a block hash
            // Get the local block hash for the requested height
            bytes32 localBlockHash;
            
            // If the height is current or recent (within 256 blocks), use the blockhash opcode
            if (block.number >= height && block.number - height < 256) {
                localBlockHash = blockhash(height);
            } else {
                // Otherwise, we need to check if we have it stored
                // This implementation doesn't store local block hashes, but could be extended to do so
                localBlockHash = bytes32(0);
            }
            
            // Send the response back
            // Note: This would require gas payment in a production implementation
            bytes memory responseMessage = abi.encode(uint8(2), height, localBlockHash);
            _GasRouter_dispatch(
                _origin,
                0, // No value sent
                responseMessage,
                address(hook)
            );
        } else if (messageType == 2) {
            // This is a response with a block hash
            // Store the block hash
            blockHashes[_origin][height] = blockHash;
            
            // Update latest block height if necessary
            if (height > latestBlockHeights[_origin]) {
                latestBlockHeights[_origin] = height;
            }
            
            emit BlockHashStored(_origin, height, blockHash);
        }
    }
    
    /**
     * @notice Decode a message from a remote router
     * @param _message The message to decode
     * @return messageType The type of message (1=request, 2=response)
     * @return height The block height
     * @return blockHash The block hash (only for responses)
     */
    function _decodeMessage(bytes calldata _message) internal pure returns (
        uint8 messageType,
        uint256 height,
        bytes32 blockHash
    ) {
        if (_message.length == 32 + 1) {
            // Request message: type (1 byte) + height (32 bytes)
            messageType = uint8(bytes1(_message[0]));
            height = abi.decode(_message[1:], (uint256));
            blockHash = bytes32(0);
        } else {
            // Response message: type (1 byte) + height (32 bytes) + hash (32 bytes)
            messageType = abi.decode(_message[0:32], (uint8));
            height = abi.decode(_message[32:64], (uint256));
            blockHash = abi.decode(_message[64:96], (bytes32));
        }
    }
}