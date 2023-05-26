// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import "forge-std/console.sol";

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IArbitrumMessageHook} from "../../interfaces/hooks/IArbitrumMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {AddressAliasHelper} from "@arbitrum/nitro-contracts/src/libraries/AddressAliasHelper.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {CrossChainEnabledArbitrumL2} from "@openzeppelin/contracts/crosschain/arbitrum/CrossChainEnabledArbitrumL2.sol";

/**
 * @title ArbitrumISM
 * @notice Uses the native Arbitrum bridge to verify interchain messages.
 */
contract ArbitrumISM is
    IInterchainSecurityModule,
    CrossChainEnabledArbitrumL2,
    Ownable
{
    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.ARBITRUM);

    // ============ Public Storage ============

    IArbitrumMessageHook public l1Hook;
    // mapping to check if the specific messageID from a specific emitter has been received
    // @dev anyone can send an untrusted messageId, so need to check for that while verifying
    mapping(bytes32 => mapping(address => bool)) public receivedEmitters;

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    /**
     * @notice Check if sender is authorized to message `receiveFromHook`.
     */
    modifier isAuthorized() {
        console.log(_crossChainSender());
        console.log(address(l1Hook));

        require(
            AddressAliasHelper.undoL1ToL2Alias(msg.sender) == address(l1Hook),
            "ArbitrumISM: caller is not authorized."
        );
        _;
    }

    // ============ External Functions ============

    /**
     * @notice Set the hook responsible for sending messages from L1.
     * @param _hook Address of the hook.
     */
    function setArbitrumHook(address _hook) external onlyOwner {
        l1Hook = IArbitrumMessageHook(_hook);
    }

    /**
     * @notice Receive a message from the ArbSys precompile.
     * @dev Only callable by the alias of L1 hook.
     * @param _emitter Address of the emitter.
     * @param _messageId Hyperlane ID for the message.
     */
    function receiveFromHook(address _emitter, bytes32 _messageId)
        external
        isAuthorized
    {
        require(_emitter != address(0), "ArbitrumISM: invalid emitter");

        receivedEmitters[_messageId][_emitter] = true;

        emit ReceivedMessage(_messageId, _emitter);
    }

    /**
     * @notice Verify a message was received by ISM.
     * @param _message Message to verify.
     */
    function verify(
        bytes calldata, /*_metadata*/
        bytes calldata _message
    ) external view returns (bool messageVerified) {
        bytes32 _messageId = Message.id(_message);
        address _messageSender = Message.senderAddress(_message);

        messageVerified = receivedEmitters[_messageId][_messageSender];
    }
}
