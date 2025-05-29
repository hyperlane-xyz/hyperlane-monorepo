// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {CallLib} from "../middleware/libs/Call.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {ICrossDomainMessenger} from "../interfaces/optimism/ICrossDomainMessenger.sol";
import {IOptimismPortal} from "../interfaces/optimism/IOptimismPortal.sol";
import {IStandardBridge} from "../interfaces/optimism/IStandardBridge.sol";
import {OPL2ToL1Withdrawal} from "../libs/OPL2ToL1Withdrawal.sol";

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

    mapping(bytes32 => ProvenWithdrawal) public _provenWithdrawals;
    mapping(bytes32 => bool) public _finalizedWithdrawals;

    function finalizeWithdrawalTransaction(
        WithdrawalTransaction memory _tx
    ) external {
        CallLib.Call memory call = CallLib.Call(
            TypeCasts.addressToBytes32(_tx.target),
            _tx.value,
            _tx.data
        );
        CallLib.call(call);
        bytes32 withdrawalHash = OPL2ToL1Withdrawal.hashWithdrawal(_tx);
        _finalizedWithdrawals[withdrawalHash] = true;
    }

    function proveWithdrawalTransaction(
        WithdrawalTransaction memory _tx,
        uint256 _disputeGameIndex,
        OutputRootProof memory _outputRootProof,
        bytes[] memory _withdrawalProof
    ) external {
        bytes32 withdrawalHash = OPL2ToL1Withdrawal.hashWithdrawal(_tx);
        _provenWithdrawals[withdrawalHash] = ProvenWithdrawal({
            outputRoot: _outputRootProof.stateRoot,
            timestamp: uint128(block.timestamp),
            l2OutputIndex: uint128(0)
        });
    }

    function finalizedWithdrawals(
        bytes32 _withdrawalHash
    ) external view returns (bool value) {
        return _finalizedWithdrawals[_withdrawalHash];
    }

    function provenWithdrawals(
        bytes32 withdrawalHash
    ) external view returns (ProvenWithdrawal memory) {
        return _provenWithdrawals[withdrawalHash];
    }

    function version() external pure returns (string memory) {
        return "1.0.0";
    }
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
