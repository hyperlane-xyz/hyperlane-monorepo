#![allow(non_snake_case)]

use std::future::Future;

use async_trait::async_trait;
use mockall::mock;

use hyperlane_core::{ChainResult, SyncBlockRangeCursor};

mock! {
    pub SyncBlockRangeCursor {
        pub fn _next_range(&mut self) -> impl Future<Output=ChainResult<(u32, u32)>> + Send {}

        pub fn _current_position(&self) -> u32 {}

        pub fn _backtrack(&mut self, start_from: u32) {}
    }
}

#[async_trait]
impl SyncBlockRangeCursor for MockSyncBlockRangeCursor {
    fn current_position(&self) -> u32 {
        self._current_position()
    }

    async fn next_range(&mut self) -> ChainResult<(u32, u32)> {
        self._next_range().await
    }

    fn backtrack(&mut self, start_from: u32) {
        self._backtrack(start_from)
    }
}
