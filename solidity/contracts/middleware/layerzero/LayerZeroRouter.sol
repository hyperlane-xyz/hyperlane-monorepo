// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../../Router.sol";
import {TypeCasts} from "../../libs/TypeCasts.sol";
import {IMessageRecipient} from "../../interfaces/IMessageRecipient.sol";
import {ILayerZeroEndpoint} from "../../interfaces/middleware/layerzero/ILayerZeroEndpoint.sol";
import {ILayerZeroReceiver} from "../../interfaces/middleware/layerzero/ILayerZeroReceiver.sol";

/**
 * @title LayerZeroRouter
 * @notice Example of middleware to use hyperlane in a layerzero app on layerZero
 * @dev Implemented send() and a virtual lzReceive().
 * @dev Please make sure to edit lzReceive() and setEstGasAmount() to match gas usage of lzReceive() in your app
 * @dev Run `forge test --match-contract LayerZeroRouterTest` to see tests
 */

abstract contract LayerZeroRouter is Router, ILayerZeroEndpoint {
    mapping(uint16 => uint32) layerZeroToHyperlaneDomain;
    mapping(uint32 => uint16) hyperlaneToLayerZeroDomain;

    ILayerZeroReceiver public layerZeroReceiver;

    error LayerZeroDomainNotMapped(uint16);
    error HyperlaneDomainNotMapped(uint32);

    uint256 estGasAmount;

    function initialize(address _owner, address _mailbox) public initializer {
        _transferOwnership(_owner);
        __Router_initialize(_mailbox);
    }

    function initialize(
        address _owner,
        address _mailbox,
        address _interchainGasPaymaster
    ) public initializer {
        _transferOwnership(_owner);
        __Router_initialize(_mailbox, _interchainGasPaymaster);
    }

    function initialize(
        address _owner,
        address _mailbox,
        address _interchainGasPaymaster,
        address _interchainSecurityModule
    ) public initializer {
        _transferOwnership(_owner);
        __Router_initialize(
            _mailbox,
            _interchainGasPaymaster,
            _interchainSecurityModule
        );
    }

    /**
     * @notice Adds a domain ID mapping from layerZeroDomain/hyperlaneDomain domain IDs and vice versa
     * @param _layerZeroDomains An array of layerZeroDomain domain IDs
     * @param _hyperlaneDomains An array of hyperlaneDomain domain IDs
     */
    function mapDomains(
        uint16[] calldata _layerZeroDomains,
        uint32[] calldata _hyperlaneDomains
    ) external onlyOwner {
        for (uint256 i = 0; i < _layerZeroDomains.length; i += 1) {
            layerZeroToHyperlaneDomain[
                _layerZeroDomains[i]
            ] = _hyperlaneDomains[i];
            hyperlaneToLayerZeroDomain[
                _hyperlaneDomains[i]
            ] = _layerZeroDomains[i];
        }
    }

    /**
     * @notice Gets layerZero domain ID from hyperlane domain ID
     * @param _hyperlaneDomain The hyperlane domain ID
     */
    function getLayerZeroDomain(uint32 _hyperlaneDomain)
        public
        view
        returns (uint16 layerZeroDomain)
    {
        layerZeroDomain = hyperlaneToLayerZeroDomain[_hyperlaneDomain];
        if (layerZeroDomain == 0) {
            revert HyperlaneDomainNotMapped(_hyperlaneDomain);
        }
    }

    /**
     * @notice Gets hyperlane domain ID from layerZero domain ID
     * @param _layerZeroDomain The layerZero domain ID
     */
    function getHyperlaneDomain(uint16 _layerZeroDomain)
        public
        view
        returns (uint32 hyperlaneDomain)
    {
        hyperlaneDomain = layerZeroToHyperlaneDomain[_layerZeroDomain];
        if (hyperlaneDomain == 0) {
            revert LayerZeroDomainNotMapped(_layerZeroDomain);
        }
    }

    /**
     * @notice handles the version Adapter Parameters for LayerZero
     * @param _adapterParams The adapter params used in LayerZero sends
     */
    function _interpretAdapterParamsV1(bytes memory _adapterParams)
        internal
        pure
        returns (uint256 gasAmount)
    {
        uint16 version;
        require(_adapterParams.length == 34, "Please check your adapterparams");
        (version, gasAmount) = abi.decode(_adapterParams, (uint16, uint256));
    }

    /**
     * @notice handles the version Adapter Parameters for LayerZero
     * @param _adapterParams The adapter params used in LayerZero sends
     */
    function _interpretAdapterParamsV2(bytes memory _adapterParams)
        internal
        pure
        returns (
            uint256 gasAmount,
            uint256 nativeForDst,
            address addressOnDst
        )
    {
        require(_adapterParams.length == 86, "Please check your adapterparams");
        uint16 version;
        (version, gasAmount, nativeForDst, addressOnDst) = abi.decode(
            _adapterParams,
            (uint16, uint256, uint256, address)
        );
    }

    function splitAddress(bytes memory hexString)
        public
        pure
        returns (address, address)
    {
        // bytes memory byteArray = bytes(hexString);
        require(
            hexString.length == 40,
            "Input string must be 40 characters long"
        );

        bytes20 firstAddress;
        bytes20 secondAddress;

        assembly {
            firstAddress := mload(add(hexString, 0x20))
            secondAddress := mload(add(hexString, 0x30))
        }

        return (address(firstAddress), address(secondAddress));
    }

    /**
     * @notice Sends a hyperlane message using LayerZero endpoint interface
     * @dev NOTE: Layerzero's documentation is inconsistent in github vs docs. Following: https://layerzero.gitbook.io/docs/evm-guides/master/how-to-send-a-message
     * @param _dstChainId - the destination chain identifier
     * @param _remoteAndLocalAddresses - remote address concated with local address packed into 40 bytes
     * @param _payload - the payload to be sent to the destination chain
     * @param _refundAddress - the address to refund the gas fees to
     * @param _zroPaymentAddress - not used (only for LayerZero)
     * @param _adapterParams - the adapter params used in LayerZero sends
     */
    function send(
        uint16 _dstChainId,
        bytes memory _remoteAndLocalAddresses,
        bytes calldata _payload,
        address payable _refundAddress,
        address _zroPaymentAddress,
        bytes memory _adapterParams
    ) external payable override {
        uint32 dstChainId32 = layerZeroToHyperlaneDomain[_dstChainId];
        _mustHaveRemoteRouter(dstChainId32);
        address remoteAddr;
        address localAddr;
        if (_remoteAndLocalAddresses.length == 40) {
            (remoteAddr, localAddr) = splitAddress(_remoteAndLocalAddresses);
        } else if (_remoteAndLocalAddresses.length == 32) {
            remoteAddr = abi.decode(_remoteAndLocalAddresses, (address));
        } else {
            revert("Invalid remote and local addresses");
        }

        bytes memory adapterParams;
        uint256 gasFees;
        if (_adapterParams.length > 0) {
            if (_adapterParams.length == 33) {
                gasFees = _interpretAdapterParamsV1(_adapterParams);
            } else if (_adapterParams.length == 86) {
                uint256 nativeForDst;
                address addressOnDst;
                (
                    gasFees,
                    nativeForDst,
                    addressOnDst
                ) = _interpretAdapterParamsV2(_adapterParams);
            } else {
                revert("Invalid adapter params");
            }
        } else {
            (gasFees, ) = estimateFees(
                _dstChainId,
                msg.sender,
                _payload,
                _zroPaymentAddress != address(0x0),
                adapterParams
            );
        }

        require(msg.value >= gasFees, "Not enough fee for gas");

        bytes32 _messageId = mailbox.dispatch(
            dstChainId32,
            TypeCasts.addressToBytes32(remoteAddr),
            _payload
        );

        interchainGasPaymaster.payForGas{value: msg.value}(
            _messageId,
            dstChainId32,
            gasFees,
            _refundAddress
        );
    }

    /**
     * @notice The internal Router `handle` function which extracts the true recipient of the message and passes the translated hyperlane domain ID to lzReceive
     * @param _originHyperlaneDomain the origin domain as specified by Hyperlane
     * @param _sender The sender address
     * @param _message The wrapped message to include sender and recipient
     */
    function handle(
        uint32 _originHyperlaneDomain,
        bytes32 _sender,
        bytes calldata _message
    )
        public
        override
        onlyMailbox
        onlyRemoteRouter(_originHyperlaneDomain, _sender)
    {
        _handle(_originHyperlaneDomain, _sender, _message);
    }

    function _handle(
        uint32 _originHyperlaneDomain,
        bytes32 _sender,
        bytes calldata _message
    ) internal override {
        uint16 srcChainId = getLayerZeroDomain(_originHyperlaneDomain);
        lzReceive(srcChainId, _sender, 0, _message); //Note nonce does not exist in hyperlane on the destination chain
    }

    /**
     * @notice Originally LayerZero endpoint which will be evoked by this contract's handle function
     * @dev override from ILayerZeroEndpoint.sol
     * @param _srcChainId - the source endpoint identifier
     * @param _srcAddress - the source sending contract address from the source chain
     * @param _nonce - the ordered message nonce (not used in Hyperlane)
     * @param _payload - the signed payload is the UA bytes has encoded to be sent
     */
    function lzReceive(
        uint16 _srcChainId,
        bytes32 _srcAddress,
        uint64 _nonce,
        bytes memory _payload
    ) public virtual {}

    /**
     * @notice Gets a quote in source native gas, for the amount that send() requires to pay for message delivery
     * @dev override from ILayerZeroEndpoint.sol
     * @param _dstChainId - the destination chain identifier
     * @param _userApplication - the user app address on this EVM chain
     * @param _payload - the custom message to send over LayerZero
     * @param _payInZRO - if false, user app pays the protocol fee in native token
     * @param _adapterParams - parameters for the adapter service, e.g. send some dust native token to dstChain
     */
    function estimateFees(
        uint16 _dstChainId,
        address _userApplication,
        bytes memory _payload,
        bool _payInZRO,
        bytes memory _adapterParams
    ) public view override returns (uint256 nativeFee, uint256 zroFee) {
        require(estGasAmount > 0, "Please set gas amount");
        return (
            interchainGasPaymaster.quoteGasPayment(
                layerZeroToHyperlaneDomain[_dstChainId],
                estGasAmount
            ),
            0
        );
    }

    /**
     * @notice Sets the gas amount for the estimateFees function since this will depend upon gas your lzreceive() uses
     * @dev Used for showcase and testing suggest editing getGasAmount
     * @param _gas The amount of gas to set
     */

    function setEstGasAmount(uint256 _gas) external onlyOwner {
        estGasAmount = _gas;
    }

    /**
     * @notice Gets the gas amount for the estimateFees function
     * @dev Please override this to however you wish to calculate your gas usage on destiniation chain
     * @param _payload The payload to be sent to the destination chain
     */

    function getEstGasAmount(bytes memory _payload)
        public
        view
        returns (uint256)
    {
        return estGasAmount;
    }

    /**
     * @notice Gets the chain ID of the current chain
     * @dev override from ILayerZeroEndpoint.sol -- NOTE OVERFLOW RISK
     */
    function getChainId() external view override returns (uint16) {
        return hyperlaneToLayerZeroDomain[mailbox.localDomain()];
    }

    /**
     * @notice Gets the mailbox count this source chain since hyperlane does not have nonce
     * @dev override from ILayerZeroEndpoint.sol
     * @param _dstChainId - the destination chain identifier
     * @param _srcAddress - the source chain contract address
     *
     */
    function getOutboundNonce(uint16 _dstChainId, address _srcAddress)
        external
        view
        returns (uint64)
    {
        return uint64(mailbox.count());
    }
}
