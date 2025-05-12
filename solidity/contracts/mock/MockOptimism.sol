// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {CallLib} from "../middleware/libs/Call.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {ICrossDomainMessenger} from "../interfaces/optimism/ICrossDomainMessenger.sol";
import {IOptimismPortal} from "../interfaces/optimism/IOptimismPortal.sol";
import {IStandardBridge} from "../interfaces/optimism/IStandardBridge.sol";

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

    function baseGas(
        bytes calldata _message,
        uint32 _minGasLimit
    ) external pure returns (uint64) {
        return 0;
    }

    function messageNonce() public view returns (uint256) {
        return 0;
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

    function finalizedWithdrawals(
        bytes32 _withdrawalHash
    ) external returns (bool value) {}
}

// mock deployment on L2
contract MockOptimismStandardBridge is IStandardBridge {
    function MESSENGER() public view returns (ICrossDomainMessenger) {
        return
            ICrossDomainMessenger(0x4200000000000000000000000000000000000007);
    }

    function OTHER_BRIDGE() public view returns (IStandardBridge) {
        return
            IStandardBridge(
                payable(0xFBb0621E0B23b5478B630BD55a5f21f67730B0F1)
            );
    }

    function messenger() external view returns (ICrossDomainMessenger) {
        return MESSENGER();
    }

    function otherBridge() external view returns (IStandardBridge) {
        return OTHER_BRIDGE();
    }

    function bridgeERC20(
        address _localToken,
        address _remoteToken,
        uint256 _amount,
        uint32 _minGasLimit,
        bytes memory _extraData
    ) external {}

    function bridgeERC20To(
        address _localToken,
        address _remoteToken,
        address _to,
        uint256 _amount,
        uint32 _minGasLimit,
        bytes memory _extraData
    ) external {}

    function bridgeETH(
        uint32 _minGasLimit,
        bytes memory _extraData
    ) external payable {}

    function bridgeETHTo(
        address _to,
        uint32 _minGasLimit,
        bytes memory _extraData
    ) external payable {}

    function deposits(address, address) external view returns (uint256) {}

    function finalizeBridgeERC20(
        address _localToken,
        address _remoteToken,
        address _from,
        address _to,
        uint256 _amount,
        bytes memory _extraData
    ) external {}

    function finalizeBridgeETH(
        address _from,
        address _to,
        uint256 _amount,
        bytes memory _extraData
    ) external payable {}

    function paused() external view returns (bool) {}

    function __constructor__() external {}

    receive() external payable {}
}

// mock contract on L2
contract MockL2ToL1MessagePasser {
    uint16 public constant MESSAGE_VERSION = 1;

    function messageNonce() public view returns (uint256) {
        return 0;
    }
}
