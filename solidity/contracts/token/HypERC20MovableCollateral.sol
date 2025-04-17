// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

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
import {HypERC20Collateral} from "./HypERC20Collateral.sol";
import {MovableCollateralRouter} from "./libs/MovableCollateralRouter.sol";
import {ValueTransferBridge} from "./libs/ValueTransferBridge.sol";

// ============ External Imports ============
import {Context} from "@openzeppelin/contracts/utils/Context.sol";
import {ContextUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ContextUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title Adds rebalancing capability to HypERC20Collateral.
 * @author Abacus Works
 */
contract HypERC20MovableCollateral is
    HypERC20Collateral,
    MovableCollateralRouter
{
    using SafeERC20 for IERC20;
    /**
     * @notice Constructor
     * @param erc20 Address of the token to keep as collateral
     */
    constructor(
        address erc20,
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(erc20, _scale, _mailbox) {}

    function _moveCollateral(
        uint32 domain,
        bytes32 recipient,
        uint256 amount,
        ValueTransferBridge bridge
    ) internal override {
        wrappedToken.safeApprove({spender: address(bridge), value: amount});
        MovableCollateralRouter._moveCollateral({
            domain: domain,
            recipient: recipient,
            amount: amount,
            bridge: bridge
        });
    }

    function _msgData()
        internal
        view
        virtual
        override(Context, ContextUpgradeable)
        returns (bytes calldata)
    {
        return ContextUpgradeable._msgData();
    }

    function _msgSender()
        internal
        view
        virtual
        override(Context, ContextUpgradeable)
        returns (address)
    {
        return ContextUpgradeable._msgSender();
    }
}
