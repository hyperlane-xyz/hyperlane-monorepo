// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {CallLib} from "../middleware/libs/Call.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {ICrossDomainMessenger} from "../interfaces/optimism/ICrossDomainMessenger.sol";
import {IOptimismPortal} from "../interfaces/optimism/IOptimismPortal.sol";

// for both L1 and L2
contract MockOptimismMessenger is ICrossDomainMessenger {
    address public xDomainMessageSender;
    address public PORTAL;

    function sendMessage(
        address _target,
        bytes calldata _message,
        uint32 _gasLimit
    ) external payable {}

    function relayMessage(
        uint256 /*_nonce*/,
        address /*_sender*/,
        address _target,
        uint256 _value,
        uint256 /*_minGasLimit*/,
        bytes calldata _message
    ) external payable {
        CallLib.Call memory call = CallLib.Call(
            TypeCasts.addressToBytes32(_target),
            _value,
            _message
        );
        CallLib.call(call);
    }

    function OTHER_MESSENGER() external view returns (address) {}

    function setXDomainMessageSender(address _sender) external {
        xDomainMessageSender = _sender;
    }

    function setPORTAL(address _portal) external {
        PORTAL = _portal;
    }
}

// mock deployment on L1
contract MockOptimismPortal is IOptimismPortal {
    error WithdrawalTransactionFailed();

    function finalizeWithdrawalTransaction(
        WithdrawalTransaction memory _tx
    ) external {
        CallLib.Call memory call = CallLib.Call(
            TypeCasts.addressToBytes32(_tx.target),
            _tx.value,
            _tx.data
        );
        CallLib.call(call);
    }

    function proveWithdrawalTransaction(
        WithdrawalTransaction memory _tx,
        uint256 _disputeGameIndex,
        OutputRootProof memory _outputRootProof,
        bytes[] memory _withdrawalProof
    ) external {}
}
