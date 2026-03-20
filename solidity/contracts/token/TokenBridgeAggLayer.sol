// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity >=0.8.0;

import {IInterchainSecurityModule} from "../interfaces/IInterchainSecurityModule.sol";
import {Quote} from "../interfaces/ITokenBridge.sol";
import {AbstractCcipReadIsm} from "../isms/ccip-read/AbstractCcipReadIsm.sol";
import {Message} from "../libs/Message.sol";
import {TypeCasts} from "../libs/TypeCasts.sol";
import {TokenMessage} from "./libs/TokenMessage.sol";
import {TokenRouter} from "./libs/TokenRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAggLayerBridge} from "./interfaces/IAggLayerBridge.sol";

interface AggLayerService {
    function getAggLayerClaimMetadata(
        bytes calldata _message
    ) external view returns (bytes memory);
}

/// @notice Generic AggLayer-backed token bridge.
/// @dev This route only handles AggLayer transport. Any asset-specific wrapping
/// or redemption, e.g. Vault Bridge deposit/redeem, must happen outside it.
contract TokenBridgeAggLayer is TokenRouter, AbstractCcipReadIsm {
    using Message for bytes;
    using SafeERC20 for IERC20;
    using TokenMessage for bytes;
    using TypeCasts for address;
    using TypeCasts for bytes32;

    struct RemoteBridgeConfig {
        uint32 agglayerNetworkId;
        address remoteToken;
        bool forceUpdateGlobalExitRoot;
    }

    struct ClaimMetadata {
        bytes32[32] smtProofLocalExitRoot;
        bytes32[32] smtProofRollupExitRoot;
        uint256 globalIndex;
        bytes32 mainnetExitRoot;
        bytes32 rollupExitRoot;
        // Must equal `abi.encode(messageId)` for the exact Hyperlane message.
        bytes metadata;
    }

    error InvalidLocalToken(address token);
    error InvalidAgglayerBridge(address bridge);
    error InvalidRemoteToken(uint32 domain);
    error RemoteConfigNotFound(uint32 domain);
    error InvalidClaimMetadata();

    event RemoteBridgeConfigSet(
        uint32 indexed domain,
        uint32 indexed agglayerNetworkId,
        address indexed remoteToken,
        bool forceUpdateGlobalExitRoot
    );
    event RemoteBridgeConfigRemoved(uint32 indexed domain);

    IERC20 public immutable localToken;
    IAggLayerBridge public immutable agglayerBridge;
    uint32 public immutable localAgglayerNetworkId;

    mapping(uint32 => RemoteBridgeConfig) public remoteBridgeConfigs;
    mapping(uint32 => bool) internal _hasRemoteBridgeConfigDomain;
    uint32[] internal _remoteBridgeConfigDomains;
    mapping(bytes32 => bool) public isVerified;

    constructor(
        address _localToken,
        address _mailbox,
        address _agglayerBridge
    ) TokenRouter(1, 1, _mailbox) {
        if (_localToken == address(0) || _localToken.code.length == 0) {
            revert InvalidLocalToken(_localToken);
        }
        if (_agglayerBridge == address(0) || _agglayerBridge.code.length == 0) {
            revert InvalidAgglayerBridge(_agglayerBridge);
        }

        localToken = IERC20(_localToken);
        agglayerBridge = IAggLayerBridge(_agglayerBridge);
        localAgglayerNetworkId = IAggLayerBridge(_agglayerBridge).networkID();
        _disableInitializers();
    }

    function initialize(
        address _hook,
        address _owner,
        string[] memory __urls
    ) external initializer {
        __Ownable_init();
        setHook(_hook);
        setInterchainSecurityModule(address(0));
        setUrls(__urls);
        localToken.forceApprove(address(agglayerBridge), type(uint256).max);
        _transferOwnership(_owner);
    }

    function interchainSecurityModule()
        external
        view
        override
        returns (IInterchainSecurityModule)
    {
        return IInterchainSecurityModule(address(this));
    }

    function token() public view override returns (address) {
        return address(localToken);
    }

    function setRemoteBridgeConfig(
        uint32 _domain,
        uint32 _agglayerNetworkId,
        address _remoteToken,
        bool _forceUpdateGlobalExitRoot
    ) external onlyOwner {
        if (_remoteToken == address(0)) revert InvalidRemoteToken(_domain);

        remoteBridgeConfigs[_domain] = RemoteBridgeConfig({
            agglayerNetworkId: _agglayerNetworkId,
            remoteToken: _remoteToken,
            forceUpdateGlobalExitRoot: _forceUpdateGlobalExitRoot
        });
        if (!_hasRemoteBridgeConfigDomain[_domain]) {
            _hasRemoteBridgeConfigDomain[_domain] = true;
            _remoteBridgeConfigDomains.push(_domain);
        }

        emit RemoteBridgeConfigSet(
            _domain,
            _agglayerNetworkId,
            _remoteToken,
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
    ) external view override returns (Quote[] memory quotes) {
        _mustHaveRemoteConfig(_destination);

        address _feeToken = feeToken();
        uint256 dispatchFee = _quoteGasPayment(
            _destination,
            _recipient,
            _amount,
            _feeToken
        );

        quotes = new Quote[](2);
        quotes[0] = Quote({token: _feeToken, amount: dispatchFee});
        quotes[1] = Quote({token: token(), amount: _amount});
    }

    function transferRemote(
        uint32 _destination,
        bytes32 _recipient,
        uint256 _amount
    ) public payable override returns (bytes32 messageId) {
        RemoteBridgeConfig memory cfg = _mustHaveRemoteConfig(_destination);
        address _feeHook = feeHook();
        address _feeToken = feeToken();
        (, uint256 remainingNativeValue) = _calculateFeesAndCharge(
            _destination,
            _recipient,
            _amount,
            msg.value,
            _feeHook
        );

        bytes memory _tokenMessage = TokenMessage.format(_recipient, _amount);
        messageId = _emitAndDispatch(
            _destination,
            _recipient,
            _amount,
            remainingNativeValue,
            _tokenMessage,
            _feeToken
        );

        // The bridge transfer commits to the exact Hyperlane `messageId`.
        // Claim metadata must reproduce that same id in `verify`, so a valid
        // AggLayer proof cannot be replayed against another Hyperlane message.
        agglayerBridge.bridgeAsset(
            cfg.agglayerNetworkId,
            _mustHaveRemoteRouter(_destination).bytes32ToAddress(),
            _amount,
            address(localToken),
            cfg.forceUpdateGlobalExitRoot,
            abi.encode(messageId)
        );
    }

    function verify(
        bytes calldata _metadata,
        bytes calldata _message
    ) external returns (bool) {
        bytes32 messageId = _message.id();
        if (isVerified[messageId]) {
            return true;
        }

        ClaimMetadata memory claim = abi.decode(_metadata, (ClaimMetadata));
        if (
            claim.metadata.length != 32 ||
            abi.decode(claim.metadata, (bytes32)) != messageId
        ) {
            revert InvalidClaimMetadata();
        }

        isVerified[messageId] = true;
        _claimBridgedAsset(_message.origin(), claim, _message.body().amount());
        return true;
    }

    function _offchainLookupCalldata(
        bytes calldata _message
    ) internal pure override returns (bytes memory) {
        return
            abi.encodeCall(
                AggLayerService.getAggLayerClaimMetadata,
                (_message)
            );
    }

    function _transferFromSender(uint256 _amount) internal override {
        localToken.safeTransferFrom(msg.sender, address(this), _amount);
    }

    function _transferTo(
        address _recipient,
        uint256 _amount
    ) internal override {
        localToken.safeTransfer(_recipient, _amount);
    }

    function _handle(
        uint32 _origin,
        bytes32,
        bytes calldata _message
    ) internal override {
        bytes32 recipient = TokenMessage.recipient(_message);
        uint256 amount = TokenMessage.amount(_message);

        emit ReceivedTransferRemote(_origin, recipient, amount);
        _transferTo(recipient.bytes32ToAddress(), amount);
    }

    function _mustHaveRemoteConfig(
        uint32 _domain
    ) internal view returns (RemoteBridgeConfig memory) {
        RemoteBridgeConfig memory cfg = remoteBridgeConfigs[_domain];
        if (cfg.remoteToken == address(0)) revert RemoteConfigNotFound(_domain);
        return cfg;
    }

    function _claimBridgedAsset(
        uint32 _origin,
        ClaimMetadata memory _claim,
        uint256 _amount
    ) internal {
        RemoteBridgeConfig memory sourceConfig = _mustHaveRemoteConfig(_origin);
        agglayerBridge.claimAsset(
            _claim.smtProofLocalExitRoot,
            _claim.smtProofRollupExitRoot,
            _claim.globalIndex,
            _claim.mainnetExitRoot,
            _claim.rollupExitRoot,
            sourceConfig.agglayerNetworkId,
            sourceConfig.remoteToken,
            localAgglayerNetworkId,
            address(this),
            _amount,
            _claim.metadata
        );
    }
}
