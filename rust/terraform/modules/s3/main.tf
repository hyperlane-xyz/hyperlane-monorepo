# This resource creates an S3 bucket used to store validator signatures.
# The `force_destroy` attribute is set to true to allow the bucket to be destroyed even if it contains objects.
resource "aws_s3_bucket" "validator_bucket" {
  bucket = "${var.validator_name}-signatures"
  force_destroy = true  # Enables deletion of non-empty bucket during destroy operation
}

# This resource applies a public access block configuration to the validator signatures bucket.
# It prevents public ACLs from being applied to the bucket and ignores any public ACLs already on the bucket.
resource "aws_s3_bucket_public_access_block" "validator_bucket_public_access_block" {
  bucket = aws_s3_bucket.validator_bucket.id

  block_public_acls       = true  # Blocks public ACLs from being added to the bucket
  ignore_public_acls      = true  # Ignores any public ACLs currently associated with the bucket
  block_public_policy     = false  # Allows public bucket policies (not recommended for sensitive data)
  restrict_public_buckets = false  # Allows unrestricted public access to the bucket (not recommended for sensitive data)
}

# This resource defines a bucket policy that allows public read access to the bucket and its objects.
# It also grants additional permissions to a specific IAM role to delete and put objects in the bucket.
resource "aws_s3_bucket_policy" "validator_bucket_policy" {
  bucket = aws_s3_bucket.validator_bucket.id
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect    = "Allow",
        Principal = "*",
        Action = [
          "s3:GetObject",  # Allows retrieval of objects from the bucket
          "s3:ListBucket"  # Allows listing of the objects within the bucket
        ],
        Resource = [
          "${aws_s3_bucket.validator_bucket.arn}",  # Bucket ARN
          "${aws_s3_bucket.validator_bucket.arn}/*"  # All objects within the bucket
        ]
      },
      {
        Effect = "Allow",
        Principal = {
          AWS = var.validator_execution_role_arn  # IAM role ARN with additional permissions
        },
        Action = [
          "s3:DeleteObject",  # Allows deletion of objects within the bucket
          "s3:PutObject"  # Allows uploading of new objects to the bucket
        ],
        Resource = "${aws_s3_bucket.validator_bucket.arn}/*"  # All objects within the bucket
      }
    ]
  })
}

# This resource enables versioning for the S3 bucket to keep multiple versions of an object in the same bucket.
# Versioning is useful for data retention and recovery, as it allows you to recover from unintended user actions and application failures.
resource "aws_s3_bucket_versioning" "validator_bucket_versioning" {
  bucket = aws_s3_bucket.validator_bucket.id
  versioning_configuration {
    status = "Enabled"  # Enables versioning for the specified bucket
  }
}

# This resource creates an IAM policy that grants permissions to perform specific actions on the S3 bucket.
# The policy is used to restrict write access to the bucket, allowing only certain actions like putting and getting objects.
resource "aws_iam_policy" "s3_access_policy" {
  name        = "${var.validator_name}-s3-access-policy"
  description = "IAM policy for uploading logs to S3"

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Action = [
          "s3:PutObject",  # Allows uploading of new objects to the bucket
          "s3:GetObject",  # Allows retrieval of objects from the bucket
          "s3:ListBucket"  # Allows listing of the objects within the bucket
        ],
        Resource = [
          aws_s3_bucket.validator_bucket.arn,  # Bucket ARN
          "${aws_s3_bucket.validator_bucket.arn}/*"  # All objects within the bucket
        ],
        Effect = "Allow"  # Specifies that the actions are allowed
      }
    ]
  })
}

# This resource attaches the previously defined IAM policy to a specific IAM user.
# It grants the IAM user the permissions defined in the `s3_access_policy` to interact with the S3 bucket.
resource "aws_iam_user_policy_attachment" "ecs_user_s3_policy_attachment" {
  user       = var.validator_execution_user_name  # IAM user to attach the policy to
  policy_arn = aws_iam_policy.s3_access_policy.arn  # ARN of the IAM policy to attach
}
