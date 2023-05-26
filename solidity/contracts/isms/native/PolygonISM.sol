// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IPolygonMessageHook} from "../../interfaces/hooks/IPolygonMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";

import {FxBaseChildTunnel} from "fx-portal/contracts/tunnel/FxBaseChildTunnel.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title PolygonISM
 * @notice Uses the native Polygon tunnel to verify interchain messages.
 */
contract PolygonISM is IInterchainSecurityModule, FxBaseChildTunnel, Ownable {
    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.POLYGON);

    // ============ Public Storage ============

    // Hook deployed on L1 responsible for sending message via the Polygon tunnel
    IPolygonMessageHook public l1Hook;
    // mapping to check if the specific messageID from a specific emitter has been received
    // @dev anyone can send an untrusted messageId, so need to check for that while verifying
    mapping(bytes32 => mapping(address => bool)) public receivedEmitters;

    // ============ Events ============

    event ReceivedMessage(bytes32 indexed messageId, address indexed emitter);

    // ============ Constructor ============

    constructor(address _fxChild) FxBaseChildTunnel(_fxChild) {}

    // ============ External Functions ============

    function setPolygonHook(address _hook) external {
        require(_hook != address(0), "PolygonISM: invalid hook address");

        l1Hook = IPolygonMessageHook(_hook);
        fxRootTunnel = _hook;
    }

    /// @inheritdoc FxBaseChildTunnel
    function _processMessageFromRoot(
        uint256, /* _stateId */
        address _sender,
        bytes memory _data
    ) internal override validateSender(_sender) {
        (address _emitter, bytes32 _messageId) = abi.decode(
            _data,
            (address, bytes32)
        );

        require(_emitter != address(0), "PolygonISM: invalid emitter");

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
