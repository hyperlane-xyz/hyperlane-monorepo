// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOFTCore} from "./interfaces/IOFTCore.sol";

/**
 * @title MockOFTToken
 * @notice ERC20 token that also implements OFT for cross-chain bridging
 */
contract MockOFTToken is ERC20, IOFTCore, Ownable {
    // LayerZero endpoint configuration
    mapping(uint16 => bytes) public trustedRemoteLookup;
    
    event SendToChain(uint16 indexed dstChainId, address indexed from, bytes toAddress, uint256 amount);
    event ReceiveFromChain(uint16 indexed srcChainId, bytes srcAddress, address indexed to, uint256 amount);
    
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {
        _transferOwnership(msg.sender);
    }
    
    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
    
    function setTrustedRemote(uint16 _remoteChainId, bytes calldata _path) external onlyOwner {
        trustedRemoteLookup[_remoteChainId] = _path;
    }
    
    function sendFrom(
        address from,
        uint16 dstChainId,
        bytes calldata toAddress,
        uint256 amount,
        bytes calldata /* adapterParams */
    ) external payable override {
        require(from == msg.sender || allowance(from, msg.sender) >= amount, "Not authorized");
        
        // Burn tokens from sender
        if (from != msg.sender) {
            _spendAllowance(from, msg.sender, amount);
        }
        _burn(from, amount);
        
        emit SendToChain(dstChainId, from, toAddress, amount);
        
        // In a real implementation, this would interact with LayerZero
        // For testing, we just emit an event
    }
    
    // Function to simulate receiving tokens from another chain
    function receiveFromChain(
        uint16 srcChainId,
        bytes calldata srcAddress,
        address to,
        uint256 amount
    ) external onlyOwner {
        _mint(to, amount);
        emit ReceiveFromChain(srcChainId, srcAddress, to, amount);
    }
}