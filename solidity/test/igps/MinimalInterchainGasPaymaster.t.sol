// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";
import {MinimalInterchainGasPaymaster, GasParam, DomainGasConfig, TokenGasOracleConfig} from "../../contracts/hooks/igp/MinimalInterchainGasPaymaster.sol";
import {StorageGasOracle} from "../../contracts/hooks/igp/StorageGasOracle.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {Message} from "../../contracts/libs/Message.sol";
import {StandardHookMetadata} from "../../contracts/hooks/libs/StandardHookMetadata.sol";
import {TypeCasts} from "../../contracts/libs/TypeCasts.sol";
import {MessageUtils} from "../isms/IsmTestUtils.sol";

/**
 * @notice Smoke tests for the slim paris-compatible IGP base contract.
 *         Exercises the externally-callable surface that legacy chains
 *         deploy: payForGas, quoteGasPayment, oracle resolution, and
 *         postDispatch. Lives under solidity/test/igps/ alongside the
 *         existing IGP suite.
 *
 *         The full IGP behavioral suite runs against the cancun-derived
 *         contract in InterchainGasPaymaster.t.sol; this file is the
 *         minimum coverage that exercises Minimal directly to lock in
 *         that the slim base remains deployable and functional.
 */
contract MinimalInterchainGasPaymasterTest is Test {
    using TypeCasts for address;
    using MessageUtils for bytes;
    using Message for bytes;
    using StandardHookMetadata for bytes;

    MinimalInterchainGasPaymaster igp;
    StorageGasOracle oracle;
    TestMailbox testMailbox;

    uint32 constant ORIGIN = 22222;
    uint32 constant DEST = 11111;
    uint96 constant GAS_OVERHEAD = 50_000;
    uint128 constant EXCHANGE_RATE = 1e10;
    uint128 constant GAS_PRICE = 100;
    address constant BENEFICIARY = address(0xBEEF);

    function setUp() public {
        testMailbox = new TestMailbox(ORIGIN);
        igp = new MinimalInterchainGasPaymaster();
        igp.initialize(address(this), BENEFICIARY);

        oracle = new StorageGasOracle();
        oracle.setRemoteGasData(
            StorageGasOracle.RemoteGasDataConfig({
                remoteDomain: DEST,
                tokenExchangeRate: EXCHANGE_RATE,
                gasPrice: GAS_PRICE
            })
        );

        GasParam[] memory params = new GasParam[](1);
        params[0] = GasParam(
            DEST,
            DomainGasConfig(IGasOracle(address(oracle)), GAS_OVERHEAD)
        );
        igp.setDestinationGasConfigs(params);
    }

    function test_initialize_setsBeneficiary() public {
        assertEq(igp.beneficiary(), BENEFICIARY);
    }

    function test_quoteGasPayment_resolvesToOracle() public {
        // fee = gasLimit * gasPrice * exchangeRate / 1e10 = 200_000 * 100 * 1e10 / 1e10
        uint256 quoted = igp.quoteGasPayment(DEST, 200_000);
        assertEq(quoted, 200_000 * uint256(GAS_PRICE));
    }

    function test_payForGas_acceptsExactNativePayment() public {
        uint256 gasLimit = 100_000;
        uint256 quoted = igp.quoteGasPayment(DEST, gasLimit);
        uint256 igpBalanceBefore = address(igp).balance;
        igp.payForGas{value: quoted}(
            bytes32(uint256(0xABCDEF)),
            DEST,
            gasLimit,
            address(this)
        );
        assertEq(address(igp).balance, igpBalanceBefore + quoted);
    }

    function test_postDispatch_appliesDestinationOverhead() public {
        // postDispatch wraps user-specified gasLimit with destinationGasOverhead;
        // verify by paying exactly the quoted value at dispatch time.
        bytes memory message = MessageUtils.formatMessage(
            uint8(0),
            uint32(0),
            ORIGIN,
            address(this).addressToBytes32(),
            DEST,
            address(this).addressToBytes32(),
            "minimal-igp-smoke"
        );
        uint256 userGas = 50_000;
        bytes memory metadata = StandardHookMetadata.formatMetadata(
            0,
            userGas,
            address(this),
            ""
        );
        uint256 quote = igp.quoteDispatch(metadata, message);
        // Quoted total covers user gas + destination overhead at oracle rates
        assertEq(
            quote,
            (uint256(userGas) + uint256(GAS_OVERHEAD)) * uint256(GAS_PRICE)
        );
        igp.postDispatch{value: quote}(metadata, message);
    }

    function test_setTokenGasOracles_writesNativeAndErc20Slots() public {
        TokenGasOracleConfig[] memory configs = new TokenGasOracleConfig[](1);
        configs[0] = TokenGasOracleConfig({
            feeToken: address(0xDEAD),
            remoteDomain: DEST,
            gasOracle: IGasOracle(address(oracle))
        });
        igp.setTokenGasOracles(configs);
        assertEq(
            address(igp.tokenGasOracles(address(0xDEAD), DEST)),
            address(oracle)
        );
    }
}
