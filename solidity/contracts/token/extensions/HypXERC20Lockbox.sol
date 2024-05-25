// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IXERC20Lockbox} from "../interfaces/IXERC20Lockbox.sol";
import {IXERC20, IERC20} from "../interfaces/IXERC20.sol";
import {HypERC20Collateral} from "../HypERC20Collateral.sol";

contract HypXERC20Lockbox is HypERC20Collateral {
    uint256 constant MAX_INT = 2 ** 256 - 1;

    IXERC20Lockbox public immutable lockbox;
    IXERC20 public immutable xERC20;

    constructor(
        address _lockbox,
        address _mailbox
    ) HypERC20Collateral(address(IXERC20Lockbox(_lockbox).ERC20()), _mailbox) {
        lockbox = IXERC20Lockbox(_lockbox);
        xERC20 = lockbox.XERC20();

        // grant infinite approvals to lockbox
        require(
            IERC20(wrappedToken).approve(_lockbox, MAX_INT),
            "erc20 lockbox approve failed"
        );
        require(
            xERC20.approve(_lockbox, MAX_INT),
            "xerc20 lockbox approve failed"
        );
    }

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory) {
        // transfer erc20 from sender
        super._transferFromSender(_amount);
        // convert erc20 to xERC20
        lockbox.deposit(_amount);
        // burn xERC20
        xERC20.burn(address(this), _amount);
        return bytes("");
    }

    function _transferTo(
        address _recipient,
        uint256 _amount,
        bytes calldata /*metadata*/
    ) internal override {
        // mint xERC20
        xERC20.mint(address(this), _amount);
        // convert xERC20 to erc20
        lockbox.withdrawTo(_recipient, _amount);
    }
}
