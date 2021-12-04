// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.6.11;

// ============ Internal Imports ============
import {Router} from "../Router.sol";
import {XAppConnectionClient} from "../XAppConnectionClient.sol";
import {IBridgeRouter} from "../../interfaces/bridge/IBridgeRouter.sol";
import {IERC20Mintable} from "../../interfaces/bridge/IERC20Mintable.sol";
import {FundraiseMessage} from "./FundraiseMessage.sol";
// ============ External Imports ============
import {Home} from "@celo-org/optics-sol/contracts/Home.sol";
import {Version0} from "@celo-org/optics-sol/contracts/Version0.sol";
import {TypeCasts} from "@celo-org/optics-sol/contracts/XAppConnectionManager.sol";
import {TypedMemView} from "@summa-tx/memview-sol/contracts/TypedMemView.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/SafeERC20.sol";

/**
 * @title FundraiseRouter
 */
contract FundraiseRouter is Version0, Router {
    // ============ Libraries ============

    using TypedMemView for bytes;
    using TypedMemView for bytes29;
    using FundraiseMessage for bytes29;
    using SafeERC20 for IERC20;
    using SafeERC20 for IERC20Mintable;

    // ============ Constants ============

    // ============ Public Storage ============
    // the governance token minted for deposits
    address public governanceToken;

    // the local entity empowered to call governance functions, set to 0x0 on non-Governor chains
    address public governor;

    // domain of Governor chain -- for accepting incoming messages from Governor
    uint32 public governorDomain;

    // Address of the local BridgeRouter
    address public bridgeRouter;

    // tokenId => amount
    mapping(bytes29 => address) public balances;

    // ============ Upgrade Gap ============

    // gap for upgrade safety
    uint256[49] private __GAP;

    // ======== Events =========

    /**
     * @notice emitted when tokens are deposited locally
     * @param token the address of the token contract
     * @param from the address sending tokens
     * @param amount the amount of tokens sent
     */
    event DepositLocally(
        address indexed token,
        address indexed from,
        uint256 amount
    );

    /**
     * @notice emitted when tokens are deposited from a remote domain
     * @param token the address of the token contract
     * @param from the address sending tokens
     * @param amount the amount of tokens sent
     * @param fromDomain the domains the tokens were sent from
     */
    event DepositFromRemote(
        address indexed token,
        bytes32 indexed from,
        uint256 amount,
        uint32 indexed fromDomain
    );

    event TransferOnRemote(
        bytes32 indexed tokenId,
        bytes32 indexed to,
        uint256 amount,
        uint32 indexed remoteDomain
    );

    // ======== Initializer ========

    function initialize(address _xAppConnectionManager, address _bridgeRouter, address _governor, uint32 _governorDomain, address _governanceToken) public initializer {
        __XAppConnectionClient_initialize(_xAppConnectionManager);
        bridgeRouter = _bridgeRouter;
        governor = _governor;
        governorDomain = _governorDomain;
        governanceToken = _governanceToken;
    }

    // ============ Modifiers ============

    modifier onlyGovernor() {
        require(msg.sender == governor, "! called by governor");
        _;
    }

    // ======== External: Handle =========

    /**
     * @notice Handle Optics messages
     * For all non-Governor chains to handle transfer messages
     * For the govnernor chain to handle deposit messages
     * @param _origin The domain (of the Governor Router)
     * @param _sender The message sender (must be the Governor Router)
     * @param _message The message
     */
    function handle(
        uint32 _origin,
        bytes32 _sender,
        bytes memory _message
    ) external override onlyReplica onlyRemoteRouter(_origin, _sender) {
        bytes29 _msg = _message.ref(0).mustBeMessage();
        bytes29 _tokenId = _msg.tokenId();
        bytes29 _action = _msg.action();
        if (_msg.isTransfer()) {
            _handleTransfer(_tokenId, _action);
        } else if (_msg.isDeposit()) {
            _handleDeposit(_origin, _tokenId, _action);
        } else {
            require(false, "!valid message type");
        }
    }

    function transfer(
        uint32 _transferDomain,
        bytes32 _tokenId,
        bytes32 _to,
        uint256 _amnt
    ) public onlyGovernor {
        bytes32 _remote = _mustHaveRemote(_transferDomain);
        bytes29 _action = FundraiseMessage.formatTransfer(_to, _amnt);
        Home(xAppConnectionManager.home()).dispatch(
            _transferDomain,
            _remote,
            FundraiseMessage.formatMessage(
                FundraiseMessage.formatTokenId(_transferDomain, _tokenId),
                _action
            )
        );
        emit TransferOnRemote(_tokenId, _to, _amnt, _transferDomain);
    }

    function deposit(address _token, uint256 _amnt) public {
        IERC20(_token).safeTransferFrom(msg.sender, address(this), _amnt);

        if (governorDomain == _localDomain()) {
            // Mint token
            // TODO: Use oracle to mint
            IERC20Mintable(governanceToken).mint(msg.sender, _amnt);
            emit DepositLocally(_token, msg.sender, _amnt);
        } else {
            // tell governance chain to mint and transfer to msg.sender
            bytes32 _remote = _mustHaveRemote(governorDomain);
            bytes29 _action = FundraiseMessage.formatDeposit(
                TypeCasts.addressToBytes32(msg.sender),
                _amnt
            );
            Home(xAppConnectionManager.home()).dispatch(
                governorDomain,
                _remote,
                FundraiseMessage.formatMessage(
                    FundraiseMessage.formatTokenId(
                        _localDomain(),
                        TypeCasts.addressToBytes32(_token)
                    ),
                    _action
                )
            );
        }
    }

    // ============ Internal: Handle ============

    function _handleTransfer(bytes29 _tokenId, bytes29 _action) internal {
        IERC20(_tokenId.evmId()).safeTransfer(
            _action.evmRecipient(),
            _action.amnt()
        );
    }

    function _handleDeposit(
        uint32 _originDomain,
        bytes29 _tokenId,
        bytes29 _action
    ) internal {
        uint256 _amount = _action.amnt();
        IERC20Mintable token = IERC20Mintable(governanceToken);
        token.mint(address(this), _amount);
        token.safeIncreaseAllowance(bridgeRouter, _amount);
        IBridgeRouter(bridgeRouter).send(
            governanceToken,
            _amount,
            _originDomain,
            _action.recipient()
        );
    }

    /**
     * @dev explicit override for compiler inheritance
     * @dev explicit override for compiler inheritance
     * @return domain of chain on which the contract is deployed
     */
    function _localDomain()
        internal
        view
        override(XAppConnectionClient)
        returns (uint32)
    {
        return XAppConnectionClient._localDomain();
    }
}
