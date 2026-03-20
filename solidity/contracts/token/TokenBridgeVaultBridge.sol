// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {Quote, ITokenBridge} from "../interfaces/ITokenBridge.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {IVaultBridgeToken} from "./interfaces/IVaultBridgeToken.sol";

/// @notice Thin ITokenBridge wrapper for Vault Bridge deposits.
/// @dev This contract only handles the origin-side deposit into Vault Bridge.
/// It does not participate in the reverse-side redeem flow.
contract TokenBridgeVaultBridge is TokenRouter {
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
    error UnsupportedHandle();

    event RemoteBridgeConfigSet(
        uint32 indexed domain,
        uint32 indexed agglayerNetworkId,
        bool forceUpdateGlobalExitRoot
    );
    event RemoteBridgeConfigRemoved(uint32 indexed domain);

    IERC20 public immutable localToken;
    IVaultBridgeToken public immutable vaultBridgeToken;

    mapping(uint32 => RemoteBridgeConfig) public remoteBridgeConfigs;
    mapping(uint32 => bool) internal _hasRemoteBridgeConfigDomain;
    uint32[] internal _remoteBridgeConfigDomains;

    constructor(
        address _localToken,
        address _mailbox,
        address _vaultBridgeToken
    ) TokenRouter(1, 1, _mailbox) {
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

    function initialize(address _hook, address _owner) external initializer {
        _MailboxClient_initialize(_hook, address(0), _owner);
        localToken.forceApprove(address(vaultBridgeToken), type(uint256).max);
    }

    function token() public view override returns (address) {
        return address(localToken);
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
        bytes32,
        uint256 _amount
    ) external view override returns (Quote[] memory quotes) {
        _mustHaveRemoteConfig(_destination);
        quotes = new Quote[](2);
        quotes[0] = Quote({token: address(0), amount: 0});
        quotes[1] = Quote({token: address(localToken), amount: _amount});
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable override returns (bytes32) {
        RemoteBridgeConfig memory cfg = _mustHaveRemoteConfig(_destination);
        localToken.safeTransferFrom(msg.sender, address(this), _amount);
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

    function _transferFromSender(uint256) internal pure override {
        revert("unused");
    }

    function _transferTo(address, uint256) internal pure override {
        revert("unused");
    }

    function _handle(uint32, bytes32, bytes calldata) internal pure override {
        revert UnsupportedHandle();
    }

    function _mustHaveRemoteConfig(
        uint32 _domain
    ) internal view returns (RemoteBridgeConfig memory cfg) {
        cfg = remoteBridgeConfigs[_domain];
        if (
            cfg.agglayerNetworkId == 0 && !_hasRemoteBridgeConfigDomain[_domain]
        ) {
            revert RemoteConfigNotFound(_domain);
        }
    }
}
