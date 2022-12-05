// SPDX-License-Identifier: UNLICENSED
pragma solidity >=0.6.0;

import "forge-std/Script.sol";
import {ICREATE3Factory} from "../lib/create3-factory/src/ICREATE3Factory.sol";

import {Mailbox} from "../contracts/Mailbox.sol";
import {TypeCasts} from "../contracts/libs/TypeCasts.sol";

contract Deploy is Script {
    function getCreate3Factory(string memory network)
        public
        view
        returns (ICREATE3Factory)
    {
        string memory file = string.concat(
            "lib/create3-factory/deployments/",
            network,
            ".json"
        );
        string memory json = vm.readFile(file);
        return
            ICREATE3Factory(
                abi.decode(vm.parseJson(json, "CREATE3Factory"), (address))
            );
    }

    function getDomainId(string memory network) public view returns (uint32) {
        string memory json = vm.readFile("chains.json");
        return
            abi.decode(
                vm.parseJson(json, string.concat(network, ".id")),
                (uint32)
            );
    }

    function run() public {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        vm.startBroadcast(deployerPrivateKey);

        string memory network = vm.envString("NETWORK");
        // string memory salt = vm.envString("SALT");
        bytes32 salt = keccak256("SALT");

        uint32 domain = getDomainId(network);
        ICREATE3Factory factory = getCreate3Factory(network);
        factory.deploy(
            salt,
            abi.encodePacked(type(Mailbox).creationCode, abi.encode(domain))
        );
    }
}
