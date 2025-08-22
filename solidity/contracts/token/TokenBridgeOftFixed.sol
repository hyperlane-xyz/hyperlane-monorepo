// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenBridgeOft} from "./TokenBridgeOft.sol";
import {ValueTransferBridge} from "./interfaces/ValueTransferBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title TokenBridgeOftFixed  
 * @notice Fixed version that handles the approval issue in rebalancing
 * @dev Adds a resetApproval function to fix the SafeERC20 issue
 */
contract TokenBridgeOftFixed is TokenBridgeOft {
    using EnumerableSet for EnumerableSet.AddressSet;
    
    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox
    ) TokenBridgeOft(_erc20, _scale, _mailbox) {}

    /**
     * @notice Reset approval to zero to avoid SafeERC20 approval issues
     * @dev Call this before rebalancing if there's an existing non-zero approval
     */
    function resetSelfApproval() external onlyOwner {
        // Reset approval to self to 0
        IERC20(wrappedToken).approve(address(this), 0);
    }
    
    /**
     * @notice Rebalance with automatic approval reset
     * @dev Resets approval before calling parent rebalance
     */
    function rebalanceWithReset(
        uint32 domain,
        uint256 amount,
        address bridge
    ) external payable {
        // Check if caller is allowed rebalancer
        require(_allowedRebalancers.contains(msg.sender), "MCR: Only Rebalancer");
        require(_allowedBridges[domain].contains(bridge), "MCR: Not allowed bridge");
        
        // Reset approval to avoid SafeERC20 issue
        if (bridge == address(this)) {
            IERC20(wrappedToken).approve(address(this), 0);
        }
        
        // Get recipient
        bytes32 recipient = allowedRecipient[domain];
        if (recipient == bytes32(0)) {
            recipient = _mustHaveRemoteRouter(domain);
        }
        
        // Call the internal _rebalance
        _rebalance(domain, recipient, amount, ValueTransferBridge(bridge));
        
        emit CollateralMoved({
            domain: domain,
            recipient: recipient,
            amount: amount,
            rebalancer: msg.sender
        });
    }
}