// use cli::param::matching_list_from_criteria;
// use color_eyre::Result;
// use relayer::settings::matching_list;

// #[tokio::test]
// async fn test_log_item_matching() -> Result<()> {
//     unimplemented!();
// }

// #[ignore]
// #[test]
// fn test_filter_parsing() {
//     let criteria: Vec<String> = vec!["1,2:0x1234,0x5678:5:0x7890"]
//         .iter()
//         .map(|s| s.to_string())
//         .collect();

//     let matching_list = matching_list_from_criteria(&criteria).unwrap();

//     println!("{:#?}", matching_list);

//     assert!(false);
// }

// #[test]
// fn test_csv_to_h256_vec() {
//     let csv = "0x1234,0x5678,0x7890";
//     let h256_vec = matching_list::csv_to_h160_vec(csv).unwrap();

//     println!("{:#?}", h256_vec);

//     assert!(false);
// }
