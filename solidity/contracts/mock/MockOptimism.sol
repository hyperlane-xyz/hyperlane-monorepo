// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "forge-std/console.sol";

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
        uint256 _nonce,
        address _sender,
        address _target,
        uint256 _value,
        uint256 _minGasLimit,
        bytes calldata _message
    ) external payable {}

    function OTHER_MESSENGER() external view returns (address) {}

    function setXDomainMessageSender(address _sender) external {
        xDomainMessageSender = _sender;
    }

    function setPORTAL(address _portal) external {
        PORTAL = _portal;
    }
}

contract MockOptimismPortal is IOptimismPortal {
    function finalizeWithdrawalTransaction(
        WithdrawalTransaction memory _tx
    ) external {
        (bool success, bytes memory returndata) = _tx.target.call{
            value: _tx.value
        }(_tx.data);
        console.log("success: %s", success);
        if (!success) {
            revert WithdrawalTransactionFailed();
        }
    }
}
