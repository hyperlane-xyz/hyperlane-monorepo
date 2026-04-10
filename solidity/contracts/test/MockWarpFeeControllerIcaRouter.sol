// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {CallLib} from "../middleware/libs/Call.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract MockWarpFeeControllerInterchainAccount {
    using TypeCasts for bytes32;

    function execute(CallLib.Call[] calldata _calls) external payable {
        for (uint256 i = 0; i < _calls.length; i++) {
            address target = _calls[i].to.bytes32ToAddress();
            if (_calls[i].data.length > 0) {
                require(
                    target.code.length > 0,
                    "MockWarpFeeControllerICA: target not contract"
                );
            }
            (bool success, bytes memory returnData) = target.call{
                value: _calls[i].value
            }(_calls[i].data);
            if (!success) {
                assembly {
                    revert(add(returnData, 0x20), mload(returnData))
                }
            }
        }
    }

    receive() external payable {}
}

contract MockWarpFeeControllerIcaRouter {
    uint32 public lastDestination;
    bytes public lastHookMetadata;
    address public immutable remoteIca;
    bytes32 public nextMessageId = bytes32(uint256(0x1234));
    CallLib.Call[] internal lastCalls;

    constructor() {
        remoteIca = address(new MockWarpFeeControllerInterchainAccount());
    }

    function callRemote(
        uint32 _destination,
        CallLib.Call[] calldata _calls,
        bytes calldata _hookMetadata
    ) external payable returns (bytes32) {
        lastDestination = _destination;
        lastHookMetadata = _hookMetadata;
        delete lastCalls;
        for (uint256 i = 0; i < _calls.length; i++) {
            lastCalls.push(_calls[i]);
        }
        MockWarpFeeControllerInterchainAccount(payable(remoteIca)).execute{
            value: msg.value
        }(_calls);
        return nextMessageId;
    }

    function getRemoteInterchainAccount(
        uint32,
        address
    ) external view returns (address) {
        return remoteIca;
    }

    function lastCallsLength() external view returns (uint256) {
        return lastCalls.length;
    }

    function getLastCall(
        uint256 index
    ) external view returns (bytes32 to, uint256 value, bytes memory data) {
        CallLib.Call storage call = lastCalls[index];
        return (call.to, call.value, call.data);
    }
}

contract MockWarpFeeRemoteBridge {
    using SafeERC20 for IERC20;
    using TypeCasts for bytes32;

    IERC20 public immutable token;
    uint32 public lastDestination;
    bytes32 public lastRecipient;
    uint256 public lastAmount;

    constructor(address _token) {
        token = IERC20(_token);
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable returns (bytes32) {
        lastDestination = _destination;
        lastRecipient = _recipient;
        lastAmount = _amount;
        token.safeTransferFrom(
            msg.sender,
            _recipient.bytes32ToAddress(),
            _amount
        );
        return bytes32(uint256(0xbeef));
    }
}
