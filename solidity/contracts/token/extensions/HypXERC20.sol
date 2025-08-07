// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IXERC20} from "../interfaces/IXERC20.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";
import {TokenRouter} from "../libs/TokenRouter.sol";

contract HypXERC20 is HypERC20Collateral {
    constructor(
        address _xerc20,
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(_xerc20, _scale, _mailbox) {
        _disableInitializers();
    }

    // ============ TokenRouter overrides ============

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to burn tokens on outbound transfer.
     */
    function _transferFromSender(uint256 _amountOrId) internal override {
        IXERC20(address(wrappedToken)).burn(msg.sender, _amountOrId);
    }

    /**
     * @inheritdoc TokenRouter
     * @dev Overrides to mint tokens on inbound transfer.
     */
    function _transferTo(
        address _recipient,
        uint256 _amountOrId
    ) internal override {
        IXERC20(address(wrappedToken)).mint(_recipient, _amountOrId);
    }
}
