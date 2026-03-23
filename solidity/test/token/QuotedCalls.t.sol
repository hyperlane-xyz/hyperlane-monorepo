// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {TransparentUpgradeableProxy} from "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";
import {IAllowanceTransfer} from "permit2/interfaces/IAllowanceTransfer.sol";

import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MockMailbox} from "../../contracts/mock/MockMailbox.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {InterchainGasPaymaster} from "../../contracts/hooks/igp/InterchainGasPaymaster.sol";
import {StorageGasOracle} from "../../contracts/hooks/igp/StorageGasOracle.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";
import {GasRouter} from "../../contracts/client/GasRouter.sol";
import {ITokenBridge} from "../../contracts/interfaces/ITokenBridge.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";

import {AbstractOffchainQuoter} from "../../contracts/libs/AbstractOffchainQuoter.sol";
import {SignedQuote} from "../../contracts/interfaces/IOffchainQuoter.sol";
import {OffchainQuotedLinearFee, FeeQuoteContext, FeeQuoteData} from "../../contracts/token/fees/OffchainQuotedLinearFee.sol";
import {IGPQuoteContext, IGPQuoteData} from "../../contracts/hooks/igp/OffchainQuotedIGP.sol";
import {QuotedCalls} from "../../contracts/token/QuotedCalls.sol";
import {HypERC20} from "../../contracts/token/HypERC20.sol";
import {HypERC20Collateral} from "../../contracts/token/HypERC20Collateral.sol";
import {TokenRouter} from "../../contracts/token/libs/TokenRouter.sol";
import {InterchainAccountRouter} from "../../contracts/middleware/InterchainAccountRouter.sol";
import {CallLib} from "../../contracts/middleware/libs/Call.sol";
import {Quote} from "../../contracts/interfaces/ITokenBridge.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Minimal mock Permit2. Skips signature verification; just sets allowances and transfers.
contract MockPermit2 {
    // owner => token => spender => amount
    mapping(address => mapping(address => mapping(address => uint160)))
        public allowances;

    function permit(
        address owner,
        IAllowanceTransfer.PermitSingle calldata permitSingle,
        bytes calldata
    ) external {
        allowances[owner][permitSingle.details.token][
            permitSingle.spender
        ] = permitSingle.details.amount;
    }

    function transferFrom(
        address from,
        address to,
        uint160 amount,
        address token
    ) external {
        uint160 allowed = allowances[from][token][msg.sender];
        if (allowed != type(uint160).max) {
            require(allowed >= amount, "insufficient allowance");
            allowances[from][token][msg.sender] = allowed - amount;
        }
        IERC20(token).transferFrom(from, to, amount);
    }
}

contract QuotedCallsTest is Test {
    using TypeCasts for address;

    uint32 constant ORIGIN = 11;
    uint32 constant DESTINATION = 12;
    uint256 constant SCALE = 1;
    uint8 constant DECIMALS = 18;
    uint256 constant TOTAL_SUPPLY = 1_000_000e18;
    uint256 constant TRANSFER_AMT = 100e18;
    uint256 constant MAX_FEE = 0.01 ether;
    uint256 constant HALF_AMOUNT = 0.5 ether;
    uint256 constant GAS_LIMIT = 50_000;
    uint96 constant GAS_OVERHEAD = 10_000;
    uint128 constant ORACLE_EXCHANGE_RATE = 1e10;
    uint128 constant ORACLE_GAS_PRICE = 10;
    uint128 constant OFFCHAIN_EXCHANGE_RATE = 2e10;
    uint128 constant OFFCHAIN_GAS_PRICE = 20;
    address constant ALICE = address(0x1);
    address constant BOB = address(0x2);
    address constant PROXY_ADMIN = address(0x37);

    uint256 signerPk = 0xA11CE;
    address signer;

    MockPermit2 permit2;
    ERC20Test primaryToken;
    HypERC20Collateral localToken;
    HypERC20 remoteToken;
    MockMailbox localMailbox;
    MockMailbox remoteMailbox;
    TestPostDispatchHook noopHook;
    InterchainGasPaymaster igp;
    StorageGasOracle gasOracle;
    OffchainQuotedLinearFee quotedFee;
    QuotedCalls quotedCalls;

    function setUp() public {
        signer = vm.addr(signerPk);
        CLIENT_SALT = bytes32(uint256(uint160(address(this))));

        permit2 = new MockPermit2();

        localMailbox = new MockMailbox(ORIGIN);
        remoteMailbox = new MockMailbox(DESTINATION);
        localMailbox.addRemoteMailbox(DESTINATION, remoteMailbox);
        remoteMailbox.addRemoteMailbox(ORIGIN, localMailbox);

        noopHook = new TestPostDispatchHook();
        localMailbox.setDefaultHook(address(noopHook));
        localMailbox.setRequiredHook(address(noopHook));
        remoteMailbox.setDefaultHook(address(noopHook));
        remoteMailbox.setRequiredHook(address(noopHook));

        primaryToken = new ERC20Test("Test", "TST", TOTAL_SUPPLY, DECIMALS);

        igp = new InterchainGasPaymaster();
        igp.initialize(address(this), address(this));
        igp.addQuoteSigner(signer);

        gasOracle = new StorageGasOracle();
        StorageGasOracle.RemoteGasDataConfig[]
            memory configs = new StorageGasOracle.RemoteGasDataConfig[](1);
        configs[0] = StorageGasOracle.RemoteGasDataConfig({
            remoteDomain: DESTINATION,
            tokenExchangeRate: ORACLE_EXCHANGE_RATE,
            gasPrice: ORACLE_GAS_PRICE
        });
        gasOracle.setRemoteGasDataConfigs(configs);

        InterchainGasPaymaster.GasParam[]
            memory gasParams = new InterchainGasPaymaster.GasParam[](1);
        gasParams[0] = InterchainGasPaymaster.GasParam({
            remoteDomain: DESTINATION,
            config: InterchainGasPaymaster.DomainGasConfig({
                gasOracle: gasOracle,
                gasOverhead: GAS_OVERHEAD
            })
        });
        igp.setDestinationGasConfigs(gasParams);

        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory tokenConfigs = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        tokenConfigs[0] = InterchainGasPaymaster.TokenGasOracleConfig({
            feeToken: address(primaryToken),
            remoteDomain: DESTINATION,
            gasOracle: gasOracle
        });
        igp.setTokenGasOracles(tokenConfigs);

        HypERC20 remoteImpl = new HypERC20(
            DECIMALS,
            SCALE,
            SCALE,
            address(remoteMailbox)
        );
        TransparentUpgradeableProxy proxy = new TransparentUpgradeableProxy(
            address(remoteImpl),
            PROXY_ADMIN,
            abi.encodeWithSelector(
                HypERC20.initialize.selector,
                TOTAL_SUPPLY,
                "Test",
                "TST",
                address(noopHook),
                address(0),
                address(this)
            )
        );
        remoteToken = HypERC20(address(proxy));

        localToken = new HypERC20Collateral(
            address(primaryToken),
            SCALE,
            SCALE,
            address(localMailbox)
        );
        localToken.initialize(address(noopHook), address(0), address(this));

        quotedFee = new OffchainQuotedLinearFee(
            signer,
            address(primaryToken),
            MAX_FEE,
            HALF_AMOUNT,
            signer
        );
        localToken.setFeeRecipient(address(quotedFee));

        localToken.enrollRemoteRouter(
            DESTINATION,
            address(remoteToken).addressToBytes32()
        );
        remoteToken.enrollRemoteRouter(
            ORIGIN,
            address(localToken).addressToBytes32()
        );

        GasRouter.GasRouterConfig[]
            memory gasRouterConfigs = new GasRouter.GasRouterConfig[](1);
        gasRouterConfigs[0] = GasRouter.GasRouterConfig({
            domain: DESTINATION,
            gas: GAS_LIMIT
        });
        localToken.setDestinationGas(gasRouterConfigs);

        primaryToken.transfer(ALICE, 1000e18);
        primaryToken.transfer(address(localToken), 1000e18);

        quotedCalls = new QuotedCalls(IAllowanceTransfer(address(permit2)));

        // ALICE approves MockPermit2 for token pulls (one-time)
        vm.prank(ALICE);
        primaryToken.approve(address(permit2), type(uint256).max);
    }

    // ============ Helpers ============

    function _domainSeparator(
        address verifier
    ) internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256("OffchainQuoter"),
                    keccak256("1"),
                    block.chainid,
                    verifier
                )
            );
    }

    function _signQuote(
        address verifier,
        SignedQuote memory sq
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                quotedFee.SIGNED_QUOTE_TYPEHASH(),
                keccak256(sq.context),
                keccak256(sq.data),
                sq.issuedAt,
                sq.expiry,
                sq.salt,
                sq.submitter
            )
        );
        bytes32 digest = ECDSA.toTypedDataHash(
            _domainSeparator(verifier),
            structHash
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    bytes32 CLIENT_SALT;

    function _scopedSalt(address caller) internal view returns (bytes32) {
        return keccak256(abi.encodePacked(caller, CLIENT_SALT));
    }

    function _feeQuoteContext() internal pure returns (bytes memory) {
        return
            FeeQuoteContext.encode(
                DESTINATION,
                BOB.addressToBytes32(),
                TRANSFER_AMT
            );
    }

    function _buildFeeQuote(
        address caller
    ) internal view returns (bytes memory) {
        return _buildFeeQuote(true, caller);
    }

    function _buildFeeQuote(
        bool transient_,
        address caller
    ) internal view returns (bytes memory) {
        uint48 now_ = uint48(block.timestamp);
        // Standing quotes must use wildcard amount (linear fee scales with any amount)
        bytes memory context = transient_
            ? _feeQuoteContext()
            : FeeQuoteContext.encode(
                DESTINATION,
                BOB.addressToBytes32(),
                type(uint256).max
            );
        SignedQuote memory sq = SignedQuote({
            context: context,
            data: FeeQuoteData.encode(MAX_FEE, HALF_AMOUNT),
            issuedAt: now_,
            expiry: transient_ ? now_ : now_ + 3600,
            salt: _scopedSalt(caller),
            submitter: address(quotedCalls)
        });
        return
            abi.encode(
                address(quotedFee),
                sq,
                _signQuote(address(quotedFee), sq),
                CLIENT_SALT
            );
    }

    function _encodeGasData(
        uint128 exchangeRate,
        uint128 gasPrice
    ) internal pure returns (bytes memory) {
        return IGPQuoteData.encode(exchangeRate, gasPrice);
    }

    function _buildIgpQuote(
        address caller
    ) internal view returns (bytes memory) {
        return
            _buildIgpQuote(
                true,
                caller,
                address(primaryToken),
                address(localToken)
            );
    }

    function _buildIgpQuote(
        address caller,
        address feeToken,
        address sender
    ) internal view returns (bytes memory) {
        return _buildIgpQuote(true, caller, feeToken, sender);
    }

    function _buildIgpQuote(
        bool transient_,
        address caller,
        address feeToken,
        address sender
    ) internal view returns (bytes memory) {
        uint48 now_ = uint48(block.timestamp);
        SignedQuote memory sq = SignedQuote({
            context: IGPQuoteContext.encode(feeToken, DESTINATION, sender),
            data: _encodeGasData(OFFCHAIN_EXCHANGE_RATE, OFFCHAIN_GAS_PRICE),
            issuedAt: now_,
            expiry: transient_ ? now_ : now_ + 3600,
            salt: _scopedSalt(caller),
            submitter: address(quotedCalls)
        });
        return
            abi.encode(
                address(igp),
                sq,
                _signQuote(address(igp), sq),
                CLIENT_SALT
            );
    }

    function _computeOffchainIgpFee() internal view returns (uint256) {
        return _computeOffchainIgpFee(GAS_LIMIT);
    }

    function _computeOffchainIgpFee(
        uint256 gasLimit
    ) internal view returns (uint256) {
        uint256 totalGas = igp.destinationGasLimit(DESTINATION, gasLimit);
        return
            (totalGas *
                uint256(OFFCHAIN_GAS_PRICE) *
                uint256(OFFCHAIN_EXCHANGE_RATE)) / 1e10;
    }

    // ============ Command Builders ============

    function _cmdSubmitQuote(
        bytes memory quoteInput
    ) internal view returns (bytes1, bytes memory) {
        return (bytes1(uint8(quotedCalls.SUBMIT_QUOTE())), quoteInput);
    }

    function _cmdPermit2Permit(
        IAllowanceTransfer.PermitSingle memory permitSingle,
        bytes memory signature
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.PERMIT2_PERMIT())),
            abi.encode(permitSingle, signature)
        );
    }

    function _cmdPermit2TransferFrom(
        address token,
        uint256 amount
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.PERMIT2_TRANSFER_FROM())),
            abi.encode(token, amount)
        );
    }

    function _cmdTransferRemote(
        address warpRoute,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        uint256 value,
        address token,
        uint256 approval
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.TRANSFER_REMOTE())),
            abi.encode(
                warpRoute,
                destination,
                recipient,
                amount,
                value,
                token,
                approval
            )
        );
    }

    function _cmdTransferRemoteTo(
        address router,
        uint32 destination,
        bytes32 recipient,
        uint256 amount,
        bytes32 targetRouter,
        uint256 value,
        address token,
        uint256 approval
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.TRANSFER_REMOTE_TO())),
            abi.encode(
                router,
                destination,
                recipient,
                amount,
                targetRouter,
                value,
                token,
                approval
            )
        );
    }

    function _cmdCallRemoteWithOverrides(
        address icaRouter,
        uint32 destination,
        bytes32 router,
        bytes32 ism,
        CallLib.Call[] memory calls,
        bytes memory hookMetadata,
        bytes32 userSalt,
        uint256 value,
        address token,
        uint256 approval
    ) internal view returns (bytes1, bytes memory) {
        return (
            bytes1(uint8(quotedCalls.CALL_REMOTE_WITH_OVERRIDES())),
            abi.encode(
                icaRouter,
                destination,
                router,
                ism,
                calls,
                hookMetadata,
                userSalt,
                value,
                token,
                approval
            )
        );
    }

    function _cmdSweep(
        address token
    ) internal view returns (bytes1, bytes memory) {
        return (bytes1(uint8(quotedCalls.SWEEP())), abi.encode(token));
    }

    function _pack(
        bytes1[] memory cmds,
        bytes[] memory ins
    ) internal pure returns (bytes memory commands, bytes[] memory inputs) {
        commands = new bytes(cmds.length);
        for (uint256 i; i < cmds.length; ++i) {
            commands[i] = cmds[i];
        }
        inputs = ins;
    }

    // ============ Tests: ERC20 transferFrom path ============

    /// @dev ALICE approves QuotedCalls directly — ERC20 transferFrom succeeds on first try
    function test_transferFrom_erc20Path() public {
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[1], ins[1]) = _cmdPermit2TransferFrom(
            address(primaryToken),
            totalTokens
        );
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        // Direct ERC20 approval — transferFrom succeeds without Permit2
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
        // Permit2 allowance untouched (ERC20 path was used)
        assertEq(
            permit2.allowances(
                ALICE,
                address(primaryToken),
                address(quotedCalls)
            ),
            0
        );
    }

    // ============ Tests: Permit2 fallback path ============

    /// @dev No direct ERC20 approval to QuotedCalls — ERC20 transferFrom fails,
    ///      falls back to Permit2 which has allowance via PERMIT2_PERMIT
    function test_transferFrom_permit2Fallback() public {
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;

        IAllowanceTransfer.PermitSingle memory permitSingle = IAllowanceTransfer
            .PermitSingle({
                details: IAllowanceTransfer.PermitDetails({
                    token: address(primaryToken),
                    amount: uint160(totalTokens),
                    expiration: uint48(block.timestamp + 3600),
                    nonce: 0
                }),
                spender: address(quotedCalls),
                sigDeadline: block.timestamp + 3600
            });

        bytes1[] memory cmds = new bytes1[](4);
        bytes[] memory ins = new bytes[](4);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[1], ins[1]) = _cmdPermit2Permit(permitSingle, "");
        (cmds[2], ins[2]) = _cmdPermit2TransferFrom(
            address(primaryToken),
            totalTokens
        );
        (cmds[3], ins[3]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        // No direct ERC20 approval to QuotedCalls — only Permit2
        vm.prank(ALICE);
        quotedCalls.execute(commands, inputs);

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
        // Permit2 allowance was consumed
        assertEq(
            permit2.allowances(
                ALICE,
                address(primaryToken),
                address(quotedCalls)
            ),
            0
        );
    }

    // ============ Tests: CONTRACT_BALANCE sentinel ============

    /// @dev Pull exact amount, then use CONTRACT_BALANCE for transferRemote
    ///      so it bridges whatever is left after fees
    function test_transferRemote_withContractBalance() public {
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;
        uint256 CONTRACT_BAL = quotedCalls.CONTRACT_BALANCE();

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[1], ins[1]) = _cmdPermit2TransferFrom(
            address(primaryToken),
            totalTokens
        );
        // Use CONTRACT_BALANCE for approval — resolves to the full contract
        // balance so the warp route can pull transfer amount + fees
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            CONTRACT_BAL
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
    }

    /// @dev Use CONTRACT_BALANCE for native value — resolves to contract's ETH balance
    function test_transferRemote_withNativeContractBalance() public {
        uint256 CONTRACT_BAL = quotedCalls.CONTRACT_BALANCE();
        uint256 nativeValue = 1 ether;
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[1], ins[1]) = _cmdPermit2TransferFrom(
            address(primaryToken),
            totalTokens
        );
        // value = CONTRACT_BALANCE resolves to address(this).balance
        (cmds[2], ins[2]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            CONTRACT_BAL,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.deal(ALICE, nativeValue);
        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute{value: nativeValue}(commands, inputs);
        vm.stopPrank();

        // native ETH was forwarded to the warp route
        assertEq(address(quotedCalls).balance, 0);
    }

    // ============ Tests: No Quotes Reverts ============

    function test_execute_noQuotes_reverts() public {
        bytes1[] memory cmds = new bytes1[](2);
        bytes[] memory ins = new bytes[](2);
        (cmds[0], ins[0]) = _cmdPermit2TransferFrom(
            address(primaryToken),
            TRANSFER_AMT
        );
        (cmds[1], ins[1]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            TRANSFER_AMT
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), TRANSFER_AMT);
        vm.expectRevert();
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();
    }

    // ============ Tests: IGP + Fee Quote ============

    function test_execute_withIgpAndFeeQuotes() public {
        localToken.setFeeHook(address(igp));
        localToken.setHook(address(igp));

        uint256 igpFee = _computeOffchainIgpFee();
        uint256 totalTokens = TRANSFER_AMT + MAX_FEE + igpFee;

        bytes1[] memory cmds = new bytes1[](4);
        bytes[] memory ins = new bytes[](4);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildIgpQuote(ALICE));
        (cmds[1], ins[1]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[2], ins[2]) = _cmdPermit2TransferFrom(
            address(primaryToken),
            totalTokens
        );
        (cmds[3], ins[3]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(igp)), igpFee);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
    }

    // ============ Tests: Multi-Call with ICA + Warp ============

    function test_execute_withIcaAndWarpQuotes() public {
        string[] memory icaUrls = new string[](1);
        icaUrls[0] = "https://quoter.example.com/{data}";
        InterchainAccountRouter icaRouter = new InterchainAccountRouter(
            address(localMailbox),
            address(igp),
            address(this),
            0,
            icaUrls
        );
        icaRouter.enrollRemoteRouter(
            DESTINATION,
            address(0xdead).addressToBytes32()
        );

        localToken.setFeeHook(address(igp));
        localToken.setHook(address(igp));

        uint256 warpIgpFee = _computeOffchainIgpFee();
        uint256 icaNativeFee = _computeOffchainIgpFee(50_000);
        uint256 totalERC20 = TRANSFER_AMT + MAX_FEE + warpIgpFee;

        CallLib.Call[] memory remoteIcaCalls = new CallLib.Call[](1);
        remoteIcaCalls[0] = CallLib.Call({
            to: address(0xbeef).addressToBytes32(),
            value: 0,
            data: ""
        });

        bytes memory hookMetadata = StandardHookMetadata.format(
            icaNativeFee,
            uint256(50_000),
            address(quotedCalls)
        );

        bytes1[] memory cmds = new bytes1[](7);
        bytes[] memory ins = new bytes[](7);
        (cmds[0], ins[0]) = _cmdSubmitQuote(
            _buildIgpQuote(ALICE, address(primaryToken), address(localToken))
        );
        (cmds[1], ins[1]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));
        (cmds[2], ins[2]) = _cmdPermit2TransferFrom(
            address(primaryToken),
            totalERC20
        );
        (cmds[3], ins[3]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalERC20
        );
        (cmds[4], ins[4]) = _cmdSubmitQuote(
            _buildIgpQuote(ALICE, address(0), address(icaRouter))
        );
        (cmds[5], ins[5]) = _cmdCallRemoteWithOverrides(
            address(icaRouter),
            DESTINATION,
            address(0xdead).addressToBytes32(),
            bytes32(0),
            remoteIcaCalls,
            hookMetadata,
            bytes32(0),
            icaNativeFee,
            address(0),
            0
        );
        (cmds[6], ins[6]) = _cmdSweep(address(0));

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.deal(ALICE, icaNativeFee);
        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalERC20);
        quotedCalls.execute{value: icaNativeFee}(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalERC20);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(igp)), warpIgpFee);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
        assertEq(address(igp).balance, icaNativeFee);
        assertEq(address(quotedCalls).balance, 0);
    }

    // ============ Tests: ICA with CONTRACT_BALANCE ============

    /// @dev Use CONTRACT_BALANCE for ICA native value and ERC20 approval
    function test_callRemote_withContractBalance() public {
        uint256 CONTRACT_BAL = quotedCalls.CONTRACT_BALANCE();

        string[] memory icaUrls = new string[](1);
        icaUrls[0] = "https://quoter.example.com/{data}";
        InterchainAccountRouter icaRouter = new InterchainAccountRouter(
            address(localMailbox),
            address(igp),
            address(this),
            0,
            icaUrls
        );
        icaRouter.enrollRemoteRouter(
            DESTINATION,
            address(0xdead).addressToBytes32()
        );

        localToken.setFeeHook(address(igp));
        localToken.setHook(address(igp));

        uint256 icaNativeFee = _computeOffchainIgpFee(50_000);

        CallLib.Call[] memory remoteIcaCalls = new CallLib.Call[](1);
        remoteIcaCalls[0] = CallLib.Call({
            to: address(0xbeef).addressToBytes32(),
            value: 0,
            data: ""
        });

        bytes memory hookMetadata = StandardHookMetadata.format(
            icaNativeFee,
            uint256(50_000),
            address(quotedCalls)
        );

        bytes1[] memory cmds = new bytes1[](3);
        bytes[] memory ins = new bytes[](3);
        (cmds[0], ins[0]) = _cmdSubmitQuote(
            _buildIgpQuote(ALICE, address(0), address(icaRouter))
        );
        // CONTRACT_BALANCE for both native value and approval
        (cmds[1], ins[1]) = _cmdCallRemoteWithOverrides(
            address(icaRouter),
            DESTINATION,
            address(0xdead).addressToBytes32(),
            bytes32(0),
            remoteIcaCalls,
            hookMetadata,
            bytes32(0),
            CONTRACT_BAL, // value resolves to address(this).balance
            address(0),
            0
        );
        (cmds[2], ins[2]) = _cmdSweep(address(0));

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.deal(ALICE, icaNativeFee);
        vm.startPrank(ALICE);
        quotedCalls.execute{value: icaNativeFee}(commands, inputs);
        vm.stopPrank();

        assertEq(address(igp).balance, icaNativeFee);
        assertEq(address(quotedCalls).balance, 0);
    }

    // ============ Tests: Standing Quotes ============

    function test_execute_withStandingFeeQuote() public {
        bytes1[] memory setupCmds = new bytes1[](1);
        bytes[] memory setupIns = new bytes[](1);
        (setupCmds[0], setupIns[0]) = _cmdSubmitQuote(
            _buildFeeQuote(false, address(this))
        );
        (bytes memory setupCommands, bytes[] memory setupInputs) = _pack(
            setupCmds,
            setupIns
        );
        quotedCalls.execute(setupCommands, setupInputs);

        uint256 totalTokens = TRANSFER_AMT + MAX_FEE;

        bytes1[] memory cmds = new bytes1[](2);
        bytes[] memory ins = new bytes[](2);
        (cmds[0], ins[0]) = _cmdPermit2TransferFrom(
            address(primaryToken),
            totalTokens
        );
        (cmds[1], ins[1]) = _cmdTransferRemote(
            address(localToken),
            DESTINATION,
            BOB.addressToBytes32(),
            TRANSFER_AMT,
            0,
            address(primaryToken),
            totalTokens
        );

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.startPrank(ALICE);
        primaryToken.approve(address(quotedCalls), totalTokens);
        quotedCalls.execute(commands, inputs);
        vm.stopPrank();

        assertEq(primaryToken.balanceOf(ALICE), 1000e18 - totalTokens);
        assertEq(primaryToken.balanceOf(address(quotedFee)), MAX_FEE);
        assertEq(primaryToken.balanceOf(address(quotedCalls)), 0);
    }

    // ============ Tests: Salt Validation ============

    function test_execute_wrongSalt_reverts() public {
        bytes1[] memory cmds = new bytes1[](1);
        bytes[] memory ins = new bytes[](1);
        (cmds[0], ins[0]) = _cmdSubmitQuote(_buildFeeQuote(ALICE));

        (bytes memory commands, bytes[] memory inputs) = _pack(cmds, ins);

        vm.expectRevert(QuotedCalls.InvalidSalt.selector);
        quotedCalls.execute(commands, inputs);
    }

    // ============ Tests: Invalid Command ============

    function test_execute_invalidCommand_reverts() public {
        bytes memory commands = hex"ff";
        bytes[] memory inputs = new bytes[](1);
        inputs[0] = "";

        vm.expectRevert(
            abi.encodeWithSelector(QuotedCalls.InvalidCommandType.selector, 255)
        );
        quotedCalls.execute(commands, inputs);
    }

    receive() external payable {}
}
