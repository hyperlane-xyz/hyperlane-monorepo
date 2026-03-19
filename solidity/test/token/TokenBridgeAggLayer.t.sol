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
import {IAggLayerBridge} from "../../contracts/token/interfaces/IAggLayerBridge.sol";
import {IVaultBridgeToken} from "../../contracts/token/interfaces/IVaultBridgeToken.sol";

contract MockAgglayerBridge is IAggLayerBridge {
    uint32 public constant NETWORK_ID = 20;

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

    function networkID() external pure returns (uint32) {
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

    uint256 public lastRedeemShares;
    address public lastRedeemReceiver;
    address public lastRedeemOwner;

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
        uint256 shares,
        address receiver,
        address owner
    ) external returns (uint256 assets) {
        lastRedeemShares = shares;
        lastRedeemReceiver = receiver;
        lastRedeemOwner = owner;
        assets = shares;
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
    MockAgglayerBridge internal agglayerBridge;
    ERC20Test internal usdc;
    ERC20Test internal vbUsdc;
    MockVaultBridgeToken internal vaultBridgeToken;

    TokenBridgeAggLayer internal ethRoute;
    TokenBridgeAggLayer internal katanaRoute;

    function setUp() public {
        ethMailbox = new MockMailbox(ETH_DOMAIN);
        katanaMailbox = new MockMailbox(KATANA_DOMAIN);
        ethMailbox.addRemoteMailbox(KATANA_DOMAIN, katanaMailbox);
        katanaMailbox.addRemoteMailbox(ETH_DOMAIN, ethMailbox);

        agglayerBridge = new MockAgglayerBridge();
        usdc = new ERC20Test("USD Coin", "USDC", 0, 6);
        vbUsdc = new ERC20Test("Vault Bridge USDC", "vbUSDC", 0, 6);
        vaultBridgeToken = new MockVaultBridgeToken(address(usdc));

        ethRoute = _deployRoute(
            address(usdc),
            address(ethMailbox),
            address(agglayerBridge),
            address(vaultBridgeToken)
        );
        katanaRoute = _deployRoute(
            address(vbUsdc),
            address(katanaMailbox),
            address(agglayerBridge),
            address(0)
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

        ethRoute.setRemoteBridgeConfig(
            KATANA_DOMAIN,
            KATANA_NETWORK,
            address(vbUsdc),
            true
        );
        katanaRoute.setRemoteBridgeConfig(
            ETH_DOMAIN,
            ETH_NETWORK,
            address(vaultBridgeToken),
            false
        );
        vm.stopPrank();

        usdc.mintTo(ALICE, 1_000_000e6);
        vbUsdc.mintTo(ALICE, 1_000_000e6);
        vm.deal(ALICE, 1 ether);

        vm.prank(ALICE);
        usdc.approve(address(ethRoute), type(uint256).max);
        vm.prank(ALICE);
        vbUsdc.approve(address(katanaRoute), type(uint256).max);
    }

    function test_quoteTransferRemote_primaryRouteIncludesDispatchAndBridgeFee()
        public
    {
        Quote[] memory quotes = ethRoute.quoteTransferRemote(
            KATANA_DOMAIN,
            BOB.addressToBytes32(),
            100e6
        );

        assertEq(quotes.length, 2);
        assertEq(quotes[1].token, address(usdc));
        assertEq(quotes[1].amount, 100e6);
        assertEq(quotes[0].amount, 0);
    }

    function test_transferRemote_primaryRouteDepositsAndBridgesToRecipient()
        public
    {
        Quote[] memory quotes = ethRoute.quoteTransferRemote(
            KATANA_DOMAIN,
            BOB.addressToBytes32(),
            100e6
        );

        vm.prank(ALICE);
        ethRoute.transferRemote{value: quotes[0].amount}(
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
        assertEq(vaultBridgeToken.lastDepositValue(), 0);
        assertEq(usdc.balanceOf(address(ethRoute)), 100e6);
    }

    function test_transferRemote_secondaryRouteBridgesToRemoteRoute() public {
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

        assertEq(agglayerBridge.lastDestinationNetwork(), ETH_NETWORK);
        assertEq(agglayerBridge.lastDestinationAddress(), address(ethRoute));
        assertEq(agglayerBridge.lastAmount(), 50e6);
        assertEq(agglayerBridge.lastToken(), address(vbUsdc));
        assertEq(agglayerBridge.lastValue(), 0);
        assertEq(
            abi.decode(agglayerBridge.lastPermitData(), (bytes32)),
            keccak256(abi.encodePacked(BOB.addressToBytes32(), uint256(50e6)))
        );
    }

    function test_quoteTransferRemote_secondaryRouteIncludesConfigurableGas()
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

    function test_verify_primaryRouteClaimsAgglayerAssetForRedemption() public {
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
                metadata: abi.encode(keccak256(tokenMessage))
            })
        );

        ethRoute.verify(metadata, message);

        assertEq(
            agglayerBridge.lastClaimOriginNetwork(),
            agglayerBridge.NETWORK_ID()
        );
        assertEq(
            agglayerBridge.lastClaimOriginToken(),
            address(vaultBridgeToken)
        );
        assertEq(
            agglayerBridge.lastClaimDestinationNetwork(),
            agglayerBridge.NETWORK_ID()
        );
        assertEq(
            agglayerBridge.lastClaimDestinationAddress(),
            address(ethRoute)
        );
        assertEq(agglayerBridge.lastClaimAmount(), 100e6);
        assertEq(
            keccak256(agglayerBridge.lastClaimMetadata()),
            keccak256(abi.encode(keccak256(tokenMessage)))
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

    function test_handle_primaryRouteRedeemsToRecipient() public {
        bytes memory messageBody = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(100e6)
        );

        vm.prank(address(ethMailbox));
        ethRoute.handle(
            KATANA_DOMAIN,
            address(katanaRoute).addressToBytes32(),
            messageBody
        );

        assertEq(vaultBridgeToken.lastRedeemShares(), 100e6);
        assertEq(vaultBridgeToken.lastRedeemReceiver(), BOB);
        assertEq(vaultBridgeToken.lastRedeemOwner(), address(ethRoute));
    }

    function test_handle_secondaryRouteReverts() public {
        bytes memory messageBody = abi.encodePacked(
            BOB.addressToBytes32(),
            uint256(100e6)
        );

        vm.prank(address(katanaMailbox));
        vm.expectRevert(TokenBridgeAggLayer.UnsupportedHandle.selector);
        katanaRoute.handle(
            ETH_DOMAIN,
            address(ethRoute).addressToBytes32(),
            messageBody
        );
    }

    function test_verify_secondaryRouteReverts() public {
        bytes memory message = katanaMailbox.buildMessage(
            address(katanaRoute),
            ETH_DOMAIN,
            address(katanaRoute).addressToBytes32(),
            abi.encodePacked(BOB.addressToBytes32(), uint256(100e6))
        );

        vm.expectRevert(TokenBridgeAggLayer.UnsupportedVerify.selector);
        katanaRoute.verify(hex"", message);
    }

    function _emptyProof() internal pure returns (bytes32[32] memory proof) {}

    function _deployRoute(
        address _localToken,
        address _mailbox,
        address _agglayerBridge,
        address _vaultBridgeToken
    ) internal returns (TokenBridgeAggLayer route) {
        TokenBridgeAggLayer implementation = new TokenBridgeAggLayer(
            _localToken,
            _mailbox,
            _agglayerBridge,
            _vaultBridgeToken
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
}
