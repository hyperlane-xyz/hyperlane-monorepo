// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../../../Router.sol";

import {ITokenMessenger} from "../interfaces/circle/ITokenMessenger.sol";
import {ICircleMessageTransmitter} from "../interfaces/circle/ICircleMessageTransmitter.sol";
import {ILiquidityLayerAdapter} from "../interfaces/ILiquidityLayerAdapter.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CircleBridgeAdapter is ILiquidityLayerAdapter, Router {
    using SafeERC20 for IERC20;

    /// @notice The TokenMessenger contract.
    ITokenMessenger public tokenMessenger;

    /// @notice The Circle MessageTransmitter contract.
    ICircleMessageTransmitter public circleMessageTransmitter;

    /// @notice The LiquidityLayerRouter contract.
    address public liquidityLayerRouter;

    /// @notice Hyperlane domain => Circle domain.
    /// ATM, known Circle domains are Ethereum = 0 and Avalanche = 1.
    /// Note this could result in ambiguity between the Circle domain being
    /// Ethereum or unknown.
    mapping(uint32 => uint32) public hyperlaneDomainToCircleDomain;

    /// @notice Token symbol => address of token on local chain.
    mapping(string => IERC20) public tokenSymbolToAddress;

    /// @notice Local chain token address => token symbol.
    mapping(address => string) public tokenAddressToSymbol;

    /**
     * @notice Emits the nonce of the Circle message when a token is bridged.
     * @param nonce The nonce of the Circle message.
     */
    event BridgedToken(uint64 nonce);

    /**
     * @notice Emitted when the Hyperlane domain to Circle domain mapping is updated.
     * @param hyperlaneDomain The Hyperlane domain.
     * @param circleDomain The Circle domain.
     */
    event DomainAdded(uint32 indexed hyperlaneDomain, uint32 circleDomain);

    /**
     * @notice Emitted when a local token and its token symbol have been added.
     */
    event TokenAdded(address indexed token, string indexed symbol);

    /**
     * @notice Emitted when a local token and its token symbol have been removed.
     */
    event TokenRemoved(address indexed token, string indexed symbol);

    modifier onlyLiquidityLayerRouter() {
        require(msg.sender == liquidityLayerRouter, "!liquidityLayerRouter");
        _;
    }

    /**
     * @param _owner The new owner.
     * @param _tokenMessenger The TokenMessenger contract.
     * @param _circleMessageTransmitter The Circle MessageTransmitter contract.
     * @param _liquidityLayerRouter The LiquidityLayerRouter contract.
     */
    function initialize(
        address _owner,
        address _tokenMessenger,
        address _circleMessageTransmitter,
        address _liquidityLayerRouter
    ) external initializer {
        __Ownable_init();
        _transferOwnership(_owner);

        tokenMessenger = ITokenMessenger(_tokenMessenger);
        circleMessageTransmitter = ICircleMessageTransmitter(
            _circleMessageTransmitter
        );
        liquidityLayerRouter = _liquidityLayerRouter;
    }

    function sendTokens(
        uint32 _destinationDomain,
        bytes32, // _recipientAddress, unused
        address _token,
        uint256 _amount
    ) external onlyLiquidityLayerRouter returns (bytes memory) {
        string memory _tokenSymbol = tokenAddressToSymbol[_token];
        require(
            bytes(_tokenSymbol).length > 0,
            "CircleBridgeAdapter: Unknown token"
        );

        uint32 _circleDomain = hyperlaneDomainToCircleDomain[
            _destinationDomain
        ];
        bytes32 _remoteRouter = _mustHaveRemoteRouter(_destinationDomain);

        // Approve the token to Circle. We assume that the LiquidityLayerRouter
        // has already transferred the token to this contract.
        require(
            IERC20(_token).approve(address(tokenMessenger), _amount),
            "!approval"
        );

        uint64 _nonce = tokenMessenger.depositForBurn(
            _amount,
            _circleDomain,
            _remoteRouter, // Mint to the remote router
            _token
        );

        emit BridgedToken(_nonce);
        return abi.encode(_nonce, _tokenSymbol);
    }

    // Returns the token and amount sent
    function receiveTokens(
        uint32 _originDomain, // Hyperlane domain
        address _recipient,
        uint256 _amount,
        bytes calldata _adapterData // The adapter data from the message
    ) external onlyLiquidityLayerRouter returns (address, uint256) {
        _mustHaveRemoteRouter(_originDomain);
        // The origin Circle domain
        uint32 _originCircleDomain = hyperlaneDomainToCircleDomain[
            _originDomain
        ];
        // Get the token symbol and nonce of the transfer from the _adapterData
        (uint64 _nonce, string memory _tokenSymbol) = abi.decode(
            _adapterData,
            (uint64, string)
        );

        // Require the circle message to have been processed
        bytes32 _nonceId = _circleNonceId(_originCircleDomain, _nonce);
        require(
            circleMessageTransmitter.usedNonces(_nonceId),
            "Circle message not processed yet"
        );

        IERC20 _token = tokenSymbolToAddress[_tokenSymbol];
        require(
            address(_token) != address(0),
            "CircleBridgeAdapter: Unknown token"
        );

        // Transfer the token out to the recipient
        // Circle doesn't charge any fee, so we can safely transfer out the
        // exact amount that was bridged over.
        _token.safeTransfer(_recipient, _amount);

        return (address(_token), _amount);
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

    function addDomain(uint32 _hyperlaneDomain, uint32 _circleDomain)
        external
        onlyOwner
    {
        hyperlaneDomainToCircleDomain[_hyperlaneDomain] = _circleDomain;

        emit DomainAdded(_hyperlaneDomain, _circleDomain);
    }

    function addToken(address _token, string calldata _tokenSymbol)
        external
        onlyOwner
    {
        require(
            _token != address(0) && bytes(_tokenSymbol).length > 0,
            "Cannot add default values"
        );

        // Require the token and token symbol to be unset.
        address _existingToken = address(tokenSymbolToAddress[_tokenSymbol]);
        require(_existingToken == address(0), "token symbol already has token");

        string memory _existingSymbol = tokenAddressToSymbol[_token];
        require(
            bytes(_existingSymbol).length == 0,
            "token already has token symbol"
        );

        tokenAddressToSymbol[_token] = _tokenSymbol;
        tokenSymbolToAddress[_tokenSymbol] = IERC20(_token);

        emit TokenAdded(_token, _tokenSymbol);
    }

    function removeToken(address _token, string calldata _tokenSymbol)
        external
        onlyOwner
    {
        // Require the provided token and token symbols match what's in storage.
        address _existingToken = address(tokenSymbolToAddress[_tokenSymbol]);
        require(_existingToken == _token, "Token mismatch");

        string memory _existingSymbol = tokenAddressToSymbol[_token];
        require(
            keccak256(bytes(_existingSymbol)) == keccak256(bytes(_tokenSymbol)),
            "Token symbol mismatch"
        );

        // Delete them from storage.
        delete tokenSymbolToAddress[_tokenSymbol];
        delete tokenAddressToSymbol[_token];

        emit TokenRemoved(_token, _tokenSymbol);
    }

    /**
     * @notice Gets the Circle nonce ID by hashing _originCircleDomain and _nonce.
     * @param _originCircleDomain Domain of chain where the transfer originated
     * @param _nonce The unique identifier for the message from source to
              destination
     * @return hash of source and nonce
     */
    function _circleNonceId(uint32 _originCircleDomain, uint64 _nonce)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(abi.encodePacked(_originCircleDomain, _nonce));
    }
}
