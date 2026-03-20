// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.13;

import "forge-std/Test.sol";

import {Message} from "../../contracts/libs/Message.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {GasRouter} from "../../contracts/client/GasRouter.sol";
import {TestInterchainGasPaymaster} from "../../contracts/test/TestInterchainGasPaymaster.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import {TokenBridgeAggLayer} from "../../contracts/token/TokenBridgeAggLayer.sol";
import {TokenBridgeVaultBridge} from "../../contracts/token/TokenBridgeVaultBridge.sol";
import {IAggLayerBridge} from "../../contracts/token/interfaces/IAggLayerBridge.sol";
import {IVaultBridgeToken} from "../../contracts/token/interfaces/IVaultBridgeToken.sol";

contract MockAgglayerBridge is IAggLayerBridge {
    uint32 public immutable NETWORK_ID;

    uint32 public lastDestinationNetwork;
    address public lastDestinationAddress;
    uint256 public lastAmount;
    address public lastToken;
    bool public lastForceUpdateGlobalExitRoot;
    uint256 public lastValue;
    bytes public lastPermitData;

    uint32 public lastClaimOriginNetwork;
    address public lastClaimOriginToken;
    uint32 public lastClaimDestinationNetwork;
    address public lastClaimDestinationAddress;
    uint256 public lastClaimAmount;
    bytes public lastClaimMetadata;

    constructor(uint32 _networkId) {
        NETWORK_ID = _networkId;
    }

    function networkID() external view returns (uint32) {
        return NETWORK_ID;
    }

    function bridgeAsset(
        uint32 destinationNetwork,
        address destinationAddress,
        uint256 amount,
        address token,
        bool forceUpdateGlobalExitRoot,
        bytes calldata permitData
    ) external payable {
        lastDestinationNetwork = destinationNetwork;
        lastDestinationAddress = destinationAddress;
        lastAmount = amount;
        lastToken = token;
        lastForceUpdateGlobalExitRoot = forceUpdateGlobalExitRoot;
        lastValue = msg.value;
        lastPermitData = permitData;
    }

    function claimAsset(
        bytes32[32] calldata,
        bytes32[32] calldata,
        uint256,
        bytes32,
        bytes32,
        uint32 originNetwork,
        address originTokenAddress,
        uint32 destinationNetwork,
        address destinationAddress,
        uint256 amount,
        bytes calldata metadata
    ) external {
        lastClaimOriginNetwork = originNetwork;
        lastClaimOriginToken = originTokenAddress;
        lastClaimDestinationNetwork = destinationNetwork;
        lastClaimDestinationAddress = destinationAddress;
        lastClaimAmount = amount;
        lastClaimMetadata = metadata;
    }
}

contract MockVaultBridgeToken is IVaultBridgeToken {
    ERC20Test public immutable underlying;

    uint256 public lastDepositAssets;
    address public lastDepositReceiver;
    uint32 public lastDepositDestinationNetwork;
    bool public lastDepositForceUpdateGlobalExitRoot;
    uint256 public lastDepositValue;

    constructor(address _underlying) {
        underlying = ERC20Test(_underlying);
    }

    function asset() external view returns (address) {
        return address(underlying);
    }

    function depositAndBridge(
        uint256 assets,
        address receiver,
        uint32 destinationNetworkId,
        bool forceUpdateGlobalExitRoot
    ) external payable returns (uint256 shares) {
        lastDepositAssets = assets;
        lastDepositReceiver = receiver;
        lastDepositDestinationNetwork = destinationNetworkId;
        lastDepositForceUpdateGlobalExitRoot = forceUpdateGlobalExitRoot;
        lastDepositValue = msg.value;
        shares = assets;
    }

    function redeem(
        uint256,
        address,
        address
    ) external pure returns (uint256 assets) {
        revert("unused");
    }
}

contract TokenBridgeAggLayerTest is Test {
    using Message for bytes;
    using TypeCasts for address;

    uint32 internal constant ETH_DOMAIN = 1;
    uint32 internal constant KATANA_DOMAIN = 2;
    uint32 internal constant ETH_NETWORK = 0;
    uint32 internal constant KATANA_NETWORK = 20;

    address internal constant OWNER = address(0xBEEF);
    address internal constant ALICE = address(0xA11CE);
    address internal constant BOB = address(0xB0B);
    address internal constant PROXY_ADMIN = address(0xABCD);

    MockMailbox internal ethMailbox;
    MockMailbox internal katanaMailbox;
    MockAgglayerBridge internal ethAgglayerBridge;
    MockAgglayerBridge internal katanaAgglayerBridge;
    ERC20Test internal ethVbUsdc;
    ERC20Test internal katanaVbUsdc;
    ERC20Test internal usdc;
    MockVaultBridgeToken internal vaultBridgeToken;

    TokenBridgeAggLayer internal ethRoute;
    TokenBridgeAggLayer internal katanaRoute;
    TokenBridgeVaultBridge internal vaultWrapper;

    function setUp() public {
        ethMailbox = new MockMailbox(ETH_DOMAIN);
        katanaMailbox = new MockMailbox(KATANA_DOMAIN);
        ethMailbox.addRemoteMailbox(KATANA_DOMAIN, katanaMailbox);
        katanaMailbox.addRemoteMailbox(ETH_DOMAIN, ethMailbox);

        ethAgglayerBridge = new MockAgglayerBridge(ETH_NETWORK);
        katanaAgglayerBridge = new MockAgglayerBridge(KATANA_NETWORK);
        ethVbUsdc = new ERC20Test("Ethereum vbUSDC", "evbUSDC", 0, 6);
        katanaVbUsdc = new ERC20Test("Katana vbUSDC", "kvbUSDC", 0, 6);
        usdc = new ERC20Test("USD Coin", "USDC", 0, 6);
        vaultBridgeToken = new MockVaultBridgeToken(address(usdc));

        ethRoute = _deployAggLayerRoute(
            address(ethVbUsdc),
            address(ethMailbox),
            address(ethAgglayerBridge)
        );
        katanaRoute = _deployAggLayerRoute(
            address(katanaVbUsdc),
            address(katanaMailbox),
            address(katanaAgglayerBridge)
        );
        vaultWrapper = _deployVaultBridgeWrapper(
            address(usdc),
            address(vaultBridgeToken)
        );

        vm.startPrank(OWNER);
        ethRoute.enrollRemoteRouter(
            KATANA_DOMAIN,
            address(katanaRoute).addressToBytes32()
        );
        katanaRoute.enrollRemoteRouter(
            ETH_DOMAIN,
            address(ethRoute).addressToBytes32()
        );
        vaultWrapper.enrollRemoteRouter(
            KATANA_DOMAIN,
            address(katanaRoute).addressToBytes32()
        );
        ethRoute.setRemoteBridgeConfig(
            KATANA_DOMAIN,
            KATANA_NETWORK,
            address(katanaVbUsdc),
            true
        );
        katanaRoute.setRemoteBridgeConfig(
            ETH_DOMAIN,
            ETH_NETWORK,
            address(ethVbUsdc),
            false
        );
        vaultWrapper.setRemoteBridgeConfig(KATANA_DOMAIN, KATANA_NETWORK, true);
        vm.stopPrank();

        usdc.mintTo(ALICE, 1_000_000e6);
        ethVbUsdc.mintTo(ALICE, 1_000_000e6);
        katanaVbUsdc.mintTo(ALICE, 1_000_000e6);
        vm.deal(ALICE, 1 ether);

        vm.startPrank(ALICE);
        usdc.approve(address(vaultWrapper), type(uint256).max);
        ethVbUsdc.approve(address(ethRoute), type(uint256).max);
        katanaVbUsdc.approve(address(katanaRoute), type(uint256).max);
        vm.stopPrank();
    }

    function test_quoteTransferRemote_genericRouteIncludesTokenAndDispatchFee()
        public
    {
        Quote[] memory quotes = katanaRoute.quoteTransferRemote(
            ETH_DOMAIN,
            BOB.addressToBytes32(),
            50e6
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 0);
        assertEq(quotes[1].token, address(katanaVbUsdc));
        assertEq(quotes[1].amount, 50e6);
    }

    function test_transferRemote_genericRouteDispatchesAndBridgesToRemoteRoute()
        public
    {
        Quote[] memory quotes = katanaRoute.quoteTransferRemote(
            ETH_DOMAIN,
            BOB.addressToBytes32(),
            50e6
        );

        vm.prank(ALICE);
        katanaRoute.transferRemote{value: quotes[0].amount}(
            ETH_DOMAIN,
            BOB.addressToBytes32(),
            50e6
        );

        assertEq(katanaAgglayerBridge.lastDestinationNetwork(), ETH_NETWORK);
        assertEq(
            katanaAgglayerBridge.lastDestinationAddress(),
            address(ethRoute)
        );
        assertEq(katanaAgglayerBridge.lastAmount(), 50e6);
        assertEq(katanaAgglayerBridge.lastToken(), address(katanaVbUsdc));
        assertEq(katanaAgglayerBridge.lastValue(), 0);
        assertEq(
            abi.decode(katanaAgglayerBridge.lastPermitData(), (bytes32)),
            katanaMailbox.latestDispatchedId()
        );
    }

    function test_quoteTransferRemote_genericRouteIncludesConfigurableGas()
        public
    {
        TestInterchainGasPaymaster igp = new TestInterchainGasPaymaster();
        GasRouter.GasRouterConfig[]
            memory gasConfigs = new GasRouter.GasRouterConfig[](1);
        gasConfigs[0] = GasRouter.GasRouterConfig({
            domain: ETH_DOMAIN,
            gas: 321_000
        });

        vm.startPrank(OWNER);
        katanaRoute.setHook(address(igp));
        katanaRoute.setDestinationGas(gasConfigs);
        vm.stopPrank();

        Quote[] memory quotes = katanaRoute.quoteTransferRemote(
            ETH_DOMAIN,
            BOB.addressToBytes32(),
            50e6
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 321_000 * 10);
        assertEq(quotes[1].amount, 50e6);
    }

    function test_verify_claimsAgglayerAssetUsingOriginRemoteConfig() public {
        bytes memory tokenMessage = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(100e6)
        );
        bytes memory message = katanaMailbox.buildMessage(
            address(katanaRoute),
            ETH_DOMAIN,
            address(ethRoute).addressToBytes32(),
            tokenMessage
        );

        bytes memory metadata = abi.encode(
            TokenBridgeAggLayer.ClaimMetadata({
                smtProofLocalExitRoot: _emptyProof(),
                smtProofRollupExitRoot: _emptyProof(),
                globalIndex: 7,
                mainnetExitRoot: bytes32(uint256(1)),
                rollupExitRoot: bytes32(uint256(2)),
                metadata: abi.encode(message.id())
            })
        );

        ethRoute.verify(metadata, message);

        assertEq(ethAgglayerBridge.lastClaimOriginNetwork(), KATANA_NETWORK);
        assertEq(
            ethAgglayerBridge.lastClaimOriginToken(),
            address(katanaVbUsdc)
        );
        assertEq(ethAgglayerBridge.lastClaimDestinationNetwork(), ETH_NETWORK);
        assertEq(
            ethAgglayerBridge.lastClaimDestinationAddress(),
            address(ethRoute)
        );
        assertEq(ethAgglayerBridge.lastClaimAmount(), 100e6);
        assertEq(
            keccak256(ethAgglayerBridge.lastClaimMetadata()),
            keccak256(abi.encode(message.id()))
        );
    }

    function test_verify_revertsWhenClaimMetadataDoesNotMatchMessage() public {
        bytes memory tokenMessage = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(100e6)
        );
        bytes memory message = katanaMailbox.buildMessage(
            address(katanaRoute),
            ETH_DOMAIN,
            address(ethRoute).addressToBytes32(),
            tokenMessage
        );

        bytes memory metadata = abi.encode(
            TokenBridgeAggLayer.ClaimMetadata({
                smtProofLocalExitRoot: _emptyProof(),
                smtProofRollupExitRoot: _emptyProof(),
                globalIndex: 7,
                mainnetExitRoot: bytes32(uint256(1)),
                rollupExitRoot: bytes32(uint256(2)),
                metadata: abi.encode(bytes32(uint256(0x1234)))
            })
        );

        vm.expectRevert(TokenBridgeAggLayer.InvalidClaimMetadata.selector);
        ethRoute.verify(metadata, message);
    }

    function test_handle_transfersClaimedTokensToRecipient() public {
        katanaVbUsdc.mintTo(address(katanaRoute), 100e6);
        bytes memory messageBody = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(100e6)
        );

        vm.prank(address(katanaMailbox));
        katanaRoute.handle(
            ETH_DOMAIN,
            address(ethRoute).addressToBytes32(),
            messageBody
        );

        assertEq(katanaVbUsdc.balanceOf(BOB), 100e6);
        assertEq(katanaVbUsdc.balanceOf(address(katanaRoute)), 0);
    }

    function test_remoteBridgeConfigDomainsTracksConfiguredDomains() public {
        uint32[] memory configuredDomains = ethRoute
            .remoteBridgeConfigDomains();
        assertEq(configuredDomains.length, 1);
        assertEq(configuredDomains[0], KATANA_DOMAIN);

        vm.prank(OWNER);
        ethRoute.setRemoteBridgeConfig(3, 30, address(0x1234), false);
        configuredDomains = ethRoute.remoteBridgeConfigDomains();
        assertEq(configuredDomains.length, 2);

        vm.prank(OWNER);
        ethRoute.removeRemoteBridgeConfig(KATANA_DOMAIN);
        configuredDomains = ethRoute.remoteBridgeConfigDomains();
        assertEq(configuredDomains.length, 1);
        assertEq(configuredDomains[0], 3);
    }

    function test_quoteTransferRemote_vaultWrapperQuotesUnderlyingOnly()
        public
    {
        Quote[] memory quotes = vaultWrapper.quoteTransferRemote(
            KATANA_DOMAIN,
            BOB.addressToBytes32(),
            100e6
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[0].token, address(0));
        assertEq(quotes[0].amount, 0);
        assertEq(quotes[1].token, address(usdc));
        assertEq(quotes[1].amount, 100e6);
    }

    function test_transferRemote_vaultWrapperDepositsAndBridgesToRecipient()
        public
    {
        vm.prank(ALICE);
        vaultWrapper.transferRemote(
            KATANA_DOMAIN,
            BOB.addressToBytes32(),
            100e6
        );

        assertEq(vaultBridgeToken.lastDepositAssets(), 100e6);
        assertEq(vaultBridgeToken.lastDepositReceiver(), BOB);
        assertEq(
            vaultBridgeToken.lastDepositDestinationNetwork(),
            KATANA_NETWORK
        );
        assertTrue(vaultBridgeToken.lastDepositForceUpdateGlobalExitRoot());
        assertEq(vaultBridgeToken.lastDepositValue(), 0);
        assertEq(usdc.balanceOf(address(vaultWrapper)), 100e6);
    }

    function test_handle_vaultWrapperReverts() public {
        vm.prank(address(ethMailbox));
        vm.expectRevert(TokenBridgeVaultBridge.UnsupportedHandle.selector);
        vaultWrapper.handle(
            KATANA_DOMAIN,
            address(katanaRoute).addressToBytes32(),
            hex""
        );
    }

    function _emptyProof() internal pure returns (bytes32[32] memory proof) {}

    function _deployAggLayerRoute(
        address _localToken,
        address _mailbox,
        address _agglayerBridge
    ) internal returns (TokenBridgeAggLayer route) {
        TokenBridgeAggLayer implementation = new TokenBridgeAggLayer(
            _localToken,
            _mailbox,
            _agglayerBridge
        );

        string[] memory urls = new string[](1);
        urls[0] = "https://offchain-lookup.example";

        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeCall(
                TokenBridgeAggLayer.initialize,
                (address(0), OWNER, urls)
            )
        );

        return TokenBridgeAggLayer(address(proxy));
    }

    function _deployVaultBridgeWrapper(
        address _localToken,
        address _vaultBridgeToken
    ) internal returns (TokenBridgeVaultBridge wrapper) {
        TokenBridgeVaultBridge implementation = new TokenBridgeVaultBridge(
            _localToken,
            address(ethMailbox),
            _vaultBridgeToken
        );

        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(implementation),
            PROXY_ADMIN,
            abi.encodeCall(
                TokenBridgeVaultBridge.initialize,
                (address(0), OWNER)
            )
        );

        return TokenBridgeVaultBridge(address(proxy));
    }
}
