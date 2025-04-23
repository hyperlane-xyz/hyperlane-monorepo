// SPDX-License-Identifier: MIT
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
import {ILayerZeroEndpoint} from "@layerzerolabs/lz-evm-v1-0.7/contracts/interfaces/ILayerZeroEndpoint.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";
import {IPostDispatchHook} from "../../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "../libs/AbstractPostDispatchHook.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";

struct LayerZeroMetadata {
    /// @dev the destination chain identifier
    uint16 dstChainId;
    /// @dev the user app address on this EVM chain. Contract address that calls Endpoint.send(). Used for LZ user app config lookup
    address userApplication;
    /// @dev if the source transaction is cheaper than the amount of value passed, refund the additional amount to this address
    address refundAddress;
    /// @dev the custom message to send over LayerZero
    bytes payload;
    /// @dev the address on destination chain (in bytes). A 40 length byte with remote and local addresses concatenated.
    bytes destination;
    /// @dev  parameters for the adapter service, e.g. send some dust native token to dstChain
    bytes adapterParam;
}

contract LayerZeroV1Hook is AbstractPostDispatchHook, MailboxClient {
    using StandardHookMetadata for bytes;
    using Message for bytes;
    using TypeCasts for bytes32;

    ILayerZeroEndpoint public immutable lZEndpoint;

    constructor(address _mailbox, address _lZEndpoint) MailboxClient(_mailbox) {
        lZEndpoint = ILayerZeroEndpoint(_lZEndpoint);
    }

    // ============ External Functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.LAYER_ZERO_V1);
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _postDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal virtual override {
        // ensure hook only dispatches messages that are dispatched by the mailbox
        bytes32 id = message.id();
        require(_isLatestDispatched(id), "message not dispatched by mailbox");

        bytes calldata lZMetadata = metadata.getCustomMetadata();
        LayerZeroMetadata memory layerZeroMetadata = parseLzMetadata(
            lZMetadata
        );
        lZEndpoint.send{value: msg.value}(
            layerZeroMetadata.dstChainId,
            layerZeroMetadata.destination,
            layerZeroMetadata.payload,
            payable(layerZeroMetadata.refundAddress),
            address(0), // _zroPaymentAddress is hardcoded to addr(0) because zro tokens should not be directly accepted
            layerZeroMetadata.adapterParam
        );
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata
    ) internal view virtual override returns (uint256 nativeFee) {
        bytes calldata lZMetadata = metadata.getCustomMetadata();
        LayerZeroMetadata memory layerZeroMetadata = parseLzMetadata(
            lZMetadata
        );
        (nativeFee, ) = lZEndpoint.estimateFees(
            layerZeroMetadata.dstChainId,
            layerZeroMetadata.userApplication,
            layerZeroMetadata.payload,
            false, // _payInZRO is hardcoded to false because zro tokens should not be directly accepted
            layerZeroMetadata.adapterParam
        );
    }

    /**
     * @notice Formats LayerZero metadata using default abi encoding
     * @param layerZeroMetadata LayerZero specific metadata
     * @return ABI encoded metadata
     */
    function formatLzMetadata(
        LayerZeroMetadata calldata layerZeroMetadata
    ) public pure returns (bytes memory) {
        return abi.encode(layerZeroMetadata);
    }

    /**
     * @notice Decodes LayerZero metadata. Should be used after formatLzMetadata()
     * @param lZMetadata ABI encoded metadata
     */
    function parseLzMetadata(
        bytes calldata lZMetadata
    ) public pure returns (LayerZeroMetadata memory parsedLayerZeroMetadata) {
        (parsedLayerZeroMetadata) = abi.decode(lZMetadata, (LayerZeroMetadata));
    }
}
