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
 * @title PolygonZkevmHook
 * @notice Message hook to inform the {Polygon zkEVM chain Ism} of messages published through
 * the native Polygon zkEVM bridge bridge.
 */
contract PolygonZkevmHook is IPostDispatchHook, MailboxClient {
    using StandardHookMetadata for bytes;
    using Message for bytes;
    using TypeCasts for bytes32;

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
        require(
            Address.isContract(_interchainGasPaymaster),
            "PolygonzkEVMHook: invalid Interchain Gas Paymaster contract"
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
            interchainGasPaymaster.quoteGasPayment(destinationDomain, 150_000);
    }

    /// @inheritdoc IPostDispatchHook
    function postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) external payable override {
        require(
            metadata.msgValue(0) >=
                interchainGasPaymaster.quoteGasPayment(
                    destinationDomain,
                    150_000
                ),
            "PolygonzkEVMHook: msgValue must be more than required gas"
        );
        bytes32 messageId = message.id();

        interchainGasPaymaster.payForGas(
            messageId,
            message.destination(),
            150_000,
            msg.sender
        );

        zkEvmBridge.bridgeMessage{value: msg.value}(
            zkEvmBridgeDestinationNetId,
            address(ism),
            true,
            abi.encode(messageId)
        );
    }

    function hookType() external view override returns (uint8) {}
}
