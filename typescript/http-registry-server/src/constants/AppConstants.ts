export const AppConstants = Object.freeze({
  // HTTP Status Codes
  HTTP_STATUS_OK: 200,
  // 204 No Content
  HTTP_STATUS_NO_CONTENT: 204,
  // 400 Bad Request
  HTTP_STATUS_BAD_REQUEST: 400,
  // 404 Not Found
  HTTP_STATUS_NOT_FOUND: 404,
  // 500 Internal Server Error
  HTTP_STATUS_INTERNAL_SERVER_ERROR: 500,

  // Content Types
  CONTENT_TYPE_JSON: 'application/json',
} as const);

export default AppConstants;
