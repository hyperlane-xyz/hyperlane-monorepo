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
import {MessagingParams, MessagingFee, ILayerZeroEndpointV2} from "@layerzerolabs/lz-evm-protocol-v2/contracts/interfaces/ILayerZeroEndpointV2.sol";
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {AbstractMessageIdAuthHook} from "../libs/AbstractMessageIdAuthHook.sol";
import {AbstractMessageIdAuthorizedIsm} from "../../isms/hook/AbstractMessageIdAuthorizedIsm.sol";
import {StandardHookMetadata} from "../libs/StandardHookMetadata.sol";

struct LayerZeroV2Metadata {
    /// @dev the endpoint Id. prev dstChainId
    uint32 eid;
    /// @dev if the source transaction is cheaper than the amount of value passed, refund the additional amount to this address
    address refundAddress;
    /// @dev  parameters for the adapter service, e.g. send some dust native token to dstChain. prev adapterParam
    bytes options;
}

contract LayerZeroV2Hook is AbstractMessageIdAuthHook {
    using StandardHookMetadata for bytes;
    using Message for bytes;
    using TypeCasts for bytes32;

    ILayerZeroEndpointV2 public immutable lZEndpoint;

    /// @dev offset for Layer Zero metadata parsing
    uint8 constant EID_OFFSET = 0;
    uint8 constant REFUND_ADDRESS_OFFSET = 4;
    uint8 constant OPTIONS_OFFSET = 24;

    constructor(
        address _mailbox,
        uint32 _destinationDomain,
        bytes32 _ism,
        address _lZEndpoint
    ) AbstractMessageIdAuthHook(_mailbox, _destinationDomain, _ism) {
        lZEndpoint = ILayerZeroEndpointV2(_lZEndpoint);
    }

    // ============ External Functions ============

    /// @inheritdoc AbstractMessageIdAuthHook
    function _sendMessageId(
        bytes calldata metadata,
        bytes calldata message
    ) internal override {
        bytes memory payload = abi.encodeCall(
            AbstractMessageIdAuthorizedIsm.preVerifyMessage,
            (message.id(), metadata.msgValue(0))
        );

        bytes calldata lZMetadata = metadata.getCustomMetadata();
        (
            uint32 eid,
            address refundAddress,
            bytes memory options
        ) = parseLzMetadata(lZMetadata);

        // Build and send message
        MessagingParams memory msgParams = MessagingParams(
            eid,
            ism,
            payload,
            options,
            false // payInLzToken
        );

        uint256 quote = _quoteDispatch(metadata, message);
        lZEndpoint.send{value: quote}(msgParams, refundAddress);
    }

    /// @dev payInZRO is hardcoded to false because zro tokens should not be directly accepted
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view virtual override returns (uint256) {
        bytes calldata lZMetadata = metadata.getCustomMetadata();
        (uint32 eid, , bytes memory options) = parseLzMetadata(lZMetadata);

        // Build and quote message
        MessagingParams memory msgParams = MessagingParams(
            eid,
            message.recipient(),
            message.body(),
            options,
            false // payInLzToken
        );
        MessagingFee memory msgFee = lZEndpoint.quote(
            msgParams,
            message.senderAddress()
        );

        return metadata.msgValue(0) + msgFee.nativeFee;
    }

    /**
     * @notice Formats LayerZero metadata using default abi encoding
     * @param layerZeroMetadata LayerZero specific metadata
     * @return ABI encoded metadata
     */
    function formatLzMetadata(
        LayerZeroV2Metadata calldata layerZeroMetadata
    ) public pure returns (bytes memory) {
        return
            abi.encodePacked(
                layerZeroMetadata.eid,
                layerZeroMetadata.refundAddress,
                layerZeroMetadata.options
            );
    }

    /**
     * @notice Decodes LayerZero metadata. Should be used after formatLzMetadata()
     * @param lZMetadata ABI encoded metadata
     */
    function parseLzMetadata(
        bytes calldata lZMetadata
    )
        public
        pure
        returns (uint32 eid, address refundAddress, bytes memory options)
    {
        eid = uint32(bytes4(lZMetadata[EID_OFFSET:REFUND_ADDRESS_OFFSET]));
        refundAddress = address(
            bytes20(lZMetadata[REFUND_ADDRESS_OFFSET:OPTIONS_OFFSET])
        );
        options = lZMetadata[OPTIONS_OFFSET:];
    }
}
