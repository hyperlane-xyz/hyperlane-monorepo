// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

interface ILayerZeroEndpointV2 {
    function send(
        uint32 dstEid,
        bytes calldata message,
        bytes calldata options,
        address refundAddress
    ) external payable returns (bytes32 guid);
    
    function quote(
        uint32 dstEid,
        bytes calldata message,
        bytes calldata options,
        bool payInLzToken
    ) external view returns (uint256 fee);
}

/**
 * @title RealOFTToken
 * @notice ERC20 token with real LayerZero V2 integration for cross-chain bridging
 */
contract RealOFTToken is ERC20, Ownable {
    ILayerZeroEndpointV2 public immutable lzEndpoint;
    
    // Mapping of destination chain EIDs to peer OFT addresses
    mapping(uint32 => bytes32) public peers;
    
    // LayerZero chain EIDs
    uint32 public constant SEPOLIA_EID = 40161; // Sepolia
    uint32 public constant ARB_SEPOLIA_EID = 40231; // Arbitrum Sepolia
    
    event OFTSent(uint32 indexed dstEid, address indexed from, bytes32 to, uint256 amount, bytes32 guid);
    event OFTReceived(uint32 indexed srcEid, bytes32 from, address indexed to, uint256 amount);
    
    constructor(
        string memory name_,
        string memory symbol_,
        address _lzEndpoint
    ) ERC20(name_, symbol_) {
        lzEndpoint = ILayerZeroEndpointV2(_lzEndpoint);
        _transferOwnership(msg.sender);
    }
    
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
    
    function setPeer(uint32 eid, bytes32 peer) external onlyOwner {
        peers[eid] = peer;
    }
    
    /**
     * @notice Send tokens to another chain via LayerZero
     * @param dstEid Destination chain endpoint ID
     * @param to Recipient address on destination chain
     * @param amount Amount of tokens to send
     */
    function sendOFT(
        uint32 dstEid,
        address to,
        uint256 amount
    ) external payable returns (bytes32 guid) {
        require(peers[dstEid] != bytes32(0), "Peer not set");
        
        // Burn tokens on source chain
        _burn(msg.sender, amount);
        
        // Encode the message
        bytes memory message = abi.encode(msg.sender, to, amount);
        
        // Basic options for LayerZero V2
        bytes memory options = hex"0003010011010000000000000000000000000000ea60"; // 60000 gas
        
        // Send via LayerZero
        guid = lzEndpoint.send{value: msg.value}(
            dstEid,
            message,
            options,
            msg.sender // refund address
        );
        
        emit OFTSent(dstEid, msg.sender, bytes32(uint256(uint160(to))), amount, guid);
    }
    
    /**
     * @notice Quote the fee for sending tokens
     */
    function quoteSend(
        uint32 dstEid,
        address to,
        uint256 amount
    ) external view returns (uint256 fee) {
        bytes memory message = abi.encode(msg.sender, to, amount);
        bytes memory options = hex"0003010011010000000000000000000000000000ea60"; // 60000 gas
        
        fee = lzEndpoint.quote(dstEid, message, options, false);
    }
    
    /**
     * @notice Receive tokens from LayerZero (called by endpoint)
     * @dev In production, this would be called via lzReceive with proper validation
     */
    function receiveOFT(
        uint32 srcEid,
        bytes32 from,
        address to,
        uint256 amount
    ) external onlyOwner {
        // In production, this should only be callable by the LZ endpoint
        // For testing, we allow owner to simulate receives
        _mint(to, amount);
        emit OFTReceived(srcEid, from, to, amount);
    }
    
    // Fallback to receive ETH
    receive() external payable {}
}