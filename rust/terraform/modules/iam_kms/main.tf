# Creates an IAM user for the validator to interact with AWS services
resource "aws_iam_user" "ecs_user" {
  name = "${var.validator_name}-exec-user" # The name of the IAM user is derived from the validator's name
}

# Creates a KMS key for the validator to sign transactions securely
resource "aws_kms_key" "validator_signer_key" {
  description              = "KMS Key for Hyperlane Validator Signing"
  key_usage                = "SIGN_VERIFY" # Specifies that the key is used for signing and verification
  customer_master_key_spec = "ECC_SECG_P256K1" # Specifies the type of key to be used
}

# Creates an alias for the KMS key to make it easier to reference
resource "aws_kms_alias" "validator_signer_key_alias" {
  name          = "alias/${var.validator_name}" # The alias name includes the validator's name for easy identification
  target_key_id = aws_kms_key.validator_signer_key.key_id # Associates the alias with the created KMS key
}

# Defines an IAM policy that grants permissions to use the KMS key for signing operations
resource "aws_iam_policy" "validator_user_kms_policy" {
  name        = "${var.validator_name}-user-kms-policy"
  description = "Allow ECS tasks to use the KMS key for signing"

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "kms:GetPublicKey", # Allows retrieval of the public key
          "kms:Sign",        # Allows signing operations
          "kms:Verify"       # Allows verification of signatures
        ],
        Resource = aws_kms_key.validator_signer_key.arn # Specifies the KMS key resource
      }
    ]
  })
}

# Attaches the KMS policy to the IAM user, granting it the defined permissions
resource "aws_iam_user_policy_attachment" "validator_user_kms_policy_attachment" {
  user       = aws_iam_user.ecs_user.name # The IAM user to attach the policy to
  policy_arn = aws_iam_policy.validator_user_kms_policy.arn # The ARN of the policy to attach
}

# Generates an access key for the IAM user to authenticate with AWS services
resource "aws_iam_access_key" "ecs_user_key" {
  user = aws_iam_user.ecs_user.name # The IAM user for which to create the access key
}

# Stores the access key ID in SSM Parameter Store for secure retrieval
resource "aws_ssm_parameter" "key_id" {
  name  = "/ecs/${var.validator_name}/access-key-id" # The parameter name includes the validator's name
  type  = "String" # The type of the parameter is a simple string
  value = aws_iam_access_key.ecs_user_key.id # The value is the access key ID
}

# Stores the access key secret in SSM Parameter Store for secure retrieval
resource "aws_ssm_parameter" "key_secret" {
  name  = "/ecs/${var.validator_name}/secret-access-key" # The parameter name includes the validator's name
  type  = "String" # The type of the parameter is a simple string
  value = aws_iam_access_key.ecs_user_key.secret # The value is the access key secret
}

# Creates an IAM role for ECS tasks to assume during execution
resource "aws_iam_role" "ecs_execution_role" {
  name = "${var.validator_name}-exec-role" # The name of the role includes the validator's name

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Action = "sts:AssumeRole",
        Effect = "Allow",
        Principal = {
          Service = "ecs-tasks.amazonaws.com" # Specifies that ECS tasks can assume this role
        }
      }
    ]
  })
}

# Attaches the AmazonECSTaskExecutionRolePolicy to the ECS execution role
resource "aws_iam_role_policy_attachment" "ecs_execution_policy" {
  role       = aws_iam_role.ecs_execution_role.name # The ECS execution role to attach the policy to
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy" # The ARN of the Amazon-managed policy
}

# Defines an IAM policy to allow ECS tasks to write logs to CloudWatch
resource "aws_iam_policy" "cloudwatch_logs_policy" {
  name        = "${var.validator_name}-cloudwatch-logs-policy"
  description = "IAM policy for ECS tasks to interact with CloudWatch Logs"

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = [
          "logs:CreateLogStream", # Allows creation of log streams
          "logs:PutLogEvents"    # Allows putting log events into log streams
        ],
        Resource = "arn:aws:logs:${var.aws_region}:*:log-group:/aws/ecs/${var.aws_log_group}:log-stream:*" # Specifies the log group resource
      }
    ]
  })
}

# Attaches the CloudWatch logs policy to the ECS execution role
resource "aws_iam_role_policy_attachment" "cloudwatch_logs_policy_attachment" {
  role       = aws_iam_role.ecs_execution_role.name # The ECS execution role to attach the policy to
  policy_arn = aws_iam_policy.cloudwatch_logs_policy.arn # The ARN of the CloudWatch logs policy
}

# Defines an IAM policy to allow ECS tasks to read SSM parameters for access keys
resource "aws_iam_policy" "ssm_read_policy" {
  name        = "${var.validator_name}-ssm-read-policy"
  description = "Allow ECS tasks to read parameters"

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect = "Allow",
        Action = ["ssm:GetParameters"], # Allows retrieval of SSM parameters
        Resource = [
          aws_ssm_parameter.key_id.arn,     # The ARN of the access key ID parameter
          aws_ssm_parameter.key_secret.arn  # The ARN of the access key secret parameter
        ]
      }
    ]
  })
}

# Attaches the SSM read policy to the ECS execution role
resource "aws_iam_role_policy_attachment" "ssm_read_policy_execution_attachment" {
  role       = aws_iam_role.ecs_execution_role.name # The ECS execution role to attach the policy to
  policy_arn = aws_iam_policy.ssm_read_policy.arn # The ARN of the SSM read policy
}

# Creates an IAM role for ECS tasks to perform specific actions
resource "aws_iam_role" "ecs_task_role" {
  name = "${var.validator_name}-task-role" # The name of the task role includes the validator's name

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Action = "sts:AssumeRole",
        Effect = "Allow",
        Principal = {
          Service = "ecs-tasks.amazonaws.com" # Specifies that ECS tasks can assume this role
        }
      }
    ]
  })
}

# Defines an IAM policy to allow ECS tasks to perform actions on the EFS file system
resource "aws_iam_policy" "ecs_task_policy" {
  name = "${var.validator_name}-task-policy" # The name of the policy includes the validator's name

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect   = "Allow",
        Action   = "elasticfilesystem:*", # Allows all actions on the EFS file system
        Resource = var.efs_access_point_arn # Specifies the EFS access point resource
      }
    ]
  })
}

# Attaches the EFS policy to the ECS task role
resource "aws_iam_role_policy_attachment" "ecs_task_policy_attachment" {
  role       = aws_iam_role.ecs_task_role.name # The ECS task role to attach the policy to
  policy_arn = aws_iam_policy.ecs_task_policy.arn # The ARN of the EFS policy
}
