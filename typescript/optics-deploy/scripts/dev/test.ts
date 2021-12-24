import {  CallforwarderRouter__factory } from '@optics-xyz/ts-interface/dist/optics-xapps';



const i = CallforwarderRouter__factory.createInterface()
console.log(i.encodeFunctionData("callRemote", [80001, [{ to: 
  // proxy
  "0x000000000000000000000000068269933F917DFD04D7C4cC2333eD228f710310", data: "0xa9059cbb00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001"}]]))
