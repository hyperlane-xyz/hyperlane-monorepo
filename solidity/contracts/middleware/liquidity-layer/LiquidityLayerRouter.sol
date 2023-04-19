// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

// ============ Internal Imports ============
import {Router} from "../../Router.sol";
import {ILiquidityLayerRouter} from "../../interfaces/middleware/liquidity-layer/ILiquidityLayerRouter.sol";
import {ICircleMessageTransmitter} from "../../interfaces/middleware/liquidity-layer/circle/ICircleMessageTransmitter.sol";
import {ILiquidityLayerAdapter} from "../../interfaces/middleware/liquidity-layer/ILiquidityLayerAdapter.sol";
import {ILiquidityLayerMessageRecipient} from "../../interfaces/middleware/liquidity-layer/ILiquidityLayerMessageRecipient.sol";
import {LiquidityLayerMessage} from "../../libs/middleware/LiquidityLayerMessage.sol";

// ============ External Imports ============
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract LiquidityLayerRouter is Router, ILiquidityLayerRouter {
    // ============ Libraries ============
    using SafeERC20 for IERC20;

    // ============ Public Storage ============
    // Token bridge => adapter address
    mapping(string => ILiquidityLayerAdapter) public adapters;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[47] private __GAP;

    // ============ Events ============

    event AdapterSet(string indexed name, ILiquidityLayerAdapter adapter);

    // ============ Initializers ============
    /**
     * @notice Initializes the Router contract with Hyperlane core contracts
     * and the address of the interchain security module.
     * @param _mailbox The address of the mailbox contract.
     * @param _interchainGasPaymaster The address of the interchain gas
     * paymaster contract.
     * @param _interchainSecurityModule The address of the interchain security
     * module contract.
     * @param _owner The address with owner privileges.
     */
    function initialize(
        address _mailbox,
        address _interchainGasPaymaster,
        address _interchainSecurityModule,
        address _owner
    ) external initializer {
        __HyperlaneConnectionClient_initialize(
            _mailbox,
            _interchainGasPaymaster,
            _interchainSecurityModule,
            _owner
        );
    }

    // ============ External functions ============
    /**
     * @notice Dispatches a message and transfers tokens to the destination
     * domain & recipient.
     * @dev Tokens must have first been approved to the LiquidityLayerRouter by
     * msg.sender
     * @param _destinationDomain Domain of destination chain
     * @param _recipientAddress Address of recipient on destination chain as bytes32
     * @param _token Address of the token to transfer on the origin chain
     * @param _amount The number of tokens to transfer
     * @param _name The name of the bridge to use for transferring tokens
     * @param _messageBody Raw bytes content of message body
     * @return The Hyperlane message ID
     */
    function dispatchWithTransfer(
        uint32 _destinationDomain,
        bytes32 _recipientAddress,
        address _token,
        uint256 _amount,
        string calldata _name,
        bytes calldata _messageBody
    ) external returns (bytes32) {
        ILiquidityLayerAdapter _adapter = _getAdapter(_name);
        IERC20(_token).safeTransferFrom(msg.sender, address(_adapter), _amount);

        // Reverts if bridging was unsuccessful.
        // Gets adapter-specific data that should later be encoded into the
        // Hyperlane message body.
        bytes memory _adapterData = _adapter.sendTokens(
            _destinationDomain,
            _recipientAddress,
            _token,
            _amount
        );

        bytes memory _body = LiquidityLayerMessage.encode(
            msg.sender,
            _recipientAddress,
            _amount,
            _name,
            _adapterData,
            _messageBody
        );

        // Dispatch to the destination's LiquidityLayerRouter.
        return _dispatch(_destinationDomain, _body);
    }

    // Handles a message from an enrolled remote LiquidityLayerRouter
    function _handle(
        uint32 _origin,
        bytes32, // _sender, unused
        bytes calldata _message
    ) internal override {
        (
            string memory _name,
            bytes memory _adapterData,
            bytes memory _body
        ) = LiquidityLayerMessage.decode(_message);
        ILiquidityLayerAdapter _adapter = _getAdapter(_name);

        address _recipient = LiquidityLayerMessage.recipientAddress(_message);
        // Reverts if the adapter hasn't received the bridged tokens yet
        (address _token, uint256 _receivedAmount) = _adapter.receiveTokens(
            _origin,
            _recipient,
            LiquidityLayerMessage.amount(_message),
            _adapterData
        );

        if (_body.length > 0) {
            ILiquidityLayerMessageRecipient(_recipient).handleWithTokens(
                _origin,
                LiquidityLayerMessage.sender(_message),
                _body,
                _token,
                _receivedAmount
            );
        }
    }

    function setAdapter(string calldata _name, ILiquidityLayerAdapter _adapter)
        external
        onlyOwner
    {
        adapters[_name] = _adapter;
        emit AdapterSet(_name, _adapter);
    }

    function _getAdapter(string memory _name)
        internal
        view
        returns (ILiquidityLayerAdapter _adapter)
    {
        _adapter = ILiquidityLayerAdapter(adapters[_name]);
        // Require the adapter to have been set
        require(address(_adapter) != address(0), "No adapter found for bridge");
    }
}
