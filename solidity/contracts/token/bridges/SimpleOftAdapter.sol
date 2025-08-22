// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {ValueTransferBridge, Quote} from "../interfaces/ValueTransferBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ITokenBridgeOft {
    function transferRemote(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) external payable returns (bytes32);
    
    function quoteTransferRemote(
        uint32 destination,
        bytes32 recipient,
        uint256 amount
    ) external view returns (Quote[] memory);
}

/**
 * @title SimpleOftAdapter
 * @notice Adapter for TokenBridgeOft routers to enable rebalancing via their built-in OFT functionality
 */
contract SimpleOftAdapter is ValueTransferBridge {
    using SafeERC20 for IERC20;
    
    address public immutable wrappedToken;
    address public immutable oftRouter;
    
    constructor(address _wrappedToken, address _oftRouter) {
        wrappedToken = _wrappedToken;
        oftRouter = _oftRouter;
    }
    
    function quoteTransferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external view override returns (Quote[] memory quotes) {
        // Delegate to the router's quote function
        return ITokenBridgeOft(oftRouter).quoteTransferRemote(
            destinationDomain,
            recipient,
            amountOut
        );
    }
    
    function transferRemote(
        uint32 destinationDomain,
        bytes32 recipient,
        uint256 amountOut
    ) external payable override returns (bytes32) {
        // Pull tokens from the router (msg.sender)
        IERC20(wrappedToken).safeTransferFrom(msg.sender, address(this), amountOut);
        
        // Approve the router to spend our tokens
        IERC20(wrappedToken).safeApprove(oftRouter, amountOut);
        
        // Call the router's transferRemote (which does both Hyperlane AND OFT bridging)
        return ITokenBridgeOft(oftRouter).transferRemote{value: msg.value}(
            destinationDomain,
            recipient,
            amountOut
        );
    }
}