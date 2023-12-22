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
import "forge-std/console.sol";

struct LayerZeroMetadata {
    /// @dev the destination chain identifier
    uint16 _dstChainId;
    /// @dev the user app address on this EVM chain
    address _userApplication;
    /// @dev if the source transaction is cheaper than the amount of value passed, refund the additional amount to this address
    address _refundAddress;
    /// @dev the custom message to send over LayerZero
    bytes _payload;
    /// @dev the address on destination chain (in bytes). address length/format may vary by chains
    bytes _destination;
    /// @dev  parameters for the adapter service, e.g. send some dust native token to dstChain
    bytes _adapterParam;
}

interface ILayerZeroEndpoint {
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
    ) internal virtual override {}

    /// @inheritdoc AbstractPostDispatchHook
    function _quoteDispatch(
        bytes calldata metadata,
        bytes calldata message
    ) internal view virtual override returns (uint256) {
        bytes calldata lZMetadata = metadata.getCustomMetadata();
        (
            uint16 dstChainId,
            address userApplication,
            ,
            bytes memory payload,
            ,
            bytes memory adapterParam
        ) = parseLzMetadata(lZMetadata);

        (uint256 nativeFee, ) = lZEndpoint.estimateFees(
            dstChainId,
            userApplication,
            payload,
            false,
            adapterParam
        );
        return nativeFee;
    }

    function formatLzMetadata(
        LayerZeroMetadata calldata layerZeroMetadata
    ) public view returns (bytes memory) {
        return
            abi.encode(
                layerZeroMetadata._dstChainId,
                layerZeroMetadata._userApplication,
                layerZeroMetadata._refundAddress,
                layerZeroMetadata._payload,
                layerZeroMetadata._destination,
                layerZeroMetadata._adapterParam
            );
    }

    function parseLzMetadata(
        bytes calldata lZMetadata
    )
        public
        view
        returns (
            uint16 dstChainId,
            address userApplication,
            address refundAddress,
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
