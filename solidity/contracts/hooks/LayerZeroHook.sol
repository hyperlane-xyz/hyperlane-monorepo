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

import {Message} from "../libs/Message.sol";
import {MailboxClient} from "../client/MailboxClient.sol";
import {Indexed} from "../libs/Indexed.sol";
import {IPostDispatchHook} from "../interfaces/hooks/IPostDispatchHook.sol";
import {AbstractPostDispatchHook} from "./libs/AbstractPostDispatchHook.sol";
import {StandardHookMetadata} from "./libs/StandardHookMetadata.sol";

struct LayerZeroMetadata {
    /// @dev the destination chain identifier
    uint16 dstChainId;
    /// @dev the user app address on this EVM chain
    address userApplication;
    /// @dev if the source transaction is cheaper than the amount of value passed, refund the additional amount to this address
    address refundAddress;
    /// @dev the custom message to send over LayerZero
    bytes payload;
    /// @dev the address on destination chain (in bytes). address length/format may vary by chains
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

contract LayerZeroHook is AbstractPostDispatchHook, MailboxClient, Indexed {
    using StandardHookMetadata for bytes;
    using Message for bytes;

    ILayerZeroEndpoint immutable lZEndpoint;

    // In bytes
    uint8 private constant DST_CHAIN_ID_OFFSET = 0;
    uint8 private constant USER_APP_ADDR_OFFSET = 2;
    uint8 private constant REFUND_ADDR_OFFSET = 22;

    constructor(address _mailbox, address _lZEndpoint) MailboxClient(_mailbox) {
        lZEndpoint = ILayerZeroEndpoint(_lZEndpoint);
    }

    // ============ External Functions ============

    /// @inheritdoc IPostDispatchHook
    function hookType() external pure override returns (uint8) {
        return uint8(IPostDispatchHook.Types.LAYER_ZERO);
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
        (
            uint16 dstChainId,
            ,
            address payable refundAddress,
            bytes memory payload,
            bytes memory destination,
            bytes memory adapterParam
        ) = parseLzMetadata(lZMetadata);

        /// @dev _zroPaymentAddress is hardcoded to addr(0) because zro tokens should not be used
        lZEndpoint.send{value: msg.value}(
            dstChainId,
            destination,
            payload,
            refundAddress,
            address(0),
            adapterParam
        );
    }

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view virtual override returns (uint256 nativeFee) {
        bytes calldata lZMetadata = metadata.getCustomMetadata();
        (
            uint16 dstChainId,
            address userApplication,
            ,
            bytes memory payload,
            ,
            bytes memory adapterParam
        ) = parseLzMetadata(lZMetadata);

        (nativeFee, ) = lZEndpoint.estimateFees(
            dstChainId,
            userApplication,
            payload,
            false,
            adapterParam
        );
    }

    /**
     * @notice Formats LayerZero metadata using default abi encoding
     * @param layerZeroMetadata LayerZero specific metadata
     * @return ABI encoded metadata
     */
    function formatLzMetadata(
        LayerZeroMetadata calldata layerZeroMetadata
    ) public view returns (bytes memory) {
        return
            abi.encode(
                layerZeroMetadata.dstChainId,
                layerZeroMetadata.userApplication,
                layerZeroMetadata.refundAddress,
                layerZeroMetadata.payload,
                layerZeroMetadata.destination,
                layerZeroMetadata.adapterParam
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
        view
        returns (
            uint16 dstChainId,
            address userApplication,
            address payable refundAddress,
            bytes memory payload,
            bytes memory destination,
            bytes memory adapterParam
        )
    {
        (
            dstChainId,
            userApplication,
            refundAddress,
            payload,
            destination,
            adapterParam
        ) = abi.decode(
            lZMetadata,
            (uint16, address, address, bytes, bytes, bytes)
        );
    }
}
