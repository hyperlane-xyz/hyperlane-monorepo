// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IXERC20Lockbox} from "../interfaces/IXERC20Lockbox.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";

contract HypXERC20Lockbox is HypERC20Collateral {
    IXERC20Lockbox public immutable lockbox;

    constructor(
        address _lockbox,
        address _mailbox
    ) HypERC20Collateral(address(IXERC20Lockbox(_lockbox).ERC20()), _mailbox) {
        lockbox = IXERC20Lockbox(_lockbox);
    }

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory) {
        super._transferFromSender(_amount);
        lockbox.deposit(_amount);
        return bytes("");
    }

    function _transferTo(
        address _recipient,
        uint256 _amountOrId,
        bytes calldata /*metadata*/
    ) internal override {
        lockbox.withdrawTo(_recipient, _amountOrId);
    }
}
