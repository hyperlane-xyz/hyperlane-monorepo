// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {InterchainGasPaymaster} from "../../contracts/hooks/igp/InterchainGasPaymaster.sol";
import {StorageGasOracle} from "../../contracts/hooks/igp/StorageGasOracle.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";
import {IPostDispatchHook} from "../../contracts/interfaces/hooks/IPostDispatchHook.sol";

import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {GasRouter} from "../../contracts/client/GasRouter.sol";
import {InterchainAccountRouter} from "../../contracts/middleware/InterchainAccountRouter.sol";
import {CallLib} from "../../contracts/middleware/libs/Call.sol";

/// @dev Attacker that replays IGP postDispatch after legitimate dispatches.
///      The warp router uses the SAME token for collateral and IGP fees,
///      so a successful replay could drain collateral.
contract IGPAttackerHandler is Test {
    using TypeCasts for address;
    using Message for bytes;

    InterchainGasPaymaster public immutable igp;
    MockMailbox public immutable mailbox;
    ERC20Test public immutable token; // same token for collateral + fees
    InterchainAccountRouter public immutable icaRouter;
    HypERC20Collateral public immutable warpRouter;

    address public immutable user;
    bytes32 public immutable icaRemoteRouter;
    bytes32 public immutable icaIsm;

    uint32 constant DESTINATION = 2;
    uint256 constant GAS_LIMIT = 50_000;

    constructor(
        InterchainGasPaymaster _igp,
        MockMailbox _mailbox,
        ERC20Test _token,
        InterchainAccountRouter _icaRouter,
        HypERC20Collateral _warpRouter,
        address _user,
        bytes32 _icaRemoteRouter,
        bytes32 _icaIsm
    ) {
        igp = _igp;
        mailbox = _mailbox;
        token = _token;
        icaRouter = _icaRouter;
        warpRouter = _warpRouter;
        user = _user;
        icaRemoteRouter = _icaRemoteRouter;
        icaIsm = _icaIsm;
    }

    /// @dev Legitimate ICA dispatch as user, then attacker replays postDispatch.
    ///      ICA router has infinite approval to IGP but 0 balance after dispatch.
    function tryICADispatchAndReplay() external {
        bytes memory hookMetadata = StandardHookMetadata.formatMetadata(
            0,
            GAS_LIMIT,
            address(0),
            abi.encodePacked(address(token))
        );

        uint256 fee = icaRouter.quoteGasPayment(
            address(token),
            DESTINATION,
            GAS_LIMIT
        );
        if (token.balanceOf(user) < fee) return;

        // User dispatches
        vm.startPrank(user);
        token.approve(address(icaRouter), fee);
        CallLib.Call[] memory calls = new CallLib.Call[](0);
        icaRouter.callRemoteWithOverrides(
            DESTINATION,
            icaRemoteRouter,
            icaIsm,
            calls,
            hookMetadata
        );
        vm.stopPrank();

        // Attacker replays postDispatch
        bytes memory replayMessage = MessageUtils.formatMessage(
            0,
            mailbox.nonce() - 1,
            1,
            address(icaRouter).addressToBytes32(),
            DESTINATION,
            icaRemoteRouter,
            ""
        );
        bytes memory replayMetadata = StandardHookMetadata.formatMetadata(
            0,
            GAS_LIMIT,
            address(0),
            abi.encodePacked(address(token))
        );
        try igp.postDispatch(replayMetadata, replayMessage) {} catch {}
    }

    /// @dev Legitimate warp transferRemote as user, then attacker replays.
    ///      Warp router holds collateral in the SAME token used for IGP fees.
    ///      The transient approval should prevent replay from draining collateral.
    function tryWarpDispatchAndReplay(uint256 amount) external {
        amount = bound(amount, 1e18, 10e18);
        if (token.balanceOf(user) < amount) return;

        // User transfers via warp route
        vm.startPrank(user);
        token.approve(address(warpRouter), type(uint256).max);
        warpRouter.transferRemote(DESTINATION, user.addressToBytes32(), amount);
        vm.stopPrank();

        // Attacker replays postDispatch — warp router holds collateral
        // and the IGP fee token is the same as collateral token
        bytes memory replayMessage = MessageUtils.formatMessage(
            0,
            mailbox.nonce() - 1,
            1,
            address(warpRouter).addressToBytes32(),
            DESTINATION,
            address(0x1).addressToBytes32(),
            ""
        );
        bytes memory replayMetadata = StandardHookMetadata.formatMetadata(
            0,
            GAS_LIMIT,
            address(0),
            abi.encodePacked(address(token))
        );
        try igp.postDispatch(replayMetadata, replayMessage) {} catch {}
    }

    receive() external payable {}
}

contract IGPPostDispatchInvariantTest is Test {
    using TypeCasts for address;

    InterchainGasPaymaster igp;
    MockMailbox originMailbox;
    MockMailbox destMailbox;
    TestPostDispatchHook noopHook;
    StorageGasOracle gasOracle;
    ERC20Test token; // single token for collateral + fees

    InterchainAccountRouter icaRouter;
    InterchainAccountRouter icaRouterDest;
    HypERC20Collateral warpRouter;

    IGPAttackerHandler attacker;

    uint256 constant USER_TOKENS = 500_000e18;
    uint256 constant WARP_COLLATERAL = 200_000e18;
    uint128 constant EXCHANGE_RATE = 1e10;
    uint128 constant GAS_PRICE = 150;
    uint96 constant GAS_OVERHEAD = 50_000;
    uint32 constant ORIGIN = 1;
    uint32 constant DESTINATION = 2;
    address user = address(0x71C71);

    function setUp() public {
        // Mailboxes
        originMailbox = new MockMailbox(ORIGIN);
        destMailbox = new MockMailbox(DESTINATION);
        originMailbox.addRemoteMailbox(DESTINATION, destMailbox);
        destMailbox.addRemoteMailbox(ORIGIN, originMailbox);

        noopHook = new TestPostDispatchHook();
        originMailbox.setDefaultHook(address(noopHook));
        originMailbox.setRequiredHook(address(noopHook));
        destMailbox.setDefaultHook(address(noopHook));
        destMailbox.setRequiredHook(address(noopHook));

        // Single token for both collateral and fees
        token = new ERC20Test("Token", "TKN", 2_000_000e18, 18);

        // IGP configured with token as fee token
        igp = new InterchainGasPaymaster(address(originMailbox));
        igp.initialize(address(this), address(this));

        gasOracle = new StorageGasOracle();
        gasOracle.setRemoteGasData(
            StorageGasOracle.RemoteGasDataConfig(
                DESTINATION,
                EXCHANGE_RATE,
                GAS_PRICE
            )
        );

        // Native oracle first (required before ERC20)
        InterchainGasPaymaster.GasParam[]
            memory gasParams = new InterchainGasPaymaster.GasParam[](1);
        gasParams[0] = InterchainGasPaymaster.GasParam(
            DESTINATION,
            InterchainGasPaymaster.DomainGasConfig(gasOracle, GAS_OVERHEAD)
        );
        igp.setDestinationGasConfigs(gasParams);

        // Same token as fee oracle
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory tokenConfigs = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        tokenConfigs[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            address(token),
            DESTINATION,
            gasOracle
        );
        igp.setTokenGasOracles(tokenConfigs);

        // ---- ICA Router ----
        string[] memory urls = new string[](1);
        icaRouter = new InterchainAccountRouter(
            address(originMailbox),
            address(igp),
            address(this),
            20_000,
            urls
        );
        icaRouterDest = new InterchainAccountRouter(
            address(destMailbox),
            address(igp),
            address(this),
            20_000,
            urls
        );
        icaRouter.enrollRemoteRouterAndIsm(
            DESTINATION,
            address(icaRouterDest).addressToBytes32(),
            bytes32(0)
        );

        // ---- Warp Collateral Router (same token for collateral AND fees) ----
        warpRouter = new HypERC20Collateral(
            address(token),
            1,
            1,
            address(originMailbox)
        );
        warpRouter.initialize(address(noopHook), address(0), address(this));

        HypERC20 remoteImpl = new HypERC20(18, 1, 1, address(destMailbox));
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(remoteImpl),
            address(0x37),
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                0,
                "Remote",
                "RMT",
                address(noopHook),
                address(0),
                address(this)
            )
        );
        warpRouter.enrollRemoteRouter(
            DESTINATION,
            address(proxy).addressToBytes32()
        );
        GasRouter.GasRouterConfig[]
            memory gasConf = new GasRouter.GasRouterConfig[](1);
        gasConf[0] = GasRouter.GasRouterConfig(DESTINATION, 50_000);
        warpRouter.setDestinationGas(gasConf);

        // Set IGP as the fee hook — warp router will use token() for gas fees
        warpRouter.setFeeHook(address(igp));
        warpRouter.setHook(address(igp));

        // Seed warp router with collateral (simulates prior deposits)
        token.transfer(address(warpRouter), WARP_COLLATERAL);

        // Fund user
        token.transfer(user, USER_TOKENS);

        // Attacker
        attacker = new IGPAttackerHandler(
            igp,
            originMailbox,
            token,
            icaRouter,
            warpRouter,
            user,
            address(icaRouterDest).addressToBytes32(),
            bytes32(0)
        );

        targetContract(address(attacker));
    }

    /// @dev ICA router never holds tokens after a tx — infinite approval
    ///      to IGP is harmless because balance is always 0.
    function invariant_icaRouterZeroBalance() public view {
        assertEq(
            token.balanceOf(address(icaRouter)),
            0,
            "ICA router holds tokens"
        );
    }

    /// @dev Warp collateral is never drained by IGP postDispatch replay.
    ///      Despite collateral token == fee token and warp router holding
    ///      collateral, the transient approval prevents replay from pulling
    ///      more than the quoted fee per dispatch.
    function invariant_warpCollateralNotDrained() public view {
        // Warp balance should be >= initial collateral (user deposits add to it)
        assertGe(
            token.balanceOf(address(warpRouter)),
            WARP_COLLATERAL,
            "warp collateral drained by replay"
        );
    }

    /// @dev Token conservation — all tokens accounted for across all addresses.
    function invariant_tokenConservation() public view {
        uint256 total = token.balanceOf(user) +
            token.balanceOf(address(igp)) +
            token.balanceOf(address(icaRouter)) +
            token.balanceOf(address(warpRouter)) +
            token.balanceOf(address(attacker));
        assertEq(total, USER_TOKENS + WARP_COLLATERAL, "tokens not conserved");
    }
}
