// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {Quote, ITokenBridge, ITokenFee} from "../interfaces/ITokenBridge.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IVaultBridgeToken} from "./interfaces/IVaultBridgeToken.sol";

/// @notice Thin ITokenBridge wrapper for Vault Bridge deposits.
/// @dev This is intentionally origin-only. It does not dispatch Hyperlane
/// messages or participate in destination handling.
contract TokenBridgeVaultBridge is
    Initializable,
    OwnableUpgradeable,
    ITokenBridge
{
    using Address for address payable;
    using SafeERC20 for IERC20;
    using TypeCasts for bytes32;

    struct RemoteBridgeConfig {
        uint32 agglayerNetworkId;
        bool forceUpdateGlobalExitRoot;
    }

    error InvalidLocalToken(address token);
    error InvalidVaultBridgeToken(address vaultBridgeToken);
    error RemoteConfigNotFound(uint32 domain);
    error InvalidFeeRecipient(address recipient);
    error UnsupportedHandle();

    event RemoteBridgeConfigSet(
        uint32 indexed domain,
        uint32 indexed agglayerNetworkId,
        bool forceUpdateGlobalExitRoot
    );
    event RemoteBridgeConfigRemoved(uint32 indexed domain);
    event FeeRecipientSet(address feeRecipient);

    IERC20 public immutable localToken;
    IVaultBridgeToken public immutable vaultBridgeToken;

    mapping(uint32 => RemoteBridgeConfig) public remoteBridgeConfigs;
    mapping(uint32 => bool) internal _hasRemoteBridgeConfigDomain;
    uint32[] internal _remoteBridgeConfigDomains;

    address internal _feeRecipient;

    constructor(
        address _localToken,
        address, // _mailbox, unused but kept for deploy compatibility
        address _vaultBridgeToken
    ) {
        if (_localToken == address(0) || _localToken.code.length == 0) {
            revert InvalidLocalToken(_localToken);
        }
        if (
            _vaultBridgeToken == address(0) ||
            _vaultBridgeToken.code.length == 0
        ) {
            revert InvalidVaultBridgeToken(_vaultBridgeToken);
        }
        localToken = IERC20(_localToken);
        vaultBridgeToken = IVaultBridgeToken(_vaultBridgeToken);
        _disableInitializers();
    }

    function initialize(address, address _owner) external initializer {
        __Ownable_init(_owner);
        localToken.forceApprove(address(vaultBridgeToken), type(uint256).max);
    }

    function token() public view returns (address) {
        return address(localToken);
    }

    function setFeeRecipient(address recipient) external onlyOwner {
        if (recipient == address(this)) revert InvalidFeeRecipient(recipient);
        _feeRecipient = recipient;
        emit FeeRecipientSet(recipient);
    }

    function feeRecipient() public view returns (address) {
        return _feeRecipient;
    }

    function setRemoteBridgeConfig(
        uint32 _domain,
        uint32 _agglayerNetworkId,
        bool _forceUpdateGlobalExitRoot
    ) external onlyOwner {
        remoteBridgeConfigs[_domain] = RemoteBridgeConfig({
            agglayerNetworkId: _agglayerNetworkId,
            forceUpdateGlobalExitRoot: _forceUpdateGlobalExitRoot
        });
        if (!_hasRemoteBridgeConfigDomain[_domain]) {
            _hasRemoteBridgeConfigDomain[_domain] = true;
            _remoteBridgeConfigDomains.push(_domain);
        }
        emit RemoteBridgeConfigSet(
            _domain,
            _agglayerNetworkId,
            _forceUpdateGlobalExitRoot
        );
    }

    function removeRemoteBridgeConfig(uint32 _domain) external onlyOwner {
        delete remoteBridgeConfigs[_domain];
        if (_hasRemoteBridgeConfigDomain[_domain]) {
            _hasRemoteBridgeConfigDomain[_domain] = false;
            uint256 len = _remoteBridgeConfigDomains.length;
            for (uint256 i = 0; i < len; i += 1) {
                if (_remoteBridgeConfigDomains[i] != _domain) continue;
                uint256 lastIndex = len - 1;
                if (i != lastIndex) {
                    _remoteBridgeConfigDomains[i] = _remoteBridgeConfigDomains[
                        lastIndex
                    ];
                }
                _remoteBridgeConfigDomains.pop();
                break;
            }
        }
        emit RemoteBridgeConfigRemoved(_domain);
    }

    function remoteBridgeConfigDomains()
        external
        view
        returns (uint32[] memory)
    {
        return _remoteBridgeConfigDomains;
    }

    function quoteTransferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external view returns (Quote[] memory quotes) {
        _mustHaveRemoteConfig(_destination);
        uint256 feeAmount = _feeAmount(_destination, _recipient, _amount);
        quotes = new Quote[](3);
        quotes[0] = Quote({token: address(0), amount: 0});
        quotes[1] = Quote({
            token: address(localToken),
            amount: _amount + feeAmount
        });
        quotes[2] = Quote({token: address(localToken), amount: 0});
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) external payable returns (bytes32) {
        RemoteBridgeConfig memory cfg = _mustHaveRemoteConfig(_destination);
        uint256 feeAmount = _feeAmount(_destination, _recipient, _amount);

        localToken.safeTransferFrom(
            msg.sender,
            address(this),
            _amount + feeAmount
        );

        if (feeAmount > 0) {
            localToken.safeTransfer(_feeRecipient, feeAmount);
        }

        vaultBridgeToken.depositAndBridge(
            _amount,
            _recipient.bytes32ToAddress(),
            cfg.agglayerNetworkId,
            cfg.forceUpdateGlobalExitRoot
        );

        if (msg.value > 0) {
            payable(msg.sender).sendValue(msg.value);
        }

        return bytes32(0);
    }

    /// @notice Explicitly unsupported. This adapter is origin-only.
    function handle(uint32, bytes32, bytes calldata) external pure {
        revert UnsupportedHandle();
    }

    function _feeAmount(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) internal view returns (uint256 feeAmount) {
        address recipient = _feeRecipient;
        if (recipient == address(0)) return 0;

        Quote[] memory quotes = ITokenFee(recipient).quoteTransferRemote(
            _destination,
            _recipient,
            _amount
        );
        if (quotes.length == 0) return 0;

        require(
            quotes.length == 1 && quotes[0].token == address(localToken),
            "VaultBridge: fee must match token"
        );
        feeAmount = quotes[0].amount;
    }

    function _mustHaveRemoteConfig(
        uint32 _domain
    ) internal view returns (RemoteBridgeConfig memory cfg) {
        if (!_hasRemoteBridgeConfigDomain[_domain]) {
            revert RemoteConfigNotFound(_domain);
        }
        cfg = remoteBridgeConfigs[_domain];
    }
}
