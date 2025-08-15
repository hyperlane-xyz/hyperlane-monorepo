// SPDX-License-Identifier: Apache-2.0
pragma solidity >=0.8.0;

import {HypNative} from "../HypNative.sol";

// native
contract HypNativeMemo is HypNative {
    event IncludedMemo(bytes memo);
    bytes private _memo;
    uint256 private _transferFromSenderCallCount;

    constructor(uint256 _scale, address _mailbox) HypNative(_scale, _mailbox) {}

    function transferRemoteMemo(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount,
        bytes calldata memo
    ) external payable virtual returns (bytes32 messageId) {
        _memo = memo;
        _transferFromSenderCallCount = 0;
        return super.transferRemote(_destination, _recipient, _amount);
    }

    function _transferFromSender(
        uint256 _amount
    ) internal override returns (bytes memory) {
        // Check msg.value without calling super to avoid double-processing
        require(msg.value >= _amount, "Native: amount exceeds msg.value");

        _transferFromSenderCallCount++;

        // First call is from HypNative._transferRemote (return value ignored)
        // Second call is from TokenRouter._transferRemote (return value used)
        if (_transferFromSenderCallCount == 1) {
            // First call - return empty, keep memo for second call
            return bytes("");
        } else {
            // Second call - return the actual memo
            bytes memory memo = _memo;
            delete _memo;
            delete _transferFromSenderCallCount;
            emit IncludedMemo(memo);
            return memo;
        }
    }
}
