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
import {Message} from "../../libs/Message.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {MailboxClient} from "../../client/MailboxClient.sol";
import {Indexed} from "../../libs/Indexed.sol";
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

interface ILayerZeroEndpoint {
    // @notice send a LayerZero message to the specified address at a LayerZero endpoint.
    // @param _dstChainId - the destination chain identifier
    // @param _destination - the address on destination chain (in bytes). address length/format may vary by chains
    // @param _payload - a custom bytes payload to send to the destination contract
    // @param _refundAddress - if the source transaction is cheaper than the amount of value passed, refund the additional amount to this address
    // @param _zroPaymentAddress - the address of the ZRO token holder who would pay for the transaction
    // @param _adapterParams - parameters for custom functionality. e.g. receive airdropped native gas from the relayer on destination
    function send(
        uint16 _chainId,
        bytes memory _destination,
        bytes calldata _payload,
        address payable _refundAddress,
        address _zroPaymentAddress,
        bytes memory _adapterParams
    ) external payable;

    // @notice gets a quote in source native gas, for the amount that send() requires to pay for message delivery
    // @param _dstChainId - the destination chain identifier
    // @param _userApplication - the user app address on this EVM chain
    // @param _payload - the custom message to send over LayerZero
    // @param _payInZRO - if false, user app pays the protocol fee in native token
    // @param _adapterParam - parameters for the adapter service, e.g. send some dust native token to dstChain
    function estimateFees(
        uint16 _dstChainId,
        address _userApplication,
        bytes calldata _payload,
        bool _payInZRO,
        bytes calldata _adapterParam
    ) external view returns (uint nativeFee, uint zroFee);
}

contract LayerZeroV1Hook is AbstractPostDispatchHook, MailboxClient, Indexed {
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
