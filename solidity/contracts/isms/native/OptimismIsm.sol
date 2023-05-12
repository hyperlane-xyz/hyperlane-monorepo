// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimismMessageHook} from "../../interfaces/hooks/IOptimismMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";

contract OptimismIsm is IInterchainSecurityModule {
    mapping(bytes32 => bool) public receivedEmitters;

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    modifier onlyOwner() {
        require(
            msg.sender == address(l2Messenger),
            "OptimismIsm: caller is not the native Optimism messenger"
        );
        _;
    }

    ICrossDomainMessenger public l2Messenger;
    IOptimismMessageHook public hook;

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NATIVE);

    function setOptimismMessenger(ICrossDomainMessenger _l2Messenger) external {
        l2Messenger = _l2Messenger;
    }

    function setOptimismHook(IOptimismMessageHook _hook) external {
        hook = _hook;
    }

    function receiveFromHook(bytes32 _messageId, address _emitter)
        external
        onlyOwner
    {
        require(_emitter == address(hook), "OptimismIsm: invalid emitter");

        receivedEmitters[_messageId] = true;
    }

    function verify(
        bytes calldata, /*_metadata*/
        bytes calldata _message
    ) external returns (bool) {
        bytes32 messageId = keccak256(_message);

        // (, address l1Hook) = abi.decode(_metadata, (bytes32, address));

        // require(l1Hook != address(0), "OptimismIsm: invalid l1Hook");

        require(
            receivedEmitters[messageId],
            "OptimismIsm: message not received"
        );

        receivedEmitters[messageId] = true;

        return true;
    }
}
