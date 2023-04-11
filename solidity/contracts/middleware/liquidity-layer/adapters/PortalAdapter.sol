// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../../../Router.sol";

import {IPortalTokenBridge} from "../interfaces/portal/IPortalTokenBridge.sol";
import {ILiquidityLayerAdapter} from "../interfaces/ILiquidityLayerAdapter.sol";
import {TypeCasts} from "../../../libs/TypeCasts.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract PortalAdapter is ILiquidityLayerAdapter, Router {
    /// @notice The Portal TokenBridge contract.
    IPortalTokenBridge public portalTokenBridge;

    /// @notice The LiquidityLayerRouter contract.
    address public liquidityLayerRouter;

    /// @notice Hyperlane domain => Wormhole domain.
    mapping(uint32 => uint16) public hyperlaneDomainToWormholeDomain;
    /// @notice transferId => token address
    mapping(bytes32 => address) public portalTransfersProcessed;

    uint32 public localDomain;

    // We could technically use Portal's sequence number here but it doesn't
    // get passed through, so we would have to parse the VAA twice
    // 224 bits should be large enough and allows us to pack into a single slot
    // with a Hyperlane domain
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
     * @param wormholeDomain The Wormhole domain.
     */
    event DomainAdded(uint32 indexed hyperlaneDomain, uint32 wormholeDomain);

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

        localDomain = _localDomain;
        portalTokenBridge = IPortalTokenBridge(_portalTokenBridge);
        liquidityLayerRouter = _liquidityLayerRouter;
    }

    /**
     * Sends tokens as requested by the router
     * @param _destinationDomain The hyperlane domain of the destination
     * @param _token The token address
     * @param _amount The amount of tokens to send
     */
    function sendTokens(
        uint32 _destinationDomain,
        bytes32, // _recipientAddress, unused
        address _token,
        uint256 _amount
    ) external onlyLiquidityLayerRouter returns (bytes memory) {
        nonce = nonce + 1;
        uint16 _wormholeDomain = hyperlaneDomainToWormholeDomain[
            _destinationDomain
        ];

        bytes32 _remoteRouter = _mustHaveRemoteRouter(_destinationDomain);

        // Approve the token to Portal. We assume that the LiquidityLayerRouter
        // has already transferred the token to this contract.
        require(
            IERC20(_token).approve(address(portalTokenBridge), _amount),
            "!approval"
        );

        uint64 _portalSequence = portalTokenBridge.transferTokensWithPayload(
            _token,
            _amount,
            _wormholeDomain,
            _remoteRouter,
            // Nonce for grouping Portal messages in the same tx, not relevant for us
            // https://book.wormhole.com/technical/evm/coreLayer.html#emitting-a-vaa
            0,
            // Portal Payload used in completeTransfer
            abi.encode(localDomain, nonce)
        );

        emit BridgedToken(nonce, _portalSequence, _destinationDomain);
        return abi.encode(nonce);
    }

    /**
     * Sends the tokens to the recipient as requested by the router
     * @param _originDomain The hyperlane domain of the origin
     * @param _recipient The address of the recipient
     * @param _amount The amount of tokens to send
     * @param _adapterData The adapter data from the origin chain, containing the nonce
     */
    function receiveTokens(
        uint32 _originDomain, // Hyperlane domain
        address _recipient,
        uint256 _amount,
        bytes calldata _adapterData // The adapter data from the message
    ) external onlyLiquidityLayerRouter returns (address, uint256) {
        // Get the nonce information from the adapterData
        uint224 _nonce = abi.decode(_adapterData, (uint224));

        address _tokenAddress = portalTransfersProcessed[
            transferId(_originDomain, _nonce)
        ];

        require(
            _tokenAddress != address(0x0),
            "Portal Transfer has not yet been completed"
        );

        IERC20 _token = IERC20(_tokenAddress);

        // Transfer the token out to the recipient
        // TODO: use safeTransfer
        // Portal doesn't charge any fee, so we can safely transfer out the
        // exact amount that was bridged over.
        require(_token.transfer(_recipient, _amount), "!transfer out");
        return (_tokenAddress, _amount);
    }

    /**
     * Completes the Portal transfer which sends the funds to this adapter.
     * The router can call receiveTokens to move those funds to the ultimate recipient.
     * @param encodedVm The VAA from the Wormhole Guardians
     */
    function completeTransfer(bytes memory encodedVm) public {
        bytes memory _tokenBridgeTransferWithPayload = portalTokenBridge
            .completeTransferWithPayload(encodedVm);
        IPortalTokenBridge.TransferWithPayload
            memory _transfer = portalTokenBridge.parseTransferWithPayload(
                _tokenBridgeTransferWithPayload
            );

        (uint32 _originDomain, uint224 _nonce) = abi.decode(
            _transfer.payload,
            (uint32, uint224)
        );

        // Logic taken from here https://github.com/wormhole-foundation/wormhole/blob/dev.v2/ethereum/contracts/bridge/Bridge.sol#L503
        address tokenAddress = _transfer.tokenChain ==
            hyperlaneDomainToWormholeDomain[localDomain]
            ? TypeCasts.bytes32ToAddress(_transfer.tokenAddress)
            : portalTokenBridge.wrappedAsset(
                _transfer.tokenChain,
                _transfer.tokenAddress
            );

        portalTransfersProcessed[
            transferId(_originDomain, _nonce)
        ] = tokenAddress;
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

    /**
     * The key that is used to track fulfilled Portal transfers
     * @param _hyperlaneDomain The hyperlane of the origin
     * @param _nonce The nonce of the adapter on the origin
     */
    function transferId(uint32 _hyperlaneDomain, uint224 _nonce)
        public
        pure
        returns (bytes32)
    {
        return bytes32(abi.encodePacked(_hyperlaneDomain, _nonce));
    }
}
