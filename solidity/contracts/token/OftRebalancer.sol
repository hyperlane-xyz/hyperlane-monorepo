// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {TokenBridgeOft} from "./TokenBridgeOft.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title OftRebalancer
 * @notice Wrapper contract that handles OFT rebalancing without approval issues
 * @dev This contract acts as a rebalancer that calls the router's transferRemote directly
 */
contract OftRebalancer {
    using SafeERC20 for IERC20;

    /**
     * @notice Rebalances OFT tokens from one router to another
     * @param router The TokenBridgeOft router contract
     * @param domain The destination domain
     * @param amount The amount of tokens to rebalance
     */
    function rebalanceOft(
        TokenBridgeOft router,
        uint32 domain,
        uint256 amount
    ) external payable {
        // Get the recipient router
        bytes32 recipient = router.routers(domain);
        require(recipient != bytes32(0), "No router enrolled for domain");
        
        // The router already holds the OFT tokens, so we just call transferRemote
        // This avoids the approval issue in _rebalance
        router.transferRemote{value: msg.value}(
            domain,
            recipient,
            amount
        );
    }
}