module hp_library::merkle_tree {
  use std::vector;

  use hp_library::utils::{Self, hash_concat};
  //
  //  Constants
  //
  const TREE_DEPTH: u8 = 32;
  const MAX_LEAVES: u64 = 4_294_967_296;
  
  //
  //  Errors
  //
  const ERROR_EXCEED_MAX_DEPTH: u64 = 0;
  const ERROR_EXCEED_MAX_LEAVES: u64 = 1;

  //
  //  Resources
  //
  struct MerkleTree has store, drop, copy {
    branch: vector<vector<u8>>,
    count: u64
  }


  /// Add a new leaf to the tree
  public fun insert(tree: &mut MerkleTree, leaf: vector<u8>) {
    assert!(tree.count < MAX_LEAVES, ERROR_EXCEED_MAX_LEAVES);

    tree.count = tree.count + 1;
    let i = 0;
    let size = tree.count;
    let node = leaf;
    while (i < TREE_DEPTH) {
      if ((size & 1) == 1) {
        *vector::borrow_mut(&mut tree.branch, (i as u64)) = node;
        break
      };
      // update node varaible: node = tree[i] + node
      node = hash_concat(*vector::borrow(&tree.branch, (i as u64)), node);
      size = size / 2;
      i = i + 1;
    };
  }

  /// Get a root of Tree
  public fun root_with_ctx(tree: &MerkleTree, zeros: &vector<vector<u8>>): vector<u8> {
    let index = tree.count;

    let i: u8 = 0;
    let current: vector<u8> = Z_0;
    while (i < TREE_DEPTH) {
      let ith_bit = (index >> i) & 0x01;
      let _next = vector::borrow(&tree.branch, (i as u64));
      if (ith_bit == 1) {
        current = hash_concat(*_next, current);
      } else {
        current = hash_concat(current, *vector::borrow(zeros, (i as u64)));
      };
      i = i + 1;
    };
    current
  }

  public fun root(tree: &MerkleTree): vector<u8> {
    root_with_ctx(tree, &zero_hashes())
  }

  public fun count(tree: &MerkleTree): u64 {
    tree.count
  }

  fun zero_hashes(): vector<vector<u8>> {
    vector[
      Z_0,
      Z_1,
      Z_2,
      Z_3,
      Z_4,
      Z_5,
      Z_6,
      Z_7,
      Z_8,
      Z_9,
      Z_10,
      Z_11,
      Z_12,
      Z_13,
      Z_14,
      Z_15,
      Z_16,
      Z_17,
      Z_18,
      Z_19,
      Z_20,
      Z_21,
      Z_22,
      Z_23,
      Z_24,
      Z_25,
      Z_26,
      Z_27,
      Z_28,
      Z_29,
      Z_30,
      Z_31,
    ]
  }

  /// Create a new MerkleTree
  public fun new(): MerkleTree {
    let tree = MerkleTree {
      count: 0,
      branch: vector::empty()
    };
    // fill branch with ZEROs
    utils::fill_vector(&mut tree.branch, Z_0, (TREE_DEPTH as u64));
    tree
  }

  // keccak256 zero hashes
  const Z_0: vector<u8> =
      x"0000000000000000000000000000000000000000000000000000000000000000";
  const Z_1: vector<u8> =
      x"ad3228b676f7d3cd4284a5443f17f1962b36e491b30a40b2405849e597ba5fb5";
  const Z_2: vector<u8> =
      x"b4c11951957c6f8f642c4af61cd6b24640fec6dc7fc607ee8206a99e92410d30";
  const Z_3: vector<u8> =
      x"21ddb9a356815c3fac1026b6dec5df3124afbadb485c9ba5a3e3398a04b7ba85";
  const Z_4: vector<u8> =
      x"e58769b32a1beaf1ea27375a44095a0d1fb664ce2dd358e7fcbfb78c26a19344";
  const Z_5: vector<u8> =
      x"0eb01ebfc9ed27500cd4dfc979272d1f0913cc9f66540d7e8005811109e1cf2d";
  const Z_6: vector<u8> =
      x"887c22bd8750d34016ac3c66b5ff102dacdd73f6b014e710b51e8022af9a1968";
  const Z_7: vector<u8> =
      x"ffd70157e48063fc33c97a050f7f640233bf646cc98d9524c6b92bcf3ab56f83";
  const Z_8: vector<u8> =
      x"9867cc5f7f196b93bae1e27e6320742445d290f2263827498b54fec539f756af";
  const Z_9: vector<u8> =
      x"cefad4e508c098b9a7e1d8feb19955fb02ba9675585078710969d3440f5054e0";
  const Z_10: vector<u8> =
      x"f9dc3e7fe016e050eff260334f18a5d4fe391d82092319f5964f2e2eb7c1c3a5";
  const Z_11: vector<u8> =
      x"f8b13a49e282f609c317a833fb8d976d11517c571d1221a265d25af778ecf892";
  const Z_12: vector<u8> =
      x"3490c6ceeb450aecdc82e28293031d10c7d73bf85e57bf041a97360aa2c5d99c";
  const Z_13: vector<u8> =
      x"c1df82d9c4b87413eae2ef048f94b4d3554cea73d92b0f7af96e0271c691e2bb";
  const Z_14: vector<u8> =
      x"5c67add7c6caf302256adedf7ab114da0acfe870d449a3a489f781d659e8becc";
  const Z_15: vector<u8> =
      x"da7bce9f4e8618b6bd2f4132ce798cdc7a60e7e1460a7299e3c6342a579626d2";
  const Z_16: vector<u8> =
      x"2733e50f526ec2fa19a22b31e8ed50f23cd1fdf94c9154ed3a7609a2f1ff981f";
  const Z_17: vector<u8> =
      x"e1d3b5c807b281e4683cc6d6315cf95b9ade8641defcb32372f1c126e398ef7a";
  const Z_18: vector<u8> =
      x"5a2dce0a8a7f68bb74560f8f71837c2c2ebbcbf7fffb42ae1896f13f7c7479a0";
  const Z_19: vector<u8> =
      x"b46a28b6f55540f89444f63de0378e3d121be09e06cc9ded1c20e65876d36aa0";
  const Z_20: vector<u8> =
      x"c65e9645644786b620e2dd2ad648ddfcbf4a7e5b1a3a4ecfe7f64667a3f0b7e2";
  const Z_21: vector<u8> =
      x"f4418588ed35a2458cffeb39b93d26f18d2ab13bdce6aee58e7b99359ec2dfd9";
  const Z_22: vector<u8> =
      x"5a9c16dc00d6ef18b7933a6f8dc65ccb55667138776f7dea101070dc8796e377";
  const Z_23: vector<u8> =
      x"4df84f40ae0c8229d0d6069e5c8f39a7c299677a09d367fc7b05e3bc380ee652";
  const Z_24: vector<u8> =
      x"cdc72595f74c7b1043d0e1ffbab734648c838dfb0527d971b602bc216c9619ef";
  const Z_25: vector<u8> =
      x"0abf5ac974a1ed57f4050aa510dd9c74f508277b39d7973bb2dfccc5eeb0618d";
  const Z_26: vector<u8> =
      x"b8cd74046ff337f0a7bf2c8e03e10f642c1886798d71806ab1e888d9e5ee87d0";
  const Z_27: vector<u8> =
      x"838c5655cb21c6cb83313b5a631175dff4963772cce9108188b34ac87c81c41e";
  const Z_28: vector<u8> =
      x"662ee4dd2dd7b2bc707961b1e646c4047669dcb6584f0d8d770daf5d7e7deb2e";
  const Z_29: vector<u8> =
      x"388ab20e2573d171a88108e79d820e98f26c0b84aa8b2f4aa4968dbb818ea322";
  const Z_30: vector<u8> =
      x"93237c50ba75ee485f4c22adf2f741400bdf8d6a9cc7df7ecae576221665d735";
  const Z_31: vector<u8> =
      x"8448818bb4ae4562849e949e17ac16e0be16688e156b5cf15e098c627c0056a9";

  #[test]
  fun sparse_zero_correct() {
    let tree = new();
    let i = 0;
    while (i < 4) {
      insert(&mut tree, Z_0);
      i = i + 1;
    };
    let new_tree = new();
    assert!(root(&tree) == root(&new_tree), 0);
  }   

  #[test]
  fun create_small_tree() {
    let leaf_b00 = vector::empty<u8>(); utils::fill_vector(&mut leaf_b00, 0xAA, 32);
    let leaf_b01 = vector::empty<u8>(); utils::fill_vector(&mut leaf_b01, 0xBB, 32);
    let leaf_b10 = vector::empty<u8>(); utils::fill_vector(&mut leaf_b10, 0xCC, 32);
    let leaf_b11 = vector::empty<u8>(); utils::fill_vector(&mut leaf_b11, 0xDD, 32);

    aptos_std::debug::print<std::string::String>(&std::string::utf8(b"-----leaf b0x & leaf b1x------------"));

    let node_b0x = hash_concat(leaf_b00, leaf_b01);
    aptos_std::debug::print<vector<u8>>(&node_b0x);
    let node_b1x = hash_concat(leaf_b10, leaf_b11);
    aptos_std::debug::print<vector<u8>>(&node_b1x);

    aptos_std::debug::print<std::string::String>(&std::string::utf8(b"-----------------"));

    let root = hash_concat(hash_concat(node_b0x, node_b1x), Z_2);
    aptos_std::debug::print<vector<u8>>(&root);
     
    let tree = new();
    insert(&mut tree, leaf_b00);
    insert(&mut tree, leaf_b01);
    insert(&mut tree, leaf_b10);
    insert(&mut tree, leaf_b11);
    aptos_std::debug::print<vector<u8>>(&root(&tree));
    aptos_std::debug::print<MerkleTree>(&tree);

  }
}