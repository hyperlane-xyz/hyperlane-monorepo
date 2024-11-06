use solana_transaction_status::EncodedTransactionWithStatusMeta;

use crate::transaction::search_dispatched_message_transactions;
use crate::utils::decode_pubkey;

#[test]
pub fn test_search_dispatched_message_transaction() {
    // given
    let mailbox_program_id = decode_pubkey("E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi").unwrap();
    let dispatched_message_pda_account =
        decode_pubkey("6eG8PheL41qLFFUtPjSYMtsp4aoAQsMgcsYwkGCB8kwT").unwrap();
    let transaction = serde_json::from_str::<EncodedTransactionWithStatusMeta>(JSON).unwrap();
    let transactions = vec![transaction];

    // when
    let transaction_hashes = search_dispatched_message_transactions(
        &mailbox_program_id,
        &dispatched_message_pda_account,
        transactions,
    );

    // then
    assert!(!transaction_hashes.is_empty());
}

const JSON: &str = r#"
{
  "blockTime": 1729865514,
  "meta": {
    "computeUnitsConsumed": 171834,
    "err": null,
    "fee": 3564950,
    "innerInstructions": [
      {
        "index": 2,
        "instructions": [
          {
            "accounts": [
              8,
              7,
              6,
              0
            ],
            "data": "gCzo5F74HA9Pb",
            "programIdIndex": 19,
            "stackHeight": 2
          },
          {
            "accounts": [
              5,
              11,
              10,
              18,
              0,
              1,
              2
            ],
            "data": "2Nsbnwq8JuYnSefHfRznxFtFqdPnbeydtt5kenfF8GR1ZU2XtF8jJDo4SUc2VY52V5C25WsKsQZBLsoCVQNzefgVj2bVznkThjuZuSKXJfZN9ADggiM2soRKVsAjf3xHm3CC3w3iyvK5U9LsjmYtiDNbJCFtEPRTDxsfvMS45Bg3q6EogmBN9JiZNLP",
            "programIdIndex": 17,
            "stackHeight": 2
          },
          {
            "accounts": [
              0,
              5
            ],
            "data": "3Bxs3zrfFUZbEPqZ",
            "programIdIndex": 10,
            "stackHeight": 3
          },
          {
            "accounts": [
              0,
              2
            ],
            "data": "11114XfZCGKrze4PNou1GXiYCJgiBCGpHks9hxjb8tFwYMjtgVtMzvriDxwYPdRqSoqztL",
            "programIdIndex": 10,
            "stackHeight": 3
          },
          {
            "accounts": [
              10,
              0,
              3,
              1,
              4,
              9,
              14
            ],
            "data": "5MtKiLZhPB3NhS7Gus6CenAEMS2QBtpY9QtuLeVH4CkpUN7599vsYzZXhk8Vu",
            "programIdIndex": 15,
            "stackHeight": 2
          },
          {
            "accounts": [
              0,
              9
            ],
            "data": "3Bxs4A3YxXXYy5gj",
            "programIdIndex": 10,
            "stackHeight": 3
          },
          {
            "accounts": [
              0,
              4
            ],
            "data": "111158VjdPaAaGVkCbPZoXJqknHXBEqoypfVjf96mwePbKxAkrKfR2gUFyN7wD8ccc9g1z",
            "programIdIndex": 10,
            "stackHeight": 3
          }
        ]
      }
    ],
    "loadedAddresses": {
      "readonly": [],
      "writable": []
    },
    "logMessages": [
      "Program ComputeBudget111111111111111111111111111111 invoke [1]",
      "Program ComputeBudget111111111111111111111111111111 success",
      "Program ComputeBudget111111111111111111111111111111 invoke [1]",
      "Program ComputeBudget111111111111111111111111111111 success",
      "Program 3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm invoke [1]",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA invoke [2]",
      "Program log: Instruction: TransferChecked",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA consumed 6200 of 983051 compute units",
      "Program TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA success",
      "Program E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi invoke [2]",
      "Program 11111111111111111111111111111111 invoke [3]",
      "Program 11111111111111111111111111111111 success",
      "Program log: Protocol fee of 0 paid from FGyh1FfooV7AtVrYjFGmjMxbELC8RMxNp4xY5WY4L4md to BvZpTuYLAR77mPhH4GtvwEWUTs53GQqkgBNuXpCePVNk",
      "Program 11111111111111111111111111111111 invoke [3]",
      "Program 11111111111111111111111111111111 success",
      "Program log: Dispatched message to 1408864445, ID 0x09c74f3e10d98c112696b72ba1609aae47616f64f28b4cb1ad8a4a710e93ee89",
      "Program E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi consumed 86420 of 972001 compute units",
      "Program return: E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi CcdPPhDZjBEmlrcroWCarkdhb2Tyi0yxrYpKcQ6T7ok=",
      "Program E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi success",
      "Program BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv invoke [2]",
      "Program 11111111111111111111111111111111 invoke [3]",
      "Program 11111111111111111111111111111111 success",
      "Program 11111111111111111111111111111111 invoke [3]",
      "Program 11111111111111111111111111111111 success",
      "Program log: Paid IGP JAvHW21tYXE9dtdG83DReqU2b4LUexFuCbtJT5tF8X6M for 431000 gas for message 0x09c7…ee89 to 1408864445",
      "Program BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv consumed 42792 of 882552 compute units",
      "Program BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv success",
      "Program log: Warp route transfer completed to destination: 1408864445, recipient: 0xd41b…f050, remote_amount: 2206478600",
      "Program 3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm consumed 171534 of 999700 compute units",
      "Program 3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm success"
    ],
    "postBalances": [
      12374928,
      0,
      2241120,
      1016160,
      1872240,
      8679120,
      2039280,
      319231603414,
      2039280,
      10172586528,
      1,
      890880,
      1141440,
      3361680,
      1830480,
      1141440,
      1,
      1141440,
      1141440,
      934087680
    ],
    "postTokenBalances": [
      {
        "accountIndex": 6,
        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "owner": "CcquFeCYNZM48kLPyG3HWxdwgigmyxPBi6iHwve9Myhj",
        "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "uiTokenAmount": {
          "amount": "165697511204",
          "decimals": 6,
          "uiAmount": 165697.511204,
          "uiAmountString": "165697.511204"
        }
      },
      {
        "accountIndex": 8,
        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "owner": "FGyh1FfooV7AtVrYjFGmjMxbELC8RMxNp4xY5WY4L4md",
        "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "uiTokenAmount": {
          "amount": "94",
          "decimals": 6,
          "uiAmount": 9.4E-5,
          "uiAmountString": "0.000094"
        }
      }
    ],
    "preBalances": [
      22211372,
      0,
      0,
      1016160,
      0,
      8679120,
      2039280,
      319231603414,
      2039280,
      10170428394,
      1,
      890880,
      1141440,
      3361680,
      1830480,
      1141440,
      1,
      1141440,
      1141440,
      934087680
    ],
    "preTokenBalances": [
      {
        "accountIndex": 6,
        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "owner": "CcquFeCYNZM48kLPyG3HWxdwgigmyxPBi6iHwve9Myhj",
        "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "uiTokenAmount": {
          "amount": "163491032604",
          "decimals": 6,
          "uiAmount": 163491.032604,
          "uiAmountString": "163491.032604"
        }
      },
      {
        "accountIndex": 8,
        "mint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "owner": "FGyh1FfooV7AtVrYjFGmjMxbELC8RMxNp4xY5WY4L4md",
        "programId": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        "uiTokenAmount": {
          "amount": "2206478694",
          "decimals": 6,
          "uiAmount": 2206.478694,
          "uiAmountString": "2206.478694"
        }
      }
    ],
    "rewards": [],
    "status": {
      "Ok": null
    }
  },
  "slot": 297626301,
  "transaction": {
    "message": {
      "accountKeys": [
        "FGyh1FfooV7AtVrYjFGmjMxbELC8RMxNp4xY5WY4L4md",
        "8DqWVhEZcg4rDYwe5UFaopmGuEajiPz9L3A1ZnytMcUm",
        "6eG8PheL41qLFFUtPjSYMtsp4aoAQsMgcsYwkGCB8kwT",
        "8Cv4PHJ6Cf3xY7dse7wYeZKtuQv9SAN6ujt5w22a2uho",
        "9yMwrDqHsbmmvYPS9h4MLPbe2biEykcL51W7qJSDL5hF",
        "BvZpTuYLAR77mPhH4GtvwEWUTs53GQqkgBNuXpCePVNk",
        "CcquFeCYNZM48kLPyG3HWxdwgigmyxPBi6iHwve9Myhj",
        "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "FDDbaNtod9pt7pmR8qtmRZJtEj9NViDA7J6cazqUjXQj",
        "JAvHW21tYXE9dtdG83DReqU2b4LUexFuCbtJT5tF8X6M",
        "11111111111111111111111111111111",
        "37N3sbyVAd3KvQsPw42i1LWkLahzL4ninVQ4n1NmnHjS",
        "3EpVCPUgyjq2MfGeCttyey6bs5zya5wjYZ2BE6yDg6bm",
        "AHX3iiEPFMyygANrp15cyUr63o9qGkwkB6ki1pgpZ7gZ",
        "AkeHBbE5JkwVppujCQQ6WuxsVsJtruBAjUo6fDCFp6fF",
        "BhNcatUDC2D5JTyeaqrdSukiVFsEHK7e3hVmKMztwefv",
        "ComputeBudget111111111111111111111111111111",
        "E588QtVUvresuXq2KoNEwAmoifCzYGpRBdHByN9KQMbi",
        "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV",
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
      ],
      "header": {
        "numReadonlySignedAccounts": 1,
        "numReadonlyUnsignedAccounts": 10,
        "numRequiredSignatures": 2
      },
      "instructions": [
        {
          "accounts": [],
          "data": "FjL4FH",
          "programIdIndex": 16,
          "stackHeight": null
        },
        {
          "accounts": [],
          "data": "3butUEijJrLf",
          "programIdIndex": 16,
          "stackHeight": null
        },
        {
          "accounts": [
            10,
            18,
            13,
            17,
            5,
            11,
            0,
            1,
            2,
            15,
            3,
            4,
            14,
            9,
            19,
            7,
            8,
            6
          ],
          "data": "RpjV6TtUSvt6UnMXdNo4h1Ze2VGVifo65r2jqRBUq6HJKhskSnwWybXyB4NxgfvedV9vhKdmDPg8sFT64JEZvxF8VfoGdqoAFt4WFLSB",
          "programIdIndex": 12,
          "stackHeight": null
        }
      ],
      "recentBlockhash": "GHQhVUy7Eq3hcps8YoG9DCd1Tb6ccQZ9xhh81ju8ujHJ"
    },
    "signatures": [
      "4nRGgV9tqCuiKUXeBzWdvdk6YC9BsGWUZurAVQLMX1NwNPpysbZNwXu97Sw4aM9REwaRmWS7gaiSKXbwtmw6oLRi",
      "hXjvQbAuFH9vAxZMdGqfnSjN7t7Z7NLTzRq1SG8i6fLr9LS6XahTduPWqakiTsLDyWSofvq3MSncUAkbQLEj85f"
    ]
  }
}
"#;
