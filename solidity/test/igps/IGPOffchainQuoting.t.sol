// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

import {InterchainGasPaymaster} from "../../contracts/hooks/igp/InterchainGasPaymaster.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {AbstractOffchainQuoter} from "../../contracts/libs/AbstractOffchainQuoter.sol";
import {SignedQuote} from "../../contracts/interfaces/IOffchainQuoter.sol";
import {IGPQuoteContext, IGPQuoteData, OffchainQuotedIGP} from "../../contracts/hooks/igp/OffchainQuotedIGP.sol";
import {StorageGasOracle} from "../../contracts/hooks/igp/StorageGasOracle.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";

contract IGPOffchainQuotingTest is Test {
    using TypeCasts for address;
    using MessageUtils for bytes;

    InterchainGasPaymaster igp;
    TestMailbox testMailbox;
    StorageGasOracle oracle;

    uint256 signerPk = 0xA11CE;
    address signer;

    address constant BENEFICIARY = address(0x444);
    uint32 constant DEST = 11111;
    uint32 constant ORIGIN = 22222;
    uint256 constant GAS_LIMIT = 300_000;
    uint96 constant GAS_OVERHEAD = 123_000;

    uint128 constant EXCHANGE_RATE = 2e10; // 2.0
    uint128 constant GAS_PRICE = 150;

    function setUp() public {
        signer = vm.addr(signerPk);

        testMailbox = new TestMailbox(1);
        igp = new InterchainGasPaymaster(address(testMailbox));
        igp.initialize(address(this), BENEFICIARY);

        oracle = new StorageGasOracle();
        _setGasConfig(DEST, oracle, GAS_OVERHEAD);
        _setOracleData(DEST, 1e10, 100); // 1.0 exchange, 100 wei gas price

        igp.addQuoteSigner(signer);
    }

    // ============ Helpers ============

    function _domainSeparator() internal view returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    keccak256(
                        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                    ),
                    keccak256("OffchainQuoter"),
                    keccak256("1"),
                    block.chainid,
                    address(igp)
                )
            );
    }

    function _signQuote(
        SignedQuote memory sq
    ) internal view returns (bytes memory) {
        bytes32 structHash = keccak256(
            abi.encode(
                igp.SIGNED_QUOTE_TYPEHASH(),
                keccak256(sq.context),
                keccak256(sq.data),
                sq.issuedAt,
                sq.expiry,
                sq.salt,
                sq.submitter
            )
        );
        bytes32 digest = ECDSA.toTypedDataHash(_domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _encodeGasData(
        uint128 rate,
        uint128 gasPrice
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(rate, gasPrice);
    }

    function _igpContext(
        address feeToken,
        uint32 dest,
        address sender_
    ) internal pure returns (bytes memory) {
        return abi.encodePacked(feeToken, dest, sender_);
    }

    function _submitTransient(
        address feeToken,
        uint32 dest,
        address sender_,
        uint128 rate,
        uint128 gasPrice
    ) internal {
        uint48 now_ = uint48(block.timestamp);
        SignedQuote memory sq = SignedQuote({
            context: _igpContext(feeToken, dest, sender_),
            data: _encodeGasData(rate, gasPrice),
            issuedAt: now_,
            expiry: now_, // transient
            salt: bytes32(0),
            submitter: address(0)
        });
        igp.submitQuote(sq, _signQuote(sq));
    }

    function _submitStanding(
        address feeToken,
        uint32 dest,
        address sender_,
        uint128 rate,
        uint128 gasPrice,
        uint48 issuedAt,
        uint48 expiry
    ) internal {
        SignedQuote memory sq = SignedQuote({
            context: abi.encodePacked(feeToken, dest, sender_),
            data: _encodeGasData(rate, gasPrice),
            issuedAt: issuedAt,
            expiry: expiry,
            salt: bytes32(0),
            submitter: address(0)
        });
        igp.submitQuote(sq, _signQuote(sq));
    }

    function _setGasConfig(
        uint32 domain,
        IGasOracle gasOracle,
        uint96 overhead
    ) internal {
        InterchainGasPaymaster.GasParam[]
            memory params = new InterchainGasPaymaster.GasParam[](1);
        params[0] = InterchainGasPaymaster.GasParam(
            domain,
            InterchainGasPaymaster.DomainGasConfig(gasOracle, overhead)
        );
        igp.setDestinationGasConfigs(params);
    }

    function _setOracleData(
        uint32 domain,
        uint128 rate,
        uint128 gasPrice
    ) internal {
        oracle.setRemoteGasData(
            StorageGasOracle.RemoteGasDataConfig({
                remoteDomain: domain,
                tokenExchangeRate: rate,
                gasPrice: gasPrice
            })
        );
    }

    // ============ Transient Quotes ============

    function test_transientQuote_overridesOracle() public {
        // Oracle: rate=1e10, gasPrice=100 → fee = 300000 * 100 * 1e10 / 1e10 = 30000000
        uint256 oracleFee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(oracleFee, 30_000_000);

        // Submit transient with different rate/price
        _submitTransient(
            address(0),
            DEST,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE
        );

        // Offchain: rate=2e10, gasPrice=150 → fee = 300000 * 150 * 2e10 / 1e10 = 90000000
        uint256 offchainFee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(offchainFee, 90_000_000);
    }

    function test_transientQuote_contextMismatch_fallsToOracle() public {
        // Submit transient for DEST
        _submitTransient(
            address(0),
            DEST,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE
        );

        // Query for different destination — falls through to oracle
        uint32 otherDest = DEST + 1;
        _setGasConfig(otherDest, oracle, GAS_OVERHEAD);
        _setOracleData(otherDest, 1e10, 100);

        uint256 fee = igp.quoteGasPayment(otherDest, GAS_LIMIT);
        assertEq(fee, 30_000_000); // oracle price, not offchain
    }

    function test_transientQuote_senderMismatch_fallsToOracle() public {
        // Submit transient for address(this)
        _submitTransient(
            address(0),
            DEST,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE
        );

        // Query from different sender
        vm.prank(address(0xBEEF));
        uint256 fee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(fee, 30_000_000); // oracle price
    }

    function test_transientQuote_feeTokenMismatch_fallsToOracle() public {
        // Submit transient for native (address(0))
        _submitTransient(
            address(0),
            DEST,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE
        );

        // Query with ERC20 fee token — context hash won't match
        // Need to set up a token oracle first
        address tokenAddr = address(0xFEE);
        StorageGasOracle tokenOracle = new StorageGasOracle();
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory configs = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        configs[0] = InterchainGasPaymaster.TokenGasOracleConfig(
            tokenAddr,
            DEST,
            tokenOracle
        );
        igp.setTokenGasOracles(configs);
        tokenOracle.setRemoteGasData(
            StorageGasOracle.RemoteGasDataConfig({
                remoteDomain: DEST,
                tokenExchangeRate: 1e10,
                gasPrice: 100
            })
        );

        uint256 fee = igp.quoteGasPayment(tokenAddr, DEST, GAS_LIMIT);
        assertEq(fee, 30_000_000); // token oracle price, not offchain
    }

    function test_transientQuote_persistsAfterPostDispatch() public {
        _submitTransient(
            address(0),
            DEST,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE
        );

        // Verify transient is active
        uint256 offchainFee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(offchainFee, 90_000_000);

        bytes memory message = MessageUtils.formatMessage(
            0,
            0,
            ORIGIN,
            address(this).addressToBytes32(),
            DEST,
            address(0x1).addressToBytes32(),
            "hello"
        );
        bytes memory metadata = StandardHookMetadata.overrideGasLimit(
            GAS_LIMIT
        );

        uint256 quote = igp.quoteDispatch(metadata, message);
        vm.deal(address(this), quote);
        testMailbox.updateLatestDispatchedId(message.id());
        igp.postDispatch{value: quote}(metadata, message);

        // Transient persists after postDispatch
        uint256 feeAfter = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(feeAfter, 90_000_000);
    }

    // ============ Standing Quotes ============

    function test_standingQuote_specificMatch() public {
        uint48 now_ = uint48(block.timestamp);
        _submitStanding(
            address(0),
            DEST,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE,
            now_,
            now_ + 3600
        );

        uint256 fee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(fee, 90_000_000);
    }

    function test_standingQuote_wildcardSender() public {
        uint48 now_ = uint48(block.timestamp);
        address wildcard = address(type(uint160).max);
        _submitStanding(
            address(0),
            DEST,
            wildcard,
            EXCHANGE_RATE,
            GAS_PRICE,
            now_,
            now_ + 3600
        );

        uint256 fee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(fee, 90_000_000);
    }

    function test_standingQuote_wildcardDest() public {
        uint48 now_ = uint48(block.timestamp);
        uint32 wildcardDest = type(uint32).max;
        _submitStanding(
            address(0),
            wildcardDest,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE,
            now_,
            now_ + 3600
        );

        uint256 fee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(fee, 90_000_000);
    }

    function test_standingQuote_expired_fallsToOracle() public {
        uint48 now_ = uint48(block.timestamp);
        _submitStanding(
            address(0),
            DEST,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE,
            now_,
            now_ + 1
        );

        vm.warp(now_ + 2);

        uint256 fee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(fee, 30_000_000); // oracle
    }

    function test_standingQuote_staleRejected() public {
        uint48 now_ = uint48(block.timestamp);
        _submitStanding(
            address(0),
            DEST,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE,
            now_,
            now_ + 3600
        );

        // Older issuedAt should revert
        SignedQuote memory sq = SignedQuote({
            context: abi.encodePacked(address(0), DEST, address(this)),
            data: _encodeGasData(3e10, 200),
            issuedAt: now_ - 1,
            expiry: now_ + 7200,
            salt: bytes32(0),
            submitter: address(0)
        });
        bytes memory sig = _signQuote(sq);
        vm.expectRevert(AbstractOffchainQuoter.StaleQuote.selector);
        igp.submitQuote(sq, sig);
    }

    // ============ Priority ============

    function test_transientOverStanding() public {
        uint48 now_ = uint48(block.timestamp);
        uint128 standingRate = 1e10;
        uint128 transientRate = 5e10;

        _submitStanding(
            address(0),
            DEST,
            address(this),
            standingRate,
            GAS_PRICE,
            now_,
            now_ + 3600
        );
        _submitTransient(
            address(0),
            DEST,
            address(this),
            transientRate,
            GAS_PRICE
        );

        // transientRate=5e10 → 300000 * 150 * 5e10 / 1e10 = 225000000
        uint256 fee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(fee, 225_000_000);
    }

    function test_specificOverWildcard() public {
        uint48 now_ = uint48(block.timestamp);
        uint128 wildcardRate = 1e10;
        uint128 specificRate = 3e10;

        address wildcard = address(type(uint160).max);
        _submitStanding(
            address(0),
            DEST,
            wildcard,
            wildcardRate,
            GAS_PRICE,
            now_,
            now_ + 3600
        );
        _submitStanding(
            address(0),
            DEST,
            address(this),
            specificRate,
            GAS_PRICE,
            now_,
            now_ + 3600
        );

        // specificRate=3e10 → 300000 * 150 * 3e10 / 1e10 = 135000000
        uint256 fee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(fee, 135_000_000);
    }

    // ============ Signature ============

    function test_invalidSigner_reverts() public {
        uint256 wrongPk = 0xBAD;
        uint48 now_ = uint48(block.timestamp);

        SignedQuote memory sq = SignedQuote({
            context: abi.encodePacked(address(0), DEST, address(this)),
            data: _encodeGasData(EXCHANGE_RATE, GAS_PRICE),
            issuedAt: now_,
            expiry: now_,
            salt: bytes32(0),
            submitter: address(0)
        });

        bytes32 structHash = keccak256(
            abi.encode(
                igp.SIGNED_QUOTE_TYPEHASH(),
                keccak256(sq.context),
                keccak256(sq.data),
                sq.issuedAt,
                sq.expiry,
                sq.salt,
                sq.submitter
            )
        );
        bytes32 digest = ECDSA.toTypedDataHash(_domainSeparator(), structHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(wrongPk, digest);

        vm.expectRevert(AbstractOffchainQuoter.InvalidSigner.selector);
        igp.submitQuote(sq, abi.encodePacked(r, s, v));
    }

    function test_addQuoteSigner_onlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("Ownable: caller is not the owner");
        igp.addQuoteSigner(address(0x123));
    }

    function test_addQuoteSigner_emitsEvent() public {
        address newSigner = address(0x456);
        vm.expectEmit(false, false, false, true, address(igp));
        emit AbstractOffchainQuoter.QuoteSignerAdded(newSigner);
        igp.addQuoteSigner(newSigner);
        assertTrue(igp.isQuoteSigner(newSigner));
    }

    function test_addQuoteSigner_idempotent() public {
        // Adding signer that already exists (from setUp) should not revert
        igp.addQuoteSigner(signer);
        assertTrue(igp.isQuoteSigner(signer));
    }

    function test_removeQuoteSigner() public {
        assertTrue(igp.isQuoteSigner(signer));

        vm.expectEmit(false, false, false, true, address(igp));
        emit AbstractOffchainQuoter.QuoteSignerRemoved(signer);
        igp.removeQuoteSigner(signer);

        assertFalse(igp.isQuoteSigner(signer));
    }

    function test_removeQuoteSigner_onlyOwner() public {
        vm.prank(address(0xBEEF));
        vm.expectRevert("Ownable: caller is not the owner");
        igp.removeQuoteSigner(signer);
    }

    function test_removeQuoteSigner_nonExistent() public {
        // Removing non-existent signer should not revert
        igp.removeQuoteSigner(address(0xDEAD));
    }

    function test_removeQuoteSigner_invalidatesSignatures() public {
        igp.removeQuoteSigner(signer);

        uint48 now_ = uint48(block.timestamp);
        SignedQuote memory sq = SignedQuote({
            context: _igpContext(address(0), DEST, address(this)),
            data: _encodeGasData(EXCHANGE_RATE, GAS_PRICE),
            issuedAt: now_,
            expiry: now_ + 3600,
            salt: bytes32(0),
            submitter: address(this)
        });
        bytes memory sig = _signQuote(sq);

        vm.expectRevert(AbstractOffchainQuoter.InvalidSigner.selector);
        igp.submitQuote(sq, sig);
    }

    // ============ offchainQuotes view ============

    function test_offchainQuotes_returnsStoredQuote() public {
        uint48 now_ = uint48(block.timestamp);
        uint48 expiry = now_ + 3600;
        _submitStanding(
            address(0),
            DEST,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE,
            now_,
            expiry
        );

        OffchainQuotedIGP.StoredGasQuote memory sq = igp.offchainQuotes(
            address(0),
            DEST,
            address(this)
        );
        assertEq(sq.tokenExchangeRate, EXCHANGE_RATE);
        assertEq(sq.gasPrice, GAS_PRICE);
        assertEq(sq.issuedAt, now_);
        assertEq(sq.expiry, expiry);
    }

    function test_offchainQuotes_returnsEmptyForUnset() public view {
        OffchainQuotedIGP.StoredGasQuote memory sq = igp.offchainQuotes(
            address(0),
            99999,
            address(0xDEAD)
        );
        assertEq(sq.tokenExchangeRate, 0);
        assertEq(sq.gasPrice, 0);
        assertEq(sq.issuedAt, 0);
        assertEq(sq.expiry, 0);
    }

    function test_offchainQuotes_updatedByNewerQuote() public {
        uint48 now_ = uint48(block.timestamp);
        _submitStanding(
            address(0),
            DEST,
            address(this),
            EXCHANGE_RATE,
            GAS_PRICE,
            now_,
            now_ + 3600
        );

        uint128 newRate = 3e10;
        uint128 newPrice = 200;
        _submitStanding(
            address(0),
            DEST,
            address(this),
            newRate,
            newPrice,
            now_ + 1,
            now_ + 7200
        );

        OffchainQuotedIGP.StoredGasQuote memory sq = igp.offchainQuotes(
            address(0),
            DEST,
            address(this)
        );
        assertEq(sq.tokenExchangeRate, newRate);
        assertEq(sq.gasPrice, newPrice);
        assertEq(sq.issuedAt, now_ + 1);
        assertEq(sq.expiry, now_ + 7200);
    }

    // ============ Zero Fee ============

    function test_transientQuote_zeroFee() public {
        _submitTransient(address(0), DEST, address(this), 0, 0);

        uint256 fee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(fee, 0);
    }

    function test_standingQuote_zeroFee() public {
        uint48 now_ = uint48(block.timestamp);
        _submitStanding(
            address(0),
            DEST,
            address(this),
            0,
            0,
            now_,
            now_ + 3600
        );

        uint256 fee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(fee, 0);
    }

    // ============ Fee math ============

    function test_computeGasFee(
        uint64 rate,
        uint64 gasPrice,
        uint64 gasLimit
    ) public {
        // Ensure fee is non-zero so standing quote doesn't fall through
        vm.assume(rate > 0 && gasPrice > 0 && gasLimit > 0);
        vm.assume(
            uint256(gasLimit) * uint256(gasPrice) * uint256(rate) >= 1e10
        );

        uint48 now_ = uint48(block.timestamp);
        _submitStanding(
            address(0),
            DEST,
            address(this),
            uint128(rate),
            uint128(gasPrice),
            now_,
            now_ + 3600
        );

        uint256 fee = igp.quoteGasPayment(DEST, gasLimit);
        uint256 expected = (uint256(gasLimit) *
            uint256(gasPrice) *
            uint256(rate)) / 1e10;
        assertEq(fee, expected);
    }

    // ============ ERC20 Fee Token Quotes ============

    address constant FEE_TOKEN = address(0xFEE);
    uint128 constant TOKEN_RATE = 5e10; // 5.0 — different from native

    function _setupTokenOracle() internal {
        InterchainGasPaymaster.TokenGasOracleConfig[]
            memory configs = new InterchainGasPaymaster.TokenGasOracleConfig[](
                1
            );
        configs[0] = InterchainGasPaymaster.TokenGasOracleConfig({
            feeToken: FEE_TOKEN,
            remoteDomain: DEST,
            gasOracle: oracle
        });
        igp.setTokenGasOracles(configs);
    }

    function test_erc20_transientQuote() public {
        _setupTokenOracle();

        _submitTransient(FEE_TOKEN, DEST, address(this), TOKEN_RATE, GAS_PRICE);

        // TOKEN_RATE=5e10, GAS_PRICE=150 → 300000 * 150 * 5e10 / 1e10 = 225000000
        uint256 fee = igp.quoteGasPayment(FEE_TOKEN, DEST, GAS_LIMIT);
        assertEq(fee, 225_000_000);
    }

    function test_erc20_standingQuote_specificMatch() public {
        _setupTokenOracle();
        uint48 now_ = uint48(block.timestamp);

        _submitStanding(
            FEE_TOKEN,
            DEST,
            address(this),
            TOKEN_RATE,
            GAS_PRICE,
            now_,
            now_ + 3600
        );

        uint256 fee = igp.quoteGasPayment(FEE_TOKEN, DEST, GAS_LIMIT);
        assertEq(fee, 225_000_000);
    }

    function test_erc20_standingQuote_wildcardSender() public {
        _setupTokenOracle();
        uint48 now_ = uint48(block.timestamp);
        address wildcard = address(type(uint160).max);

        _submitStanding(
            FEE_TOKEN,
            DEST,
            wildcard,
            TOKEN_RATE,
            GAS_PRICE,
            now_,
            now_ + 3600
        );

        uint256 fee = igp.quoteGasPayment(FEE_TOKEN, DEST, GAS_LIMIT);
        assertEq(fee, 225_000_000);
    }

    function test_erc20_standingQuote_wildcardDest() public {
        _setupTokenOracle();
        uint48 now_ = uint48(block.timestamp);
        uint32 wildcardDest = type(uint32).max;

        _submitStanding(
            FEE_TOKEN,
            wildcardDest,
            address(this),
            TOKEN_RATE,
            GAS_PRICE,
            now_,
            now_ + 3600
        );

        uint256 fee = igp.quoteGasPayment(FEE_TOKEN, DEST, GAS_LIMIT);
        assertEq(fee, 225_000_000);
    }

    function test_erc20_standingQuote_isolatedFromNative() public {
        _setupTokenOracle();
        uint48 now_ = uint48(block.timestamp);

        // Standing quote for FEE_TOKEN only
        _submitStanding(
            FEE_TOKEN,
            DEST,
            address(this),
            TOKEN_RATE,
            GAS_PRICE,
            now_,
            now_ + 3600
        );

        // FEE_TOKEN resolves offchain quote
        uint256 tokenFee = igp.quoteGasPayment(FEE_TOKEN, DEST, GAS_LIMIT);
        assertEq(tokenFee, 225_000_000);

        // Native falls through to oracle (no native standing quote)
        uint256 nativeFee = igp.quoteGasPayment(DEST, GAS_LIMIT);
        assertEq(nativeFee, 30_000_000); // oracle rate
    }

    receive() external payable {}
}

contract IGPQuoteCodecHarness {
    function encodeContext(
        address feeToken,
        uint32 destination,
        address sender
    ) external pure returns (bytes memory) {
        return IGPQuoteContext.encode(feeToken, destination, sender);
    }

    function decodeContext(
        bytes calldata ctx
    ) external pure returns (address, uint32, address) {
        return IGPQuoteContext.decode(ctx);
    }

    function encodeData(
        uint128 exchangeRate,
        uint128 gasPrice
    ) external pure returns (bytes memory) {
        return IGPQuoteData.encode(exchangeRate, gasPrice);
    }

    function decodeData(
        bytes calldata data
    ) external pure returns (uint128, uint128) {
        return IGPQuoteData.decode(data);
    }
}

contract IGPQuoteCodecTest is Test {
    IGPQuoteCodecHarness codec;

    function setUp() public {
        codec = new IGPQuoteCodecHarness();
    }

    // ============ IGPQuoteContext ============

    function test_contextRoundtrip(
        address feeToken,
        uint32 destination,
        address sender
    ) public view {
        bytes memory encoded = codec.encodeContext(
            feeToken,
            destination,
            sender
        );
        assertEq(encoded.length, 44);
        (address ft, uint32 dest, address s) = codec.decodeContext(encoded);
        assertEq(ft, feeToken);
        assertEq(dest, destination);
        assertEq(s, sender);
    }

    function test_contextEncode_layout() public view {
        address feeToken = address(0xAAAabbbbcccCDdDdEEeeFfff0000111122223333);
        uint32 destination = 42;
        address sender = address(0x1111222233334444555566667777888899990000);

        bytes memory encoded = codec.encodeContext(
            feeToken,
            destination,
            sender
        );
        assertEq(encoded.length, 44);
        // feeToken at [0:20]
        assertEq(address(bytes20(bytes32(encoded) << 0)), feeToken);
    }

    function test_contextDecode_wrongLength() public {
        bytes memory tooShort = new bytes(43);
        vm.expectRevert();
        codec.decodeContext(tooShort);

        bytes memory tooLong = new bytes(45);
        vm.expectRevert();
        codec.decodeContext(tooLong);
    }

    // ============ IGPQuoteData ============

    function test_dataRoundtrip(
        uint128 exchangeRate,
        uint128 gasPrice
    ) public view {
        bytes memory encoded = codec.encodeData(exchangeRate, gasPrice);
        assertEq(encoded.length, 32);
        (uint128 rate, uint128 price) = codec.decodeData(encoded);
        assertEq(rate, exchangeRate);
        assertEq(price, gasPrice);
    }

    function test_dataEncode_layout() public view {
        uint128 exchangeRate = 2e10;
        uint128 gasPrice = 150;

        bytes memory encoded = codec.encodeData(exchangeRate, gasPrice);
        assertEq(encoded.length, 32);
        // First 16 bytes = exchangeRate, last 16 bytes = gasPrice
        assertEq(uint128(bytes16(bytes32(encoded) << 0)), exchangeRate);
    }

    function test_dataDecode_wrongLength() public {
        bytes memory tooShort = new bytes(31);
        vm.expectRevert();
        codec.decodeData(tooShort);

        bytes memory tooLong = new bytes(33);
        vm.expectRevert();
        codec.decodeData(tooLong);
    }
}
