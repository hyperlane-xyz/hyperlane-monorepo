// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

/*@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
     @@@@@  HYPERLANE  @@@@@@@
    @@@@@@@@@@@@@@@@@@@@@@@@@
   @@@@@@@@@       @@@@@@@@@
  @@@@@@@@@       @@@@@@@@@
 @@@@@@@@@       @@@@@@@@@
@@@@@@@@@       @@@@@@@@*/

// ============ Internal Imports ============
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {Message} from "../libs/Message.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IPolygonZkEVMBridge} from "../interfaces/polygonZkevm/IPolygonZkEVMBridge.sol";
import {MailboxClient} from "../client/MailboxClient.sol";

/**
 * @title PolygonZkevmHook
 * @notice Message hook to inform the {Polygon zkEVM chain Ism} of messages published through
 * the native Polygon zkEVM bridge bridge.
 */
contract PolygonZkevmHook is IPostDispatchHook, MailboxClient {
    using StandardHookMetadata for bytes;
    using Message for bytes;
    using TypeCasts for bytes32;

    // ============ Immutable Variables ============
    IPolygonZkEVMBridge public immutable zkEvmBridge;

    // left-padded address for ISM to verify messages
    address public immutable ism;
    // Domain of chain on which the ISM is deployed
    uint32 public immutable destinationDomain;
    // Polygon ZkevmBridge uses networkId 0 for Mainnet and 1 for rollup
    uint32 public immutable zkEvmBridgeDestinationNetId;

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        address _ism,
        address _zkEvmBridge,
        uint32 _zkEvmBridgeDestinationNetId
    ) MailboxClient(_mailbox) {
        require(
            Address.isContract(_zkEvmBridge),
            "PolygonzkEVMHook: invalid PolygonZkEVMBridge contract"
        );
        require(
            _destinationDomain != 0,
            "PolygonzkEVMHook: invalid destination domain"
        );
        require(
            _zkEvmBridgeDestinationNetId <= 1,
            "PolygonZkevmIsm: invalid ZkEVMBridge destination network id"
        );
        ism = _ism;
        destinationDomain = _destinationDomain;
        zkEvmBridge = IPolygonZkEVMBridge(_zkEvmBridge);
        zkEvmBridgeDestinationNetId = uint8(_zkEvmBridgeDestinationNetId);
    }

    /// @inheritdoc IPostDispatchHook
    function supportsMetadata(
        bytes calldata
    ) public pure virtual override returns (bool) {
        return true;
    }

    /// @dev This value is hardcoded to 0 because the Polygon zkEVM bridge does not support fee quotes
    function quoteDispatch(
        bytes calldata,
        bytes calldata
    ) external pure override returns (uint256) {
        return 0;
    }

    /// @inheritdoc IPostDispatchHook
    function postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) external payable override {
        require(
            metadata.msgValue(0) < 2 ** 255,
            "PolygonzkEVMHook: msgValue must be less than 2 ** 255"
        );
        bytes32 messageId = message.id();

        zkEvmBridge.bridgeMessage{value: msg.value}(
            zkEvmBridgeDestinationNetId,
            address(ism),
            true,
            abi.encode(messageId)
        );
    }

    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.POLYGON_ZKEVM);
    }
}
