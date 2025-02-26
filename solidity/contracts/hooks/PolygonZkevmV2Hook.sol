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
import {IInterchainGasPaymaster} from "../interfaces/IInterchainGasPaymaster.sol";

// ============ External Imports ============
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IPolygonZkEVMBridgeV2} from "../interfaces/polygonZkevm/IPolygonZkEVMBridgeV2.sol";
import {MailboxClient} from "../client/MailboxClient.sol";

/**
 * @title PolygonzkEVMv2Hook
 * @notice Message hook to inform the {Polygon zkEVM chain Ism} of messages published through
 * the native Polygon zkEVM bridge bridge.
 */
contract PolygonZkevmV2Hook is IPostDispatchHook, MailboxClient {
    using StandardHookMetadata for bytes;
    using Message for bytes;
    using TypeCasts for bytes32;

    uint256 private constant GAS_LIMIT = 150_000;
    // ============ Immutable Variables ============
    IPolygonZkEVMBridgeV2 public immutable zkEvmBridge;
    IInterchainGasPaymaster public immutable interchainGasPaymaster;
    // address for ISM to verify messages
    // left-padded address for ISM to verify messages
    address public immutable ism;
    // Domain of chain on which the ISM is deployed
    uint32 public immutable destinationDomain;
    // Polygon ZkevmBridge uses networkId 0 for Mainnet and 1 for rollup
    uint32 public immutable zkEvmBridgeDestinationNetId;

    error InvalidContract(string Contract);
    error InvalidInput(string input);

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        address _ism,
        address _zkEvmBridge,
        uint32 _zkEvmBridgeDestinationNetId,
        address _interchainGasPaymaster
    ) MailboxClient(_mailbox) {
        require(
            Address.isContract(_zkEvmBridge),
            "PolygonzkEVMv2Hook: invalid PolygonZkEVMBridge contract"
        );
        require(
            _destinationDomain != 0,
            "PolygonzkEVMv2Hook: invalid destination domain"
        );
        require(
            _zkEvmBridgeDestinationNetId <= 1,
            "PolygonZkevmIsm: invalid ZkEVMBridge destination network id"
        );
        require(
            Address.isContract(_interchainGasPaymaster),
            "PolygonzkEVMv2Hook: invalid Interchain Gas Paymaster contract"
        );
        ism = _ism;
        destinationDomain = _destinationDomain;
        zkEvmBridge = IPolygonZkEVMBridgeV2(_zkEvmBridge);
        zkEvmBridgeDestinationNetId = uint8(_zkEvmBridgeDestinationNetId);
        interchainGasPaymaster = IInterchainGasPaymaster(
            _interchainGasPaymaster
        );
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
    ) external view override returns (uint256) {
        return
            interchainGasPaymaster.quoteGasPayment(
                destinationDomain,
                GAS_LIMIT
            );
    }

    /// @inheritdoc IPostDispatchHook
    function postDispatch(
        bytes calldata _metadata,
        bytes calldata _message
    ) external payable override {
        bytes32 messageId = keccak256(_message);
        uint256 gasPayment = interchainGasPaymaster.quoteGasPayment(
            destinationDomain,
            150_000
        );
        require(
            msg.value - _metadata.msgValue(0) >= gasPayment,
            "PolygonzkEVMv2Hook: msgValue must be more than required gas"
        );

        interchainGasPaymaster.payForGas{value: gasPayment}(
            messageId,
            _metadata.destination(),
            150_000,
            msg.sender
        );

        zkEvmBridge.bridgeMessage{value: msg.value - gasPayment}(
            zkEvmBridgeDestinationNetId,
            address(ism),
            true,
            abi.encode(messageId)
        );
    }

    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.POLYGON_ZKEVM_V2);
    }
}
