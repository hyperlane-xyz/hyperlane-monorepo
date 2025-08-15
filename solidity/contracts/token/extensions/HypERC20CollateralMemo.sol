// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20Collateral} from "../HypERC20Collateral.sol";

// collateral
contract HypERC20CollateralMemo is HypERC20Collateral {
    event IncludedMemo(bytes memo);
    bytes private _memo;

    constructor(
        address erc20,
        uint256 _scale,
        address _mailbox
    ) HypERC20Collateral(erc20, _scale, _mailbox) {}

    function transferRemoteMemo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amountOrId,
        bytes calldata memo
    ) external payable virtual returns (bytes32 messageId) {
        _memo = memo;
        return
            _transferRemote(_destination, _recipient, _amountOrId, msg.value);
    }

    function _transferFromSender(
        uint256 _amount
    ) internal virtual override returns (bytes memory) {
        super._transferFromSender(_amount);
        bytes memory memo = _memo;
        delete _memo;
        emit IncludedMemo(memo);
        return memo;
    }
}
