import { expect } from 'chai';

import {
  multiProtocolTestChainMetadata,
  test1,
  testCosmosChain,
} from '../../consts/testChains.js';
import { MultiProtocolProvider } from '../../providers/MultiProtocolProvider.js';
import { ProviderType } from '../../providers/ProviderType.js';

import { CosmWasmCoreAdapter } from './CosmWasmCoreAdapter.js';

const TX_RECEIPT = JSON.parse(
  `{"height":62609917,"transactionHash":"3106A2BECE7FC03EC6F7FD3BC1577B9456C8B481A017A3A51AD7E9D27D9240A7","events":[{"type":"coin_spent","attributes":[{"key":"spender","value":"inj16paaazy6t2ac02q5t8en099csy7pkyh3hw35up"},{"key":"amount","value":"948228000000000inj"}]},{"type":"coin_received","attributes":[{"key":"receiver","value":"inj17xpfvakm2amg962yls6f84z3kell8c5l6s5ye9"},{"key":"amount","value":"948228000000000inj"}]},{"type":"transfer","attributes":[{"key":"recipient","value":"inj17xpfvakm2amg962yls6f84z3kell8c5l6s5ye9"},{"key":"sender","value":"inj16paaazy6t2ac02q5t8en099csy7pkyh3hw35up"},{"key":"amount","value":"948228000000000inj"}]},{"type":"message","attributes":[{"key":"sender","value":"inj16paaazy6t2ac02q5t8en099csy7pkyh3hw35up"}]},{"type":"tx","attributes":[{"key":"fee","value":"948228000000000inj"},{"key":"fee_payer","value":"inj16paaazy6t2ac02q5t8en099csy7pkyh3hw35up"}]},{"type":"tx","attributes":[{"key":"acc_seq","value":"inj16paaazy6t2ac02q5t8en099csy7pkyh3hw35up/20"}]},{"type":"tx","attributes":[{"key":"signature","value":"9XC7pL/hEa4PvJQxyAKdLpucpA/t+lNKzqfeSgUYTw9Old05Lbfx95GkIaXnuTOspCvYIZIuLesJ5wQHdL1Ljw=="}]},{"type":"message","attributes":[{"key":"action","value":"/cosmwasm.wasm.v1.MsgExecuteContract"},{"key":"sender","value":"inj16paaazy6t2ac02q5t8en099csy7pkyh3hw35up"},{"key":"module","value":"wasm"}]},{"type":"coin_spent","attributes":[{"key":"spender","value":"inj16paaazy6t2ac02q5t8en099csy7pkyh3hw35up"},{"key":"amount","value":"31000000000000000inj"}]},{"type":"coin_received","attributes":[{"key":"receiver","value":"inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k"},{"key":"amount","value":"31000000000000000inj"}]},{"type":"transfer","attributes":[{"key":"recipient","value":"inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k"},{"key":"sender","value":"inj16paaazy6t2ac02q5t8en099csy7pkyh3hw35up"},{"key":"amount","value":"31000000000000000inj"}]},{"type":"execute","attributes":[{"key":"_contract_address","value":"inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k"}]},{"type":"wasm-hpl_warp_native::transfer-remote","attributes":[{"key":"_contract_address","value":"inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k"},{"key":"sender","value":"inj16paaazy6t2ac02q5t8en099csy7pkyh3hw35up"},{"key":"recipient","value":"0000000000000000000000009a2d8681ffcc45b0c18e72b16fba9b2270b911ed"},{"key":"token","value":"inj"},{"key":"amount","value":"1000000000000000"}]},{"type":"coin_spent","attributes":[{"key":"amount","value":"30000000000000000inj"},{"key":"spender","value":"inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k"}]},{"type":"coin_received","attributes":[{"key":"amount","value":"30000000000000000inj"},{"key":"receiver","value":"inj1palm2wtp6urg0c6j4f2ukv5u5ahdcrqek0sapt"}]},{"type":"transfer","attributes":[{"key":"amount","value":"30000000000000000inj"},{"key":"recipient","value":"inj1palm2wtp6urg0c6j4f2ukv5u5ahdcrqek0sapt"},{"key":"sender","value":"inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k"}]},{"type":"execute","attributes":[{"key":"_contract_address","value":"inj1palm2wtp6urg0c6j4f2ukv5u5ahdcrqek0sapt"}]},{"type":"wasm-mailbox_dispatch_id","attributes":[{"key":"_contract_address","value":"inj1palm2wtp6urg0c6j4f2ukv5u5ahdcrqek0sapt"},{"key":"message_id","value":"afc6cabcf735ac7b13fb4f1a045c4d675ecf8363cac76a21612411e644041af2"}]},{"type":"wasm-mailbox_dispatch","attributes":[{"key":"_contract_address","value":"inj1palm2wtp6urg0c6j4f2ukv5u5ahdcrqek0sapt"},{"key":"destination","value":"2525"},{"key":"message","value":"030000032e00696e6a000000000000000000000000db0ab932dd778c771c85636070d920ae90a66136000009dd00000000000000000000000026f32245fcf5ad53159e875d5cae62aecf19c2d40000000000000000000000009a2d8681ffcc45b0c18e72b16fba9b2270b911ed00000000000000000000000000000000000000000000000000038d7ea4c68000"},{"key":"recipient","value":"00000000000000000000000026f32245fcf5ad53159e875d5cae62aecf19c2d4"},{"key":"sender","value":"000000000000000000000000db0ab932dd778c771c85636070d920ae90a66136"}]},{"type":"execute","attributes":[{"key":"_contract_address","value":"inj1269dxcuyglc8mmecf95lf63elt3cq2tz57ka6h"}]},{"type":"wasm-hpl_hook_merkle::post_dispatch","attributes":[{"key":"_contract_address","value":"inj1269dxcuyglc8mmecf95lf63elt3cq2tz57ka6h"},{"key":"index","value":"814"},{"key":"message_id","value":"afc6cabcf735ac7b13fb4f1a045c4d675ecf8363cac76a21612411e644041af2"}]},{"type":"wasm-hpl_hook_merkle::inserted_into_tree","attributes":[{"key":"_contract_address","value":"inj1269dxcuyglc8mmecf95lf63elt3cq2tz57ka6h"},{"key":"index","value":"814"}]},{"type":"coin_spent","attributes":[{"key":"amount","value":"30000000000000000inj"},{"key":"spender","value":"inj1palm2wtp6urg0c6j4f2ukv5u5ahdcrqek0sapt"}]},{"type":"coin_received","attributes":[{"key":"amount","value":"30000000000000000inj"},{"key":"receiver","value":"inj1y7h9y2vwtdfmxjm6ur9x8czcghp3u86e2wtcxr"}]},{"type":"transfer","attributes":[{"key":"amount","value":"30000000000000000inj"},{"key":"recipient","value":"inj1y7h9y2vwtdfmxjm6ur9x8czcghp3u86e2wtcxr"},{"key":"sender","value":"inj1palm2wtp6urg0c6j4f2ukv5u5ahdcrqek0sapt"}]},{"type":"execute","attributes":[{"key":"_contract_address","value":"inj1y7h9y2vwtdfmxjm6ur9x8czcghp3u86e2wtcxr"}]},{"type":"wasm-igp-core-pay-for-gas","attributes":[{"key":"_contract_address","value":"inj1y7h9y2vwtdfmxjm6ur9x8czcghp3u86e2wtcxr"},{"key":"dest_domain","value":"2525"},{"key":"gas_amount","value":"250000"},{"key":"gas_refunded","value":"29999999999997500"},{"key":"gas_required","value":"2500"},{"key":"message_id","value":"afc6cabcf735ac7b13fb4f1a045c4d675ecf8363cac76a21612411e644041af2"},{"key":"payment","value":"30000000000000000"},{"key":"sender","value":"inj1palm2wtp6urg0c6j4f2ukv5u5ahdcrqek0sapt"}]},{"type":"wasm-igp-core-post-dispatch","attributes":[{"key":"_contract_address","value":"inj1y7h9y2vwtdfmxjm6ur9x8czcghp3u86e2wtcxr"},{"key":"message","value":"030000032e00696e6a000000000000000000000000db0ab932dd778c771c85636070d920ae90a66136000009dd00000000000000000000000026f32245fcf5ad53159e875d5cae62aecf19c2d40000000000000000000000009a2d8681ffcc45b0c18e72b16fba9b2270b911ed00000000000000000000000000000000000000000000000000038d7ea4c68000"},{"key":"metadata","value":"0x"}]},{"type":"coin_spent","attributes":[{"key":"amount","value":"29999999999997500inj"},{"key":"spender","value":"inj1y7h9y2vwtdfmxjm6ur9x8czcghp3u86e2wtcxr"}]},{"type":"coin_received","attributes":[{"key":"amount","value":"29999999999997500inj"},{"key":"receiver","value":"inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k"}]},{"type":"transfer","attributes":[{"key":"amount","value":"29999999999997500inj"},{"key":"recipient","value":"inj1mv9tjvkaw7x8w8y9vds8pkfq46g2vcfkjehc6k"},{"key":"sender","value":"inj1y7h9y2vwtdfmxjm6ur9x8czcghp3u86e2wtcxr"}]}],"gasWanted":948228,"gasUsed":695543}`,
);

describe('CosmWasmCoreAdapter', () => {
  let adapter: CosmWasmCoreAdapter;

  it('constructs', () => {
    adapter = new CosmWasmCoreAdapter(
      testCosmosChain.name,
      MultiProtocolProvider.createTestMultiProtocolProvider({
        ...multiProtocolTestChainMetadata,
        inevm: {
          ...test1,
          name: 'inevm',
          chainId: 2525,
          domainId: 2525,
        },
      }),
      { mailbox: '' },
    );
    expect(adapter).to.be.instanceOf(CosmWasmCoreAdapter);
  });

  it('extracts message IDs', () => {
    const messages = adapter.extractMessageIds({
      type: ProviderType.CosmJsWasm,
      hash: TX_RECEIPT.transactionHash,
      receipt: TX_RECEIPT,
    });
    expect(messages).to.have.length(1);
    expect(messages[0].messageId).to.equal(
      '0xafc6cabcf735ac7b13fb4f1a045c4d675ecf8363cac76a21612411e644041af2',
    );
    expect(messages[0].destination).to.equal('inevm');
  });
});
