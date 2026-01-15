// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.13;

import {Test} from "forge-std/Test.sol";

import {InterchainGasPaymaster} from "../../contracts/hooks/igp/InterchainGasPaymaster.sol";
import {StorageGasOracle} from "../../contracts/hooks/igp/StorageGasOracle.sol";
import {DomainRoutingHook} from "../../contracts/hooks/routing/DomainRoutingHook.sol";
import {RoutingFee} from "../../contracts/token/fees/RoutingFee.sol";
import {TestPostDispatchHook} from "../../contracts/test/TestPostDispatchHook.sol";
import {TestMailbox} from "../../contracts/test/TestMailbox.sol";
import {ERC20Test} from "../../contracts/test/ERC20Test.sol";
import {IGasOracle} from "../../contracts/interfaces/IGasOracle.sol";

contract EnumerableDomainSetTest is Test {
    InterchainGasPaymaster igp;
    StorageGasOracle oracle;
    DomainRoutingHook routingHook;
    RoutingFee routingFee;

    TestMailbox mailbox;
    TestPostDispatchHook noopHook;
    ERC20Test token;

    address constant OWNER = address(0x123);

    function setUp() public {
        // Setup IGP
        igp = new InterchainGasPaymaster();
        igp.initialize(OWNER, OWNER);
        oracle = new StorageGasOracle();

        // Setup DomainRoutingHook
        mailbox = new TestMailbox(0);
        routingHook = new DomainRoutingHook(address(mailbox), OWNER);
        noopHook = new TestPostDispatchHook();

        // Setup RoutingFee
        token = new ERC20Test("Test", "TST", 0, 18);
        routingFee = new RoutingFee(address(token), OWNER);
    }

    // ============ InterchainGasPaymaster Tests ============

    function test_IGP_domains_empty() public {
        uint32[] memory domains = igp.domains();
        assertEq(domains.length, 0);
    }

    function test_IGP_domains_afterSetConfig() public {
        uint32 domain1 = 1;
        uint32 domain2 = 2;
        uint32 domain3 = 3;

        InterchainGasPaymaster.GasParam[]
            memory params = new InterchainGasPaymaster.GasParam[](3);
        params[0] = InterchainGasPaymaster.GasParam(
            domain1,
            InterchainGasPaymaster.DomainGasConfig(oracle, 100)
        );
        params[1] = InterchainGasPaymaster.GasParam(
            domain2,
            InterchainGasPaymaster.DomainGasConfig(oracle, 200)
        );
        params[2] = InterchainGasPaymaster.GasParam(
            domain3,
            InterchainGasPaymaster.DomainGasConfig(oracle, 300)
        );

        vm.prank(OWNER);
        igp.setDestinationGasConfigs(params);

        uint32[] memory domains = igp.domains();
        assertEq(domains.length, 3);

        // Check all domains are present (order may vary)
        bool found1;
        bool found2;
        bool found3;
        for (uint256 i = 0; i < domains.length; i++) {
            if (domains[i] == domain1) found1 = true;
            if (domains[i] == domain2) found2 = true;
            if (domains[i] == domain3) found3 = true;
        }
        assertTrue(found1 && found2 && found3);
    }

    function test_IGP_domains_idempotent() public {
        uint32 domain1 = 1;

        InterchainGasPaymaster.GasParam[]
            memory params = new InterchainGasPaymaster.GasParam[](1);
        params[0] = InterchainGasPaymaster.GasParam(
            domain1,
            InterchainGasPaymaster.DomainGasConfig(oracle, 100)
        );

        // Set same domain twice
        vm.startPrank(OWNER);
        igp.setDestinationGasConfigs(params);
        igp.setDestinationGasConfigs(params);
        vm.stopPrank();

        uint32[] memory domains = igp.domains();
        assertEq(domains.length, 1);
        assertEq(domains[0], domain1);
    }

    // ============ StorageGasOracle Tests ============

    function test_StorageGasOracle_domains_empty() public {
        uint32[] memory domains = oracle.domains();
        assertEq(domains.length, 0);
    }

    function test_StorageGasOracle_domains_afterSetConfig() public {
        uint32 domain1 = 10;
        uint32 domain2 = 20;

        StorageGasOracle.RemoteGasDataConfig[]
            memory configs = new StorageGasOracle.RemoteGasDataConfig[](2);
        configs[0] = StorageGasOracle.RemoteGasDataConfig(domain1, 1e10, 100);
        configs[1] = StorageGasOracle.RemoteGasDataConfig(domain2, 2e10, 200);

        oracle.setRemoteGasDataConfigs(configs);

        uint32[] memory domains = oracle.domains();
        assertEq(domains.length, 2);

        bool found1;
        bool found2;
        for (uint256 i = 0; i < domains.length; i++) {
            if (domains[i] == domain1) found1 = true;
            if (domains[i] == domain2) found2 = true;
        }
        assertTrue(found1 && found2);
    }

    function test_StorageGasOracle_domains_idempotent() public {
        uint32 domain1 = 10;

        oracle.setRemoteGasData(
            StorageGasOracle.RemoteGasDataConfig(domain1, 1e10, 100)
        );
        oracle.setRemoteGasData(
            StorageGasOracle.RemoteGasDataConfig(domain1, 2e10, 200)
        );

        uint32[] memory domains = oracle.domains();
        assertEq(domains.length, 1);
        assertEq(domains[0], domain1);
    }

    // ============ DomainRoutingHook Tests ============

    function test_DomainRoutingHook_domains_empty() public {
        uint32[] memory domains = routingHook.domains();
        assertEq(domains.length, 0);
    }

    function test_DomainRoutingHook_domains_afterSetHook() public {
        uint32 domain1 = 100;
        uint32 domain2 = 200;

        vm.startPrank(OWNER);
        routingHook.setHook(domain1, address(noopHook));
        routingHook.setHook(domain2, address(noopHook));
        vm.stopPrank();

        uint32[] memory domains = routingHook.domains();
        assertEq(domains.length, 2);

        bool found1;
        bool found2;
        for (uint256 i = 0; i < domains.length; i++) {
            if (domains[i] == domain1) found1 = true;
            if (domains[i] == domain2) found2 = true;
        }
        assertTrue(found1 && found2);
    }

    function test_DomainRoutingHook_domains_batchSet() public {
        uint32 domain1 = 100;
        uint32 domain2 = 200;
        uint32 domain3 = 300;

        DomainRoutingHook.HookConfig[]
            memory configs = new DomainRoutingHook.HookConfig[](3);
        configs[0] = DomainRoutingHook.HookConfig(domain1, address(noopHook));
        configs[1] = DomainRoutingHook.HookConfig(domain2, address(noopHook));
        configs[2] = DomainRoutingHook.HookConfig(domain3, address(noopHook));

        vm.prank(OWNER);
        routingHook.setHooks(configs);

        uint32[] memory domains = routingHook.domains();
        assertEq(domains.length, 3);
    }

    function test_DomainRoutingHook_domains_idempotent() public {
        uint32 domain1 = 100;

        vm.startPrank(OWNER);
        routingHook.setHook(domain1, address(noopHook));
        routingHook.setHook(domain1, address(noopHook));
        vm.stopPrank();

        uint32[] memory domains = routingHook.domains();
        assertEq(domains.length, 1);
        assertEq(domains[0], domain1);
    }

    // ============ RoutingFee Tests ============

    function test_RoutingFee_domains_empty() public {
        uint32[] memory domains = routingFee.domains();
        assertEq(domains.length, 0);
    }

    function test_RoutingFee_domains_afterSetFeeContract() public {
        uint32 domain1 = 1000;
        uint32 domain2 = 2000;

        vm.startPrank(OWNER);
        routingFee.setFeeContract(domain1, address(0x1));
        routingFee.setFeeContract(domain2, address(0x2));
        vm.stopPrank();

        uint32[] memory domains = routingFee.domains();
        assertEq(domains.length, 2);

        bool found1;
        bool found2;
        for (uint256 i = 0; i < domains.length; i++) {
            if (domains[i] == domain1) found1 = true;
            if (domains[i] == domain2) found2 = true;
        }
        assertTrue(found1 && found2);
    }

    function test_RoutingFee_domains_idempotent() public {
        uint32 domain1 = 1000;

        vm.startPrank(OWNER);
        routingFee.setFeeContract(domain1, address(0x1));
        routingFee.setFeeContract(domain1, address(0x2));
        vm.stopPrank();

        uint32[] memory domains = routingFee.domains();
        assertEq(domains.length, 1);
        assertEq(domains[0], domain1);
    }

    // ============ Fuzz Tests ============

    function testFuzz_IGP_domains(uint32[] memory domainIds) public {
        vm.assume(domainIds.length <= 50); // Reasonable limit

        InterchainGasPaymaster.GasParam[]
            memory params = new InterchainGasPaymaster.GasParam[](
                domainIds.length
            );
        for (uint256 i = 0; i < domainIds.length; i++) {
            params[i] = InterchainGasPaymaster.GasParam(
                domainIds[i],
                InterchainGasPaymaster.DomainGasConfig(oracle, uint96(i + 1))
            );
        }

        vm.prank(OWNER);
        igp.setDestinationGasConfigs(params);

        uint32[] memory domains = igp.domains();

        // Count unique domains in input
        uint256 uniqueCount = 0;
        for (uint256 i = 0; i < domainIds.length; i++) {
            bool isDuplicate = false;
            for (uint256 j = 0; j < i; j++) {
                if (domainIds[j] == domainIds[i]) {
                    isDuplicate = true;
                    break;
                }
            }
            if (!isDuplicate) uniqueCount++;
        }

        assertEq(domains.length, uniqueCount);
    }
}
