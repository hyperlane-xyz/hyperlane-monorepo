// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IOptimismMessageHook} from "../../interfaces/hooks/IOptimismMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

contract OptimismIsm is IInterchainSecurityModule {
    mapping(bytes32 => bytes32) public receivedEmitters;

    modifier onlyHook() {
        require(
            msg.sender == address(hook),
            "OptimismIsm: caller is not the hook"
        );
        _;
    }

    IOptimismMessageHook public hook;

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.NATIVE);

    function setHook(IOptimismMessageHook _hook) external {
        hook = _hook;
    }

    function receiveFromHook(bytes32 _messageId, address _caller)
        external
        onlyHook
    {
        receivedEmitters[_messageId] = TypeCasts.addressToBytes32(_caller);
    }

    function emitterAndPayload(bytes calldata _message)
        public
        view
        virtual
        returns (bytes32, bytes memory)
    {
        // TODO: fix
        bytes32 _emitter = bytes32(0);
        bytes32 _id = Message.id(_message);
        bytes memory _payload = abi.encodePacked(_emitter, _id);

        // uint32 _origin = 1;

        // TODO: fix
        return (bytes32(0), _payload);
    }

    function verify(bytes calldata _metadata, bytes calldata _message)
        external
        returns (bool)
    {
        (bytes32 emitter, ) = emitterAndPayload(_message);

        bytes32 msgId = abi.decode(_metadata, (bytes32));

        require(
            receivedEmitters[msgId] == emitter,
            "OptimismIsm: incorrect emitter"
        );

        return true;
    }
}
