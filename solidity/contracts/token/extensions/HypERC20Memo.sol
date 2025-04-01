// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypERC20} from "../HypERC20.sol";

/**
 * @title Hyperlane ERC20 router extending HypERC20 with opaque memos
 * @author Dymension
 * @dev Supply on each chain is not constant but the aggregate supply across all chains is.
 */
contract HypERC20Memo is HypERC20 {
    bytes private _pendingMemo;

    constructor(
        uint8 __decimals,
        uint256 _scale,
        address _mailbox
    ) HypERC20(__decimals, _scale, _mailbox) {}

    function transferRemoteWithMemo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes calldata _memo
    ) external payable returns (bytes32) {
        require(_pendingMemo.length == 0, "Transfer in progress");

        _pendingMemo = _memo;
        bytes32 messageId = super.transferRemote(
            _destination,
            _recipient,
            _amount
        );
        delete _pendingMemo;
        return messageId;
    }

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory) {
        super._transferFromSender(_amount);
        bytes memory memo = _pendingMemo;
        return memo;
    }
}
