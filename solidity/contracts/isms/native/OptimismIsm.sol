// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimismMessageHook} from "../../interfaces/hooks/IOptimismMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {ICrossDomainMessenger} from "@eth-optimism/contracts/libraries/bridge/ICrossDomainMessenger.sol";
import {CrossDomainOwnable3} from "@eth-optimism/contracts-bedrock/contracts/L2/CrossDomainOwnable3.sol";

contract OptimismIsm is IInterchainSecurityModule, CrossDomainOwnable3 {
    mapping(bytes32 => bool) public receivedEmitters;

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    constructor(ICrossDomainMessenger _l2Messenger) {
        l2Messenger = _l2Messenger;
    }

    ICrossDomainMessenger public l2Messenger;
    IOptimismMessageHook public hook;

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NATIVE);

    function setOptimismHook(IOptimismMessageHook _hook) external {
        hook = _hook;
    }

    function receiveFromHook(bytes32 _messageId, address _emitter)
        external
    // onlyOwner
    {
        _isAuthorized(hook);
        // require(_emitter != address(0), "OptimismIsm: invalid emitter");

        receivedEmitters[_messageId] = true;

        emit ReceivedMessage(_messageId, _emitter);
    }

    function verify(
        bytes calldata, /*_metadata*/
        bytes calldata _message
    ) external returns (bool messageVerified) {
        bytes32 messageId = keccak256(_message);
        messageVerified = receivedEmitters[messageId];

        if (messageVerified) receivedEmitters[messageId] = false;
    }

    /**
     * @notice Check if sender is authorized to message `receiveFromHook`.
     * @param _hook Address of the hook on the Ethereum chain
     */
    function _isAuthorized(IOptimismMessageHook _hook) internal view {
        ICrossDomainMessenger _l2Messenger = l2Messenger;

        require(
            msg.sender == address(_l2Messenger),
            "OptimismIsm: caller is not the messenger"
        );

        require(
            _l2Messenger.xDomainMessageSender() == address(_hook),
            "OptimismIsm: caller is not the owner"
        );
    }
}
