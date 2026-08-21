// SPDX-License-Identifier: MIT OR Apache-2.0
pragma solidity ^0.8.19;

import {Test, Vm} from "forge-std/Test.sol";

import {AbstractWormholeHookIsm} from "contracts/hooks/wormhole/AbstractWormholeHookIsm.sol";
import {WormholeExecutorHookIsm} from "contracts/hooks/wormhole/WormholeExecutorHookIsm.sol";
import {WormholeMessage} from "contracts/libs/WormholeMessage.sol";
import {WormholeVaaHookIsm} from "contracts/hooks/wormhole/WormholeVaaHookIsm.sol";
import {CustomConsistencyLevelLib, WormholeConsistencyLevelConfig} from "contracts/hooks/wormhole/libs/CustomConsistencyLevel.sol";
import {IPostDispatchHook} from "contracts/interfaces/hooks/IPostDispatchHook.sol";
import {IInterchainSecurityModule} from "contracts/interfaces/IInterchainSecurityModule.sol";
import {ICoreBridge} from "contracts/interfaces/wormhole/ICoreBridge.sol";
import {ICustomConsistencyLevel} from "contracts/interfaces/wormhole/ICustomConsistencyLevel.sol";
import {IWormholeHookIsm, RemoteRouterEnrollment} from "contracts/interfaces/wormhole/IWormholeHookIsm.sol";
import {Message} from "contracts/libs/Message.sol";
import {TypeCasts} from "contracts/libs/TypeCasts.sol";
import {MockExecutorQuoterRouter} from "contracts/mock/MockExecutorQuoterRouter.sol";
import {TestMailbox} from "contracts/test/TestMailbox.sol";
import {TestPostDispatchHook} from "contracts/test/TestPostDispatchHook.sol";
import {TestRecipient} from "contracts/test/TestRecipient.sol";

/// @dev Getters the official Core exposes beyond the integration's `ICoreBridge`.
interface ICoreBridgeGuardians {
    struct GuardianSet {
        address[] keys;
        uint32 expirationTime;
    }

    function getCurrentGuardianSetIndex() external view returns (uint32);

    function getGuardianSet(
        uint32 index
    ) external view returns (GuardianSet memory);
}

/**
 * @title WormholeHookIsmForkTest
 * @notice Exercises both routers against the official Wormhole Core proxies on
 * Ethereum and Base.
 *
 * @dev What is real here: the Core proxies, their `chainId`/`evmChainId`/
 * `messageFee`/`nextSequence` accounting, the `LogMessagePublished` event, the
 * VAA wire format, and Core's own `parseAndVerifyVM` signature verification.
 *
 * What is substituted: the Guardian keys. There is no Guardian network to sign
 * for a locally dispatched message, so the current Guardian set is replaced with
 * one deterministic test key inside the fork — the same substitution Wormhole's
 * own `WormholeOverride` helper performs. Every override is asserted through
 * Core's public getters before it is relied on, so a layout change fails loudly
 * instead of silently weakening the test.
 *
 * The Executor Quoter Router is mocked unless
 * `WORMHOLE_EXECUTOR_QUOTER_ROUTER_ETHEREUM` names a deployed router; Core
 * publication stays real either way.
 */
contract WormholeHookIsmForkTest is Test {
    using Message for bytes;
    using TypeCasts for address;

    // ============ Official deployments ============

    address internal constant CORE_ETHEREUM =
        0x98f3c9e6E3fAce36bAAd05FE09d375Ef1464288B;
    address internal constant CORE_BASE =
        0xbebdb6C8ddC678FfA9f8748f85C815C556Dd8ac6;
    address internal constant CCL_ETHEREUM =
        0x6A4B4A882F5F0a447078b4Fd0b4B571A82371ec2;

    uint16 internal constant WH_ETHEREUM = 2;
    uint16 internal constant WH_BASE = 30;

    uint32 internal constant HYP_ETHEREUM = 1;
    uint32 internal constant HYP_BASE = 8453;

    uint8 internal constant CONSISTENCY_FINALIZED = 202;
    uint8 internal constant CONSISTENCY_CUSTOM = 203;
    uint8 internal constant CONSISTENCY_INSTANT = 200;
    uint128 internal constant CALLBACK_GAS = 300_000;
    uint8 internal constant PRODUCTION_GUARDIAN_COUNT = 19;
    uint8 internal constant PRODUCTION_SIGNATURE_COUNT = 13;

    bytes32 internal constant LOG_MESSAGE_PUBLISHED_TOPIC =
        keccak256("LogMessagePublished(address,uint64,uint32,bytes,uint8)");

    /// @dev Wormhole `Storage.WormholeState.guardianSets` mapping slot.
    uint256 internal constant GUARDIAN_SETS_SLOT = 2;

    // ============ Fixture ============

    struct VaaFields {
        uint32 timestamp;
        uint32 nonce;
        uint16 emitterChainId;
        bytes32 emitterAddress;
        uint64 sequence;
        uint8 consistencyLevel;
        bytes payload;
    }

    function _consistencyLevelConfig()
        internal
        pure
        returns (WormholeConsistencyLevelConfig memory)
    {
        return
            WormholeConsistencyLevelConfig({
                consistencyLevel: CONSISTENCY_FINALIZED,
                customConsistencyLevel: address(0),
                baseConsistencyLevel: 0,
                additionalBlocks: 0
            });
    }

    uint256 internal ethereumFork;
    uint256 internal baseFork;

    TestMailbox internal ethereumMailbox;
    TestMailbox internal baseMailbox;
    TestPostDispatchHook internal ethereumNoopHook;
    TestPostDispatchHook internal baseNoopHook;
    TestRecipient internal baseRecipient;

    uint256 internal guardianKey;
    address internal guardian;

    function setUp() public {
        (guardian, guardianKey) = makeAddrAndKey("wormholeTestGuardian");

        baseFork = vm.createSelectFork("base");
        baseMailbox = new TestMailbox(HYP_BASE);
        baseNoopHook = new TestPostDispatchHook();
        baseRecipient = new TestRecipient();
        baseMailbox.setDefaultHook(address(baseNoopHook));
        baseMailbox.setRequiredHook(address(baseNoopHook));
        baseMailbox.setDefaultIsm(address(baseNoopHook));

        ethereumFork = vm.createSelectFork("mainnet");
        ethereumMailbox = new TestMailbox(HYP_ETHEREUM);
        ethereumNoopHook = new TestPostDispatchHook();
        ethereumMailbox.setDefaultHook(address(ethereumNoopHook));
        ethereumMailbox.setRequiredHook(address(ethereumNoopHook));

        vm.deal(address(this), 100 ether);
    }

    // ============ Official deployment sanity ============

    function testFork_ethereumCoreIdentity() public {
        vm.selectFork(ethereumFork);
        _assertCoreIdentity(CORE_ETHEREUM, WH_ETHEREUM, 1);
    }

    function testFork_baseCoreIdentity() public {
        vm.selectFork(baseFork);
        _assertCoreIdentity(CORE_BASE, WH_BASE, 8453);
    }

    function testFork_customFinalityRegistersEmitterWithOfficialCcl() public {
        vm.selectFork(ethereumFork);
        string[] memory urls = new string[](1);
        urls[0] = "https://vaa.example/getWormholeVaa";
        WormholeVaaHookIsm router = new WormholeVaaHookIsm(
            address(ethereumMailbox),
            CORE_ETHEREUM,
            WormholeConsistencyLevelConfig({
                consistencyLevel: CONSISTENCY_CUSTOM,
                customConsistencyLevel: CCL_ETHEREUM,
                baseConsistencyLevel: CONSISTENCY_INSTANT,
                additionalBlocks: 2
            }),
            urls
        );

        bytes32 expected = CustomConsistencyLevelLib.encodeAdditionalBlocks(
            CONSISTENCY_INSTANT,
            2
        );
        assertEq(router.consistencyLevel(), CONSISTENCY_CUSTOM);
        assertEq(address(router.customConsistencyLevel()), CCL_ETHEREUM);
        assertEq(
            ICustomConsistencyLevel(CCL_ETHEREUM).getConfiguration(
                address(router)
            ),
            expected
        );
    }

    function _assertCoreIdentity(
        address core,
        uint16 expectedWormholeChainId,
        uint256 expectedEvmChainId
    ) internal view {
        assertGt(core.code.length, 0, "Core has no code");
        assertEq(
            ICoreBridge(core).chainId(),
            expectedWormholeChainId,
            "unexpected Wormhole chain ID"
        );
        assertEq(
            ICoreBridge(core).evmChainId(),
            expectedEvmChainId,
            "unexpected EVM chain ID"
        );
        // `nextSequence` must answer for an emitter that has never published.
        assertEq(ICoreBridge(core).nextSequence(address(this)), 0);
    }

    // ============ Publication through the real Core ============

    function testFork_publishThroughOfficialCore() public {
        (
            WormholeVaaHookIsm originRouter,
            WormholeVaaHookIsm destinationRouter
        ) = _deployVaaMesh();

        vm.selectFork(ethereumFork);
        uint256 coreFee = ICoreBridge(CORE_ETHEREUM).messageFee();
        uint256 quoted = IPostDispatchHook(address(originRouter)).quoteDispatch(
            "",
            _buildMessage()
        );
        assertEq(quoted, coreFee, "direct-VAA quote must be Core fee only");

        bytes memory message = _buildMessage();
        vm.recordLogs();
        _dispatchFrom(originRouter, quoted);

        (
            uint64 sequence,
            uint32 nonce,
            bytes memory payload,
            uint8 consistencyLevel
        ) = _readPublication(address(originRouter));

        assertEq(
            nonce,
            _nonce(message),
            "Wormhole nonce must be the Hyperlane nonce"
        );
        assertEq(consistencyLevel, CONSISTENCY_FINALIZED);
        assertEq(
            payload,
            WormholeMessage.encode(
                HYP_ETHEREUM,
                HYP_BASE,
                address(destinationRouter).addressToBytes32(),
                message.id(),
                _nonce(message)
            ),
            "unexpected published payload"
        );
        assertEq(payload.length, WormholeMessage.ENCODED_LENGTH);
        assertEq(
            ICoreBridge(CORE_ETHEREUM).nextSequence(address(originRouter)),
            sequence + 1,
            "Core sequence must advance by one"
        );
    }

    // ============ Direct-VAA end to end ============

    function testFork_directVaaEndToEnd() public {
        (
            WormholeVaaHookIsm originRouter,
            WormholeVaaHookIsm destinationRouter
        ) = _deployVaaMesh();

        vm.selectFork(ethereumFork);
        bytes memory message = _buildMessage();
        vm.recordLogs();
        _dispatchFrom(originRouter, ICoreBridge(CORE_ETHEREUM).messageFee());
        (
            uint64 sequence,
            uint32 nonce,
            bytes memory payload,
            uint8 consistencyLevel
        ) = _readPublication(address(originRouter));

        vm.selectFork(baseFork);
        bytes memory encodedVaa = _signProductionVaa(
            CORE_BASE,
            VaaFields({
                timestamp: uint32(block.timestamp),
                nonce: nonce,
                emitterChainId: WH_ETHEREUM,
                emitterAddress: address(originRouter).addressToBytes32(),
                sequence: sequence,
                consistencyLevel: consistencyLevel,
                payload: payload
            })
        );

        // Core itself must accept the signatures.
        (, bool valid, string memory reason) = ICoreBridge(CORE_BASE)
            .parseAndVerifyVM(encodedVaa);
        assertTrue(valid, reason);

        // A production-sized VAA fits the ISM metadata path.
        bytes memory metadata = abi.encode(encodedVaa);
        assertGt(encodedVaa.length, WormholeMessage.ENCODED_LENGTH);

        baseRecipient.setInterchainSecurityModule(address(destinationRouter));
        baseMailbox.process(metadata, message);

        assertTrue(baseMailbox.delivered(message.id()));
        assertEq(baseRecipient.lastData(), _body());
    }

    function testFork_directVaaRejectsForeignSignature() public {
        (WormholeVaaHookIsm originRouter, ) = _deployVaaMesh();

        vm.selectFork(ethereumFork);
        vm.recordLogs();
        _dispatchFrom(originRouter, ICoreBridge(CORE_ETHEREUM).messageFee());
        (
            uint64 sequence,
            uint32 nonce,
            bytes memory payload,
            uint8 consistencyLevel
        ) = _readPublication(address(originRouter));

        vm.selectFork(baseFork);
        uint32 guardianSetIndex = ICoreBridgeGuardians(CORE_BASE)
            .getCurrentGuardianSetIndex();
        // Signed by a key that is not in the Guardian set.
        (, uint256 impostorKey) = makeAddrAndKey("impostor");
        guardianKey = impostorKey;
        bytes memory encodedVaa = _signVaa(
            VaaFields({
                timestamp: uint32(block.timestamp),
                nonce: nonce,
                emitterChainId: WH_ETHEREUM,
                emitterAddress: address(originRouter).addressToBytes32(),
                sequence: sequence,
                consistencyLevel: consistencyLevel,
                payload: payload
            }),
            guardianSetIndex
        );

        (, bool valid, ) = ICoreBridge(CORE_BASE).parseAndVerifyVM(encodedVaa);
        assertFalse(valid, "Core accepted a foreign signature");
    }

    function testFork_malformedVaaIsRejected() public {
        vm.selectFork(baseFork);
        // Core's parser reverts on truncated input rather than returning false.
        vm.expectRevert();
        ICoreBridge(CORE_BASE).parseAndVerifyVM(hex"01deadbeef");
    }

    function testFork_expiredGuardianSetIsRejected() public {
        (WormholeVaaHookIsm originRouter, ) = _deployVaaMesh();

        vm.selectFork(ethereumFork);
        vm.recordLogs();
        _dispatchFrom(originRouter, ICoreBridge(CORE_ETHEREUM).messageFee());
        (
            uint64 sequence,
            uint32 nonce,
            bytes memory payload,
            uint8 consistencyLevel
        ) = _readPublication(address(originRouter));

        vm.selectFork(baseFork);
        uint32 currentIndex = ICoreBridgeGuardians(CORE_BASE)
            .getCurrentGuardianSetIndex();
        require(currentIndex > 0, "no historical Guardian set to expire");
        uint32 staleIndex = currentIndex - 1;
        _writeGuardianSet(CORE_BASE, staleIndex, guardian, 1);

        bytes memory encodedVaa = _signVaa(
            VaaFields({
                timestamp: uint32(block.timestamp),
                nonce: nonce,
                emitterChainId: WH_ETHEREUM,
                emitterAddress: address(originRouter).addressToBytes32(),
                sequence: sequence,
                consistencyLevel: consistencyLevel,
                payload: payload
            }),
            staleIndex
        );

        (, bool valid, string memory reason) = ICoreBridge(CORE_BASE)
            .parseAndVerifyVM(encodedVaa);
        assertFalse(valid, "expired Guardian set was accepted");
        assertGt(bytes(reason).length, 0);
    }

    // ============ Executor end to end ============

    function testFork_executorCallbackEndToEnd() public {
        vm.selectFork(baseFork);
        address baseQuoterRouter = _quoterRouterFor("BASE");
        WormholeExecutorHookIsm destinationRouter = new WormholeExecutorHookIsm(
            address(baseMailbox),
            CORE_BASE,
            _consistencyLevelConfig(),
            baseQuoterRouter
        );

        vm.selectFork(ethereumFork);
        address ethereumQuoterRouter = _quoterRouterFor("ETHEREUM");
        WormholeExecutorHookIsm originRouter = new WormholeExecutorHookIsm(
            address(ethereumMailbox),
            CORE_ETHEREUM,
            _consistencyLevelConfig(),
            ethereumQuoterRouter
        );
        originRouter.enrollRemoteRouter(
            WormholeExecutorHookIsm.ExecutorRemoteRouterEnrollment({
                remoteRouter: RemoteRouterEnrollment({
                    domain: HYP_BASE,
                    router: address(destinationRouter).addressToBytes32(),
                    wormholeChainId: WH_BASE,
                    expectedConsistencyLevel: CONSISTENCY_FINALIZED
                }),
                quoter: _quoterKey(),
                callbackGasLimit: CALLBACK_GAS
            })
        );

        vm.selectFork(baseFork);
        destinationRouter.enrollRemoteRouter(
            WormholeExecutorHookIsm.ExecutorRemoteRouterEnrollment({
                remoteRouter: RemoteRouterEnrollment({
                    domain: HYP_ETHEREUM,
                    router: address(originRouter).addressToBytes32(),
                    wormholeChainId: WH_ETHEREUM,
                    expectedConsistencyLevel: CONSISTENCY_FINALIZED
                }),
                quoter: _quoterKey(),
                callbackGasLimit: CALLBACK_GAS
            })
        );

        vm.selectFork(ethereumFork);
        bytes memory message = _buildMessage();
        uint256 quoted = IPostDispatchHook(address(originRouter)).quoteDispatch(
            "",
            message
        );
        assertGe(
            quoted,
            ICoreBridge(CORE_ETHEREUM).messageFee(),
            "Executor quote must cover the Core fee"
        );

        vm.recordLogs();
        _dispatchFrom(AbstractWormholeHookIsm(address(originRouter)), quoted);
        (
            uint64 sequence,
            uint32 nonce,
            bytes memory payload,
            uint8 consistencyLevel
        ) = _readPublication(address(originRouter));

        vm.selectFork(baseFork);
        bytes memory encodedVaa = _signProductionVaa(
            CORE_BASE,
            VaaFields({
                timestamp: uint32(block.timestamp),
                nonce: nonce,
                emitterChainId: WH_ETHEREUM,
                emitterAddress: address(originRouter).addressToBytes32(),
                sequence: sequence,
                consistencyLevel: consistencyLevel,
                payload: payload
            })
        );

        _executeVaaWithinCallbackGas(destinationRouter, encodedVaa);

        assertEq(
            destinationRouter.authorizations(HYP_ETHEREUM, message.id()),
            uint64(_nonce(message)) + 1
        );

        baseRecipient.setInterchainSecurityModule(address(destinationRouter));
        baseMailbox.process("", message);
        assertTrue(baseMailbox.delivered(message.id()));
    }

    // ============ Fixture helpers ============

    function _body() internal pure returns (bytes memory) {
        return bytes("hyperlane over wormhole fork");
    }

    /// @dev `Message` parses `bytes calldata`; the fixture holds messages in
    /// memory. Nonce sits at offset 1 of the packed Hyperlane message.
    function _nonce(bytes memory m) internal pure returns (uint32 value) {
        assembly {
            value := shr(224, mload(add(add(m, 32), 1)))
        }
    }

    function _buildMessage() internal view returns (bytes memory) {
        return
            ethereumMailbox.buildOutboundMessage(
                HYP_BASE,
                address(baseRecipient).addressToBytes32(),
                _body()
            );
    }

    function _dispatchFrom(
        AbstractWormholeHookIsm originRouter,
        uint256 value
    ) internal {
        ethereumMailbox.dispatch{value: value}(
            HYP_BASE,
            address(baseRecipient).addressToBytes32(),
            _body(),
            "",
            IPostDispatchHook(address(originRouter))
        );
    }

    function _deployVaaMesh()
        internal
        returns (WormholeVaaHookIsm origin, WormholeVaaHookIsm destination)
    {
        string[] memory urls = new string[](1);
        urls[0] = "https://vaa.example/getWormholeVaa";

        vm.selectFork(baseFork);
        destination = new WormholeVaaHookIsm(
            address(baseMailbox),
            CORE_BASE,
            _consistencyLevelConfig(),
            urls
        );

        vm.selectFork(ethereumFork);
        origin = new WormholeVaaHookIsm(
            address(ethereumMailbox),
            CORE_ETHEREUM,
            _consistencyLevelConfig(),
            urls
        );
        origin.enrollRemoteRouter(
            RemoteRouterEnrollment({
                domain: HYP_BASE,
                router: address(destination).addressToBytes32(),
                wormholeChainId: WH_BASE,
                expectedConsistencyLevel: CONSISTENCY_FINALIZED
            })
        );

        vm.selectFork(baseFork);
        destination.enrollRemoteRouter(
            RemoteRouterEnrollment({
                domain: HYP_ETHEREUM,
                router: address(origin).addressToBytes32(),
                wormholeChainId: WH_ETHEREUM,
                expectedConsistencyLevel: CONSISTENCY_FINALIZED
            })
        );
    }

    /// @dev Uses the published Quoter Router when the environment names one,
    /// otherwise a local mock. Core publication is real either way.
    function _quoterRouterFor(
        string memory chain
    ) internal returns (address router) {
        router = vm.envOr(
            string.concat("WORMHOLE_EXECUTOR_QUOTER_ROUTER_", chain),
            address(0)
        );
        if (router != address(0)) {
            assertGt(
                router.code.length,
                0,
                "configured Quoter Router has no code"
            );
            return router;
        }
        return address(new MockExecutorQuoterRouter(0.0005 ether));
    }

    function _quoterKey() internal returns (address) {
        return vm.envOr("WORMHOLE_EXECUTOR_QUOTER", makeAddr("quoter"));
    }

    /// @dev Pulls the publication this router just made out of the recorded logs.
    function _readPublication(
        address emitter
    )
        internal
        returns (
            uint64 sequence,
            uint32 nonce,
            bytes memory payload,
            uint8 consistencyLevel
        )
    {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 0) continue;
            if (logs[i].topics[0] != LOG_MESSAGE_PUBLISHED_TOPIC) continue;
            if (address(uint160(uint256(logs[i].topics[1]))) != emitter) {
                continue;
            }
            require(!found, "ambiguous publication in receipt");
            (sequence, nonce, payload, consistencyLevel) = abi.decode(
                logs[i].data,
                (uint64, uint32, bytes, uint8)
            );
            found = true;
        }
        require(found, "no publication found for emitter");
    }

    // ============ Guardian overrides ============

    function _signProductionVaa(
        address core,
        VaaFields memory fields
    ) internal returns (bytes memory) {
        (
            uint32 guardianSetIndex,
            uint256[] memory guardianKeys
        ) = _overrideProductionGuardianSet(core);
        return
            _signVaaWithGuardianKeys(
                fields,
                guardianSetIndex,
                guardianKeys,
                PRODUCTION_SIGNATURE_COUNT
            );
    }

    /// @dev Anyone may deliver; use an account unrelated to the quote.
    function _executeVaaWithinCallbackGas(
        WormholeExecutorHookIsm destinationRouter,
        bytes memory encodedVaa
    ) internal {
        address rescuer = makeAddr("rescuer");
        vm.deal(rescuer, 1 ether);
        uint256 callbackGasBefore = gasleft();
        vm.prank(rescuer);
        destinationRouter.executeVAAv1(encodedVaa);
        uint256 callbackGasUsed = callbackGasBefore - gasleft();
        assertLt(
            callbackGasUsed,
            CALLBACK_GAS,
            "callback exceeds the configured gas limit"
        );
    }

    /**
     * @dev Replaces the current Guardian set with the single deterministic test
     * key, then reads it back through Core's own getters. Core never applies an
     * expiry to the current set, so no expiry write is needed here.
     */
    function _overrideCurrentGuardianSet(
        address core
    ) internal returns (uint32 index) {
        index = ICoreBridgeGuardians(core).getCurrentGuardianSetIndex();
        _writeGuardianSet(core, index, guardian, 0);

        ICoreBridgeGuardians.GuardianSet memory set = ICoreBridgeGuardians(core)
            .getGuardianSet(index);
        assertEq(set.keys.length, 1, "Guardian set override did not apply");
        assertEq(set.keys[0], guardian, "Guardian key override did not apply");
    }

    /// @dev Mirrors the current production set size and quorum so callback-gas
    /// assertions include realistic signature verification costs.
    function _overrideProductionGuardianSet(
        address core
    ) internal returns (uint32 index, uint256[] memory keys) {
        index = ICoreBridgeGuardians(core).getCurrentGuardianSetIndex();
        keys = new uint256[](PRODUCTION_GUARDIAN_COUNT);
        address[] memory guardians = new address[](PRODUCTION_GUARDIAN_COUNT);
        for (uint256 i; i < PRODUCTION_GUARDIAN_COUNT; ++i) {
            keys[i] = uint256(keccak256(abi.encode("guardian", i))) + 1;
            guardians[i] = vm.addr(keys[i]);
        }
        _writeGuardianSet(core, index, guardians, 0);

        ICoreBridgeGuardians.GuardianSet memory set = ICoreBridgeGuardians(core)
            .getGuardianSet(index);
        assertEq(
            set.keys.length,
            PRODUCTION_GUARDIAN_COUNT,
            "production Guardian set override did not apply"
        );
        for (uint256 i; i < PRODUCTION_GUARDIAN_COUNT; ++i) {
            assertEq(set.keys[i], guardians[i], "Guardian key mismatch");
        }
    }

    /// @dev `expirationTime == 0` means "no expiry recorded".
    function _writeGuardianSet(
        address core,
        uint32 index,
        address key,
        uint32 expirationTime
    ) internal {
        address[] memory keys = new address[](1);
        keys[0] = key;
        _writeGuardianSet(core, index, keys, expirationTime);
    }

    function _writeGuardianSet(
        address core,
        uint32 index,
        address[] memory keys,
        uint32 expirationTime
    ) internal {
        bytes32 setSlot = keccak256(
            abi.encode(uint256(index), GUARDIAN_SETS_SLOT)
        );
        // GuardianSet { address[] keys; uint32 expirationTime; }
        vm.store(core, setSlot, bytes32(keys.length));
        bytes32 keysSlot = keccak256(abi.encode(setSlot));
        for (uint256 i; i < keys.length; ++i) {
            vm.store(
                core,
                bytes32(uint256(keysSlot) + i),
                bytes32(uint256(uint160(keys[i])))
            );
        }
        vm.store(
            core,
            bytes32(uint256(setSlot) + 1),
            bytes32(uint256(expirationTime))
        );

        ICoreBridgeGuardians.GuardianSet memory set = ICoreBridgeGuardians(core)
            .getGuardianSet(index);
        assertEq(set.keys.length, keys.length, "Guardian set write failed");
        for (uint256 i; i < keys.length; ++i) {
            assertEq(set.keys[i], keys[i], "Guardian key write failed");
        }
    }

    /**
     * @dev Builds a v1 VAA exactly as Guardians do: the body is signed through a
     * double keccak, and signatures precede the body in the encoding.
     */
    function _signVaa(
        VaaFields memory fields,
        uint32 guardianSetIndex
    ) internal view returns (bytes memory) {
        bytes memory body = abi.encodePacked(
            fields.timestamp,
            fields.nonce,
            fields.emitterChainId,
            fields.emitterAddress,
            fields.sequence,
            fields.consistencyLevel,
            fields.payload
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            guardianKey,
            keccak256(abi.encodePacked(keccak256(body)))
        );
        return
            abi.encodePacked(
                uint8(1), // VAA version
                guardianSetIndex,
                uint8(1), // signature count
                uint8(0), // Guardian index
                r,
                s,
                uint8(v - 27),
                body
            );
    }

    function _signVaaWithGuardianKeys(
        VaaFields memory fields,
        uint32 guardianSetIndex,
        uint256[] memory keys,
        uint8 signatureCount
    ) internal view returns (bytes memory) {
        assertLe(signatureCount, keys.length, "insufficient Guardian keys");
        bytes memory body = abi.encodePacked(
            fields.timestamp,
            fields.nonce,
            fields.emitterChainId,
            fields.emitterAddress,
            fields.sequence,
            fields.consistencyLevel,
            fields.payload
        );
        bytes32 digest = keccak256(abi.encodePacked(keccak256(body)));
        bytes memory signatures;
        for (uint8 i; i < signatureCount; ++i) {
            (uint8 v, bytes32 r, bytes32 s) = vm.sign(keys[i], digest);
            signatures = bytes.concat(
                signatures,
                abi.encodePacked(i, r, s, uint8(v - 27))
            );
        }
        return
            bytes.concat(
                abi.encodePacked(uint8(1), guardianSetIndex, signatureCount),
                signatures,
                body
            );
    }

    receive() external payable {}
}
