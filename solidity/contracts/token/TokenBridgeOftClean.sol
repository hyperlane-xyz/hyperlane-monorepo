// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenBridgeOft} from "./TokenBridgeOft.sol";
import {ValueTransferBridge} from "./interfaces/ValueTransferBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/**
 * @title TokenBridgeOftClean
 * @notice Clean implementation that handles OFT rebalancing properly
 * @dev Provides rebalanceOft function that avoids token approval issues
 */
contract TokenBridgeOftClean is TokenBridgeOft {
    using EnumerableSet for EnumerableSet.AddressSet;

    constructor(
        address _erc20,
        uint256 _scale,
        address _mailbox
    ) TokenBridgeOft(_erc20, _scale, _mailbox) {}

    /**
     * @notice Rebalances OFT tokens without approval issues
     * @dev This function is called instead of rebalance() to avoid the approval problem
     * @param domain The destination domain
     * @param amount The amount to rebalance
     */
    function rebalanceOft(
        uint32 domain,
        uint256 amount
    ) external payable {
        // Check permissions
        require(_allowedRebalancers.contains(msg.sender), "MCR: Only Rebalancer");
        require(_allowedBridges[domain].contains(address(this)), "MCR: Not allowed bridge");
        
        // Get recipient
        bytes32 recipient = allowedRecipient[domain];
        if (recipient == bytes32(0)) {
            recipient = _mustHaveRemoteRouter(domain);
        }

        // Call transferRemote directly - router already holds the tokens
        // No approval needed since we're not pulling from an external address
        this.transferRemote{value: msg.value}(
            domain,
            recipient,
            amount
        );
        
        emit CollateralMoved({
            domain: domain,
            recipient: recipient,
            amount: amount,
            rebalancer: msg.sender
        });
    }
}