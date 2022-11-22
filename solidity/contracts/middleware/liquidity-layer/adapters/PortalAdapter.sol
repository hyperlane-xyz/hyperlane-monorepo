// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../../../Router.sol";

import {IPortalTokenBridge} from "../interfaces/portal/IPortalTokenBridge.sol";
import {ILiquidityLayerAdapter} from "../interfaces/ILiquidityLayerAdapter.sol";
import {TypeCasts} from "../../../libs/TypeCasts.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PortalAdapter is ILiquidityLayerAdapter, Router {
    struct TransferMetadata {
        uint16 wormholeDomain;
        address tokenAddress;
    }
    /// @notice The Portal TokenBridge contract.
    IPortalTokenBridge public portalTokenBridge;

    /// @notice The LiquidityLayerRouter contract.
    address public liquidityLayerRouter;

    /// @notice Hyperlane domain => Wormhole domain.
    mapping(uint32 => uint16) public hyperlaneDomainToWormholeDomain;
    /// @notice transferId => transferMetadata
    mapping(bytes32 => TransferMetadata) public portalTransfersProcessed;

    uint32 localDomain;
    uint224 public nonce = 0;

    /**
     * @notice Emits the nonce of the Portal message when a token is bridged.
     * @param nonce The nonce of the Portal message.
     * @param portalSequence The sequence of the Portal message.
     * @param destination The hyperlane domain of the destination
     */
    event BridgedToken(
        uint256 nonce,
        uint64 portalSequence,
        uint32 destination
    );

    /**
     * @notice Emitted when the Hyperlane domain to Wormhole domain mapping is updated.
     * @param hyperlaneDomain The Hyperlane domain.
     * @param womrholeDomain The Wormhole domain.
     */
    event DomainAdded(uint32 indexed hyperlaneDomain, uint32 womrholeDomain);

    modifier onlyLiquidityLayerRouter() {
        require(msg.sender == liquidityLayerRouter, "!liquidityLayerRouter");
        _;
    }

    /**
     * @param _localDomain The local hyperlane domain
     * @param _owner The new owner.
     * @param _portalTokenBridge The Portal TokenBridge contract.
     * @param _liquidityLayerRouter The LiquidityLayerRouter contract.
     */
    function initialize(
        uint32 _localDomain,
        address _owner,
        address _portalTokenBridge,
        address _liquidityLayerRouter
    ) public initializer {
        // Transfer ownership of the contract to deployer
        _transferOwnership(_owner);

        // Set the addresses for the ACM and IGP to address(0) - they aren't used.
        _setAbacusConnectionManager(address(0));
        _setInterchainGasPaymaster(address(0));

        localDomain = _localDomain;
        portalTokenBridge = IPortalTokenBridge(_portalTokenBridge);
        liquidityLayerRouter = _liquidityLayerRouter;
    }

    function sendTokens(
        uint32 _destinationDomain,
        bytes32, // _recipientAddress, unused
        address _token,
        uint256 _amount
    ) external onlyLiquidityLayerRouter returns (bytes memory) {
        nonce = nonce + 1;
        uint16 wormholeDomain = hyperlaneDomainToWormholeDomain[
            _destinationDomain
        ];

        bytes32 _remoteRouter = routers[_destinationDomain];
        require(
            _remoteRouter != bytes32(0),
            "Portal TokenBridgeAdapter: No router for domain"
        );

        // Approve the token to Portal. We assume that the LiquidityLayerRouter
        // has already transferred the token to this contract.
        require(
            IERC20(_token).approve(address(portalTokenBridge), _amount),
            "!approval"
        );

        bytes memory payload = adapterData(localDomain, nonce);

        uint64 portalSequence = portalTokenBridge.transferTokensWithPayload(
            _token,
            _amount,
            wormholeDomain,
            _remoteRouter,
            0,
            payload
        );

        emit BridgedToken(nonce, portalSequence, _destinationDomain);
        return payload;
    }

    // Returns the token and amount sent
    function receiveTokens(
        uint32 _originDomain, // Hyperlane domain
        address _recipient,
        uint256 _amount,
        bytes calldata _adapterData // The adapter data from the message
    ) external onlyLiquidityLayerRouter returns (address, uint256) {
        // Get the origin information from the adapterData
        (uint32 _originDomainInPayload, uint224 _nonce) = abi.decode(
            _adapterData,
            (uint32, uint224)
        );

        require(_originDomain == _originDomainInPayload, "!originDomain");

        address tokenAddress = portalTransfersProcessed[
            transferId(_originDomain, _nonce)
        ].tokenAddress;

        require(
            tokenAddress != address(0x0),
            "Portal Transfer has not yet been completed"
        );

        IERC20 token = IERC20(tokenAddress);

        // Transfer the token out to the recipient
        // TODO: use safeTransfer
        // Portal doesn't charge any fee, so we can safely transfer out the
        // exact amount that was bridged over.
        require(token.transfer(_recipient, _amount), "!transfer out");
        return (address(token), _amount);
    }

    function completeTransfer(bytes memory encodedVm) public {
        bytes memory transferTokenBridgePayload = portalTokenBridge
            .completeTransferWithPayload(encodedVm);
        IPortalTokenBridge.TransferWithPayload
            memory transfer = portalTokenBridge.parseTransferWithPayload(
                transferTokenBridgePayload
            );

        (uint32 _originDomain, uint224 _nonce) = abi.decode(
            transfer.payload,
            (uint32, uint224)
        );

        // Logic taken from here https://github.com/wormhole-foundation/wormhole/blob/dev.v2/ethereum/contracts/bridge/Bridge.sol#L503
        address tokenAddress = transfer.tokenChain ==
            hyperlaneDomainToWormholeDomain[localDomain]
            ? TypeCasts.bytes32ToAddress(transfer.tokenAddress)
            : portalTokenBridge.wrappedAsset(
                transfer.tokenChain,
                transfer.tokenAddress
            );

        portalTransfersProcessed[
            transferId(_originDomain, _nonce)
        ] = TransferMetadata({
            wormholeDomain: transfer.tokenChain,
            tokenAddress: tokenAddress
        });
    }

    // This contract is only a Router to be aware of remote router addresses,
    // and doesn't actually send/handle Hyperlane messages directly
    function _handle(
        uint32, // origin
        bytes32, // sender
        bytes calldata // message
    ) internal pure override {
        revert("No messages expected");
    }

    function addDomain(uint32 _hyperlaneDomain, uint16 _wormholeDomain)
        external
        onlyOwner
    {
        hyperlaneDomainToWormholeDomain[_hyperlaneDomain] = _wormholeDomain;

        emit DomainAdded(_hyperlaneDomain, _wormholeDomain);
    }

    function transferId(uint32 _hyperlaneDomain, uint224 _nonce)
        public
        pure
        returns (bytes32)
    {
        return bytes32(abi.encodePacked(_hyperlaneDomain, _nonce));
    }

    function adapterData(uint32 _originDomain, uint224 _nonce)
        public
        pure
        returns (bytes memory)
    {
        return abi.encode(_originDomain, _nonce);
    }
}
