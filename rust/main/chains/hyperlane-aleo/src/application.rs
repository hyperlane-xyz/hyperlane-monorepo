use std::io::Cursor;

use async_trait::async_trait;
use derive_new::new;
use tracing::trace;

use hyperlane_core::{Decode, HyperlaneMessage};
use hyperlane_operation_verifier::{
    ApplicationOperationVerifier, ApplicationOperationVerifierReport,
};
use hyperlane_warp_route::TokenMessage;

const WARP_ROUTE_MARKER: &str = "/";

/// Application operation verifier for Aleo
#[derive(new)]
pub struct AleoApplicationOperationVerifier {}

#[async_trait]
impl ApplicationOperationVerifier for AleoApplicationOperationVerifier {
    async fn verify(
        &self,
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        trace!(
            ?app_context,
            ?message,
            "Aleo application operation verifier",
        );

        Self::verify_message(app_context, message)
    }
}

impl AleoApplicationOperationVerifier {
    fn verify_message(
        app_context: &Option<String>,
        message: &HyperlaneMessage,
    ) -> Option<ApplicationOperationVerifierReport> {
        use ApplicationOperationVerifierReport::MalformedMessage;

        // Aleo only supports messages up to 256 bytes
        // Aleo only supports messages bodies that are a multiple of 16 bytes, there are a couple of exceptions to this
        // See the contract implementation for reference: https://github.com/hyperlane-xyz/hyperlane-aleo/blob/main/mailbox/src/main.leo#L258
        let body_bytes = message.body.len();
        if (body_bytes % 16 != 0 && body_bytes != 129 && body_bytes != 72 && body_bytes != 80)
            || body_bytes > 256
        {
            return Some(MalformedMessage(message.clone()));
        }

        let context = match app_context {
            Some(c) => c,
            None => return None,
        };

        if !context.contains(WARP_ROUTE_MARKER) {
            return None;
        }

        // Starting from this point we assume that we are in a warp route context
        let mut reader = Cursor::new(message.body.as_slice());
        match TokenMessage::read_from(&mut reader) {
            Ok(_) => None,
            Err(_) => Some(MalformedMessage(message.clone())),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use hyperlane_core::{HyperlaneMessage, H256};

    fn create_test_message(body: Vec<u8>) -> HyperlaneMessage {
        HyperlaneMessage {
            version: 3,
            nonce: 0,
            origin: 1,
            sender: H256::zero(),
            destination: 2,
            recipient: H256::zero(),
            body,
        }
    }

    #[test]
    fn test_no_app_context() {
        let message = create_test_message(vec![0u8; 16]);
        let result = AleoApplicationOperationVerifier::verify_message(&None, &message);
        assert!(result.is_none());
    }

    #[test]
    fn test_non_warp_route_context() {
        let message = create_test_message(vec![0u8; 16]);
        let result = AleoApplicationOperationVerifier::verify_message(
            &Some("some_context".to_string()),
            &message,
        );
        assert!(result.is_none());
    }

    #[test]
    fn test_body_size_multiple_of_16() {
        let message = create_test_message(vec![0u8; 16]);
        let result = AleoApplicationOperationVerifier::verify_message(
            &Some("warp/route".to_string()),
            &message,
        );
        assert!(result.is_some()); // Will fail token message parsing
    }

    #[test]
    fn test_body_size_exception_72() {
        let message = create_test_message(vec![0u8; 72]);
        let result = AleoApplicationOperationVerifier::verify_message(
            &Some("warp/route".to_string()),
            &message,
        );
        assert!(result.is_none()); // Should not fail
    }

    #[test]
    fn test_body_size_exception_80() {
        let message = create_test_message(vec![0u8; 80]);
        let result = AleoApplicationOperationVerifier::verify_message(
            &Some("warp/route".to_string()),
            &message,
        );
        assert!(result.is_none()); // Should not fail
    }

    #[test]
    fn test_body_size_exception_129() {
        let message = create_test_message(vec![0u8; 129]);
        let result = AleoApplicationOperationVerifier::verify_message(
            &Some("warp/route".to_string()),
            &message,
        );
        assert!(result.is_none()); // Should not fail
    }

    #[test]
    fn test_body_size_invalid_not_multiple_of_16() {
        let message = create_test_message(vec![0u8; 17]);
        let result = AleoApplicationOperationVerifier::verify_message(
            &Some("warp/route".to_string()),
            &message,
        );
        assert!(matches!(
            result,
            Some(ApplicationOperationVerifierReport::MalformedMessage(_))
        ));
    }

    #[test]
    fn test_body_size_exceeds_256() {
        let message = create_test_message(vec![0u8; 257]);
        let result = AleoApplicationOperationVerifier::verify_message(
            &Some("warp/route".to_string()),
            &message,
        );
        assert!(matches!(
            result,
            Some(ApplicationOperationVerifierReport::MalformedMessage(_))
        ));
    }

    #[test]
    fn test_body_size_exactly_256() {
        let message = create_test_message(vec![0u8; 256]);
        let result = AleoApplicationOperationVerifier::verify_message(
            &Some("warp/route".to_string()),
            &message,
        );
        assert!(result.is_none()); // Should not fail
    }

    #[test]
    fn test_body_size_empty() {
        let message = create_test_message(vec![]);
        let result = AleoApplicationOperationVerifier::verify_message(
            &Some("warp/route".to_string()),
            &message,
        );
        assert!(result.is_some()); // Will fail token message parsing
    }

    #[test]
    fn test_invalid_token_message() {
        let message = create_test_message(vec![0u8; 32]);
        let result = AleoApplicationOperationVerifier::verify_message(
            &Some("warp/route".to_string()),
            &message,
        );
        assert!(matches!(
            result,
            Some(ApplicationOperationVerifierReport::MalformedMessage(_))
        ));
    }
}
