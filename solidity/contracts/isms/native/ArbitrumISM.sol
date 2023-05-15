// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IArbitrumMessageHook} from "../../interfaces/hooks/IArbitrumMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {AddressAliasHelper} from "@arbitrum/nitro-contracts/src/libraries/AddressAliasHelper.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract ArbitrumISM is IInterchainSecurityModule, Ownable {
    mapping(bytes32 => mapping(address => bool)) public receivedEmitters;

    IArbitrumMessageHook public l1Hook;

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.ARBITRUM);

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    /**
     * @notice Check if sender is authorized to message `receiveFromHook`.
     */
    modifier isAuthorized() {
        require(
            msg.sender == AddressAliasHelper.applyL1ToL2Alias(address(l1Hook)),
            "ArbitrumISM: caller is not the owner"
        );

        _;
    }

    constructor() {}

    function setArbitrumHook(IArbitrumMessageHook _hook) external onlyOwner {
        l1Hook = _hook;
    }

    function receiveFromHook(bytes32 _messageId, address _emitter)
        external
        isAuthorized
    {
        require(_emitter != address(0), "ArbitrumISM: invalid emitter");

        receivedEmitters[_messageId][_emitter] = true;

        emit ReceivedMessage(_messageId, _emitter);
    }

    function verify(
        bytes calldata, /*_metadata*/
        bytes calldata _message
    ) external view returns (bool messageVerified) {
        bytes32 _messageId = Message.id(_message);
        address _messageSender = Message.senderAddress(_message);

        messageVerified = receivedEmitters[_messageId][_messageSender];
    }
}
