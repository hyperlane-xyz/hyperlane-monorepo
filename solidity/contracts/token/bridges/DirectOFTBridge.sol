// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ValueTransferBridge, Quote} from "../interfaces/ValueTransferBridge.sol";
import {IOFTCore} from "../interfaces/IOFTCore.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title DirectOFTBridge
 * @notice Direct bridge using OFT tokens for cross-chain transfers
 */
contract DirectOFTBridge is ValueTransferBridge, Ownable {
    struct DomainConfig {
        uint32 hyperlaneDomain;
        uint16 lzChainId;
        bytes dstAddress;
        bytes adapterParams;
    }
    
    mapping(uint32 => DomainConfig) public domainConfigs;
    address public immutable oftToken;
    
    constructor(address _oftToken, address _owner) {
        oftToken = _oftToken;
        _transferOwnership(_owner);
    }
    
    function addDomain(
        uint32 _hyperlaneDomain,
        uint16 _lzChainId,
        bytes calldata _dstAddress,
        bytes calldata _adapterParams
    ) external onlyOwner {
        domainConfigs[_hyperlaneDomain] = DomainConfig({
            hyperlaneDomain: _hyperlaneDomain,
            lzChainId: _lzChainId,
            dstAddress: _dstAddress,
            adapterParams: _adapterParams
        });
    }
    
    function quoteTransferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external view override returns (Quote[] memory quotes) {
        require(domainConfigs[destinationDomain].hyperlaneDomain == destinationDomain, "Domain not configured");
        
        quotes = new Quote[](2);
        quotes[0] = Quote({token: address(0), amount: 0}); // Native fee (simplified)
        quotes[1] = Quote({token: oftToken, amount: amountOut});
    }
    
    function transferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external payable override returns (bytes32) {
        DomainConfig memory config = domainConfigs[destinationDomain];
        require(config.hyperlaneDomain == destinationDomain, "Domain not configured");
        
        // The OFT token will handle the transfer and burning
        // msg.sender (the router) must have approved this contract
        IOFTCore(oftToken).sendFrom{value: msg.value}(
            msg.sender,
            config.lzChainId,
            config.dstAddress,
            amountOut,
            config.adapterParams
        );
        
        return keccak256(abi.encodePacked(msg.sender, destinationDomain, recipient, amountOut, block.number));
    }
}