// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Router} from "../../../Router.sol";

import {ITokenMessenger} from "../interfaces/circle/ITokenMessenger.sol";
import {ILiquidityLayerAdapterV2} from "../interfaces/ILiquidityLayerAdapterV2.sol";

import {TypeCasts} from "../../../libs/TypeCasts.sol";

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract CctpAdapter is ILiquidityLayerAdapterV2, Router {
    using SafeERC20 for IERC20;

    /**
     * @dev Emitted on `transferRemote` when a transfer message is dispatched.
     * @param destination The identifier of the destination chain.
     * @param recipient The address of the recipient on the destination chain.
     * @param amount The amount of tokens burnt on the origin chain.
     */

    event SentTransferRemote(
        uint32 indexed destination,
        bytes32 indexed recipient,
        uint256 amount
    );

    /**
     * @dev Emitted when the amount of gas required to process a CCTP transfer is updated.
     * @param oldGasAmount The old gas amount.
     * @param newGasAmount The new gas amount.
     */
    event GasAmountSet(
        uint256 indexed oldGasAmount,
        uint256 indexed newGasAmount
    );

    /// @notice The TokenMessenger contract.
    ITokenMessenger public tokenMessenger;

    /// @notice The token address.
    address public token;

    /// @notice The token symbol of the token.
    string public tokenSymbol;

    /// @notice The amount of gas required to process a CCTP transfer.
    uint256 public gasAmount;

    /// @notice Hyperlane domain => Circle domain.
    /// ATM, known Circle domains are Ethereum = 0 and Avalanche = 1.
    /// Note this could result in ambiguity between the Circle domain being
    /// Ethereum or unknown.
    mapping(uint32 => uint32) public hyperlaneDomainToCircleDomain;

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
     * @param _owner The new owner.
     * @param _tokenMessenger The TokenMessenger contract.
     * @param _token The token address.
     * @param _tokenSymbol The token symbol.
     * @param _gasAmount The amount of gas required to process a CCTP transfer.
     * @param _mailbox The address of the mailbox contract.
     * @param _interchainGasPaymaster The address of the interchain gas paymaster contract.
     * @param _interchainSecurityModule The address of the interchain security module contract.
     */
    function initialize(
        address _owner,
        address _tokenMessenger,
        address _token,
        string calldata _tokenSymbol,
        uint256 _gasAmount,
        address _mailbox,
        address _interchainGasPaymaster,
        address _interchainSecurityModule
    ) external initializer {
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster,
            _interchainSecurityModule,
            _owner
        );

        tokenMessenger = ITokenMessenger(_tokenMessenger);
        token = _token;
        tokenSymbol = _tokenSymbol;
        gasAmount = _gasAmount;
    }

    /**
     * @notice Transfers `_amount` token to `_recipientAddress` on `_destinationDomain` chain.
     * @param _destinationDomain The identifier of the destination chain.
     * @param _recipientAddress The address of the recipient on the destination chain.
     * @param _amount The amount of tokens to transfer.
     * @return messageId The identifier of the dispatched message.
     */
    function transferRemote(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        uint256 _amount
    ) external payable override returns (bytes32 messageId) {
        _mustHaveRemoteRouter(_destinationDomain);
        uint32 _circleDomain = hyperlaneDomainToCircleDomain[
            _destinationDomain
        ];

        IERC20(token).transferFrom(msg.sender, address(this), _amount);
        IERC20(token).approve(address(tokenMessenger), _amount);

        uint64 _nonce = tokenMessenger.depositForBurn(
            _amount,
            _circleDomain,
            _recipientAddress,
            token
        );

        emit BridgedToken(_nonce);

        bytes memory _message = abi.encode(
            _recipientAddress, // The "user" recipient
            _amount, // The amount of the tokens sent over the bridge
            TypeCasts.addressToBytes32(msg.sender),
            _nonce,
            tokenSymbol
        );

        messageId = _dispatchWithGas(
            _destinationDomain,
            _message,
            gasAmount,
            msg.value,
            msg.sender
        );

        emit SentTransferRemote(_destinationDomain, _recipientAddress, _amount);
    }

    // token transfer is already handled by the CctpIsm
    function _handle(
        uint32, // origin
        bytes32, // sender
        bytes calldata // message
    ) internal pure override {
        // do nothing
    }

    /**
     * @notice Adds a new mapping between a Hyperlane domain and a Circle domain.
     * @param _hyperlaneDomain The Hyperlane domain.
     * @param _circleDomain The Circle domain.
     */
    function addDomain(uint32 _hyperlaneDomain, uint32 _circleDomain)
        external
        onlyOwner
    {
        hyperlaneDomainToCircleDomain[_hyperlaneDomain] = _circleDomain;

        emit DomainAdded(_hyperlaneDomain, _circleDomain);
    }

    /**
     * @notice Sets the gas amount required to process a CCTP transfer.
     * @param _gasAmount The new gas amount.
     */
    function setGasAmount(uint256 _gasAmount) external onlyOwner {
        uint256 oldGasAmount = gasAmount;
        gasAmount = _gasAmount;

        emit GasAmountSet(oldGasAmount, _gasAmount);
    }
}
