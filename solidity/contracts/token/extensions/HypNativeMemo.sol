// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "../HypNative.sol";

// native
contract HypNativeMemo is HypNative {
    event IncludedMemo(bytes memo);
    bytes private _memo;

    constructor(uint256 _scale, address _mailbox) HypNative(_scale, _mailbox) {}

    function transferRemoteMemo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes calldata memo
    ) external payable virtual returns (bytes32 messageId) {
        _memo = memo;
        return super.transferRemote(_destination, _recipient, _amount);
    }

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory) {
        // no super call, parent
        super._transferFromSender(_amount);
        bytes memory memo = _memo;
        delete _memo;
        emit IncludedMemo(memo);
        return memo;
    }
}
