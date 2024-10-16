// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import {CallLib} from "../middleware/libs/Call.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {ICrossDomainMessenger} from "../interfaces/optimism/ICrossDomainMessenger.sol";
import {IL2toL2CrossDomainMessenger} from "../interfaces/optimism/IL2toL2CrossDomainMessenger.sol";
import {ICrossL2Inbox} from "../interfaces/optimism/ICrossL2Inbox.sol";
import {IOptimismPortal} from "../interfaces/optimism/IOptimismPortal.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

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
}

contract MockL2toL2CrossDomainMessenger is IL2toL2CrossDomainMessenger {
    uint256 public messageNonce;
    bool passMessages = true;
    address originCaller;

    function encodeCall(
        address _originCaller,
        address target,
        bytes calldata call
    ) public view returns (bytes memory) {
        return abi.encode(_originCaller, target, call);
    }

    function sendMessage(
        uint256 _destination,
        address _target,
        bytes calldata _message
    ) external returns (bytes32 msgHash_) {}

    /// @notice Relays a message that was sent by the other CrossDomainMessenger contract. Can only
    ///         be executed via cross-chain call from the other messenger OR if the message was
    ///         already received once and is currently being replayed.
    /// @param _id          Identifier of the SentMessage event to be relayed
    /// @param _sentMessage Message payload of the `SentMessage` event
    function relayMessage(
        ICrossL2Inbox.Identifier calldata _id,
        bytes calldata _sentMessage
    ) external payable {
        require(
            passMessages,
            "MockL2toL2CrossDomainMessenger: passMessages is false"
        );
        (address _originCaller, address target, bytes memory call) = abi.decode(
            _sentMessage,
            (address, address, bytes)
        );
        originCaller = _originCaller;
        Address.functionCall(target, call);
    }

    /// @notice Mapping of message hashes to boolean receipt values. Note that a message will only
    ///         be present in this mapping if it has successfully been relayed on this chain, and
    ///         can therefore not be relayed again.
    /// @param _msgHash message hash to check.
    /// @return Returns true if the message corresponding to the `_msgHash` was successfully relayed.
    function successfulMessages(bytes32 _msgHash) external view returns (bool) {
        return true;
    }

    /// @notice Retrieves the sender of the current cross domain message.
    /// @return sender_ Address of the sender of the current cross domain message.
    function crossDomainMessageSender()
        external
        view
        returns (address sender_)
    {
        return originCaller;
    }

    /// @notice Retrieves the source of the current cross domain message.
    /// @return source_ Chain ID of the source of the current cross domain message.
    function crossDomainMessageSource()
        external
        view
        returns (uint256 source_)
    {
        return 0;
    }
}
