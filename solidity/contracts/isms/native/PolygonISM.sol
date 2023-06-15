// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

// ============ Internal Imports ============

import {IInterchainSecurityModule} from "../../interfaces/IInterchainSecurityModule.sol";
import {IPolygonMessageHook} from "../../interfaces/hooks/IPolygonMessageHook.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractNativeISM} from "./AbstractNativeISM.sol";

// ============ External Imports ============

import {FxBaseChildTunnel} from "@maticnetwork/fx-portal/contracts/tunnel/FxBaseChildTunnel.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

/**
 * @title PolygonISM
 * @notice Uses the native Polygon tunnel to verify interchain messages.
 */
contract PolygonISM is FxBaseChildTunnel, AbstractNativeISM {
    // ============ Constants ============

    // solhint-disable-next-line const-name-snakecase
    uint8 public constant moduleType =
        uint8(IInterchainSecurityModule.Types.POLYGON);

    // ============ Public Storage ============

    // Hook deployed on L1 responsible for sending message via the Polygon tunnel
    IPolygonMessageHook public l1Hook;

    // ============ Constructor ============

    constructor(address _fxChild) FxBaseChildTunnel(_fxChild) {}

    // ============ External Functions ============

    /**
     * @notice Set the hook responsible for sending messages from L1.
     * @param _hook Address of the hook.
     */
    function setPolygonHook(address _hook) external {
        l1Hook = IPolygonMessageHook(_onlyContract(_hook, "hook"));
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

        _setEmitter(_emitter, _messageId);

        emit ReceivedMessage(_emitter, _messageId);
    }

    // ============ Internal Functions ============

    function _onlyContract(address _contract, string memory _type)
        internal
        view
        returns (address)
    {
        require(
            Address.isContract(_contract),
            string.concat("PolygonISM: invalid ", _type)
        );
        return _contract;
    }
}
