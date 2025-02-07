# This resource defines an EFS file system that acts as persistent storage for the validator.
# The `creation_token` is used to ensure idempotent creation of the file system.
resource "aws_efs_file_system" "validator_fs" {
  creation_token = var.creation_token  # Unique token to guarantee the idempotence of the resource

  # Tags are key-value pairs that help with the organization and identification of AWS resources.
  tags = {
    Name = var.creation_token  # Name tag using the creation token for easy identification
  }
}

# The EFS access point serves as a custom entry point into the file system.
# It enforces the specified POSIX user and group, and the root directory settings.
resource "aws_efs_access_point" "validator_ap" {
  file_system_id = aws_efs_file_system.validator_fs.id  # Associates the access point with the file system

  # The POSIX user configuration sets the owner's user and group IDs for all file system requests.
  posix_user {
    gid = var.posix_user_gid  # POSIX group ID
    uid = var.posix_user_uid  # POSIX user ID
  }

  # The root directory configuration specifies the path and creation settings within the EFS.
  root_directory {
    path = var.root_directory_path  # The path where the root directory is mounted

    # The creation info sets the ownership and permissions for the root directory upon creation.
    creation_info {
      owner_gid   = var.posix_user_gid  # Group ID of the directory owner
      owner_uid   = var.posix_user_uid  # User ID of the directory owner
      permissions = var.root_directory_permissions  # Permissions for the root directory
    }
  }
}

# This resource creates a mount target within a specific subnet, allowing EC2 instances to access the EFS file system.
# The mount target is secured by associating it with one or more security groups.
resource "aws_efs_mount_target" "validator_mt" {
  file_system_id  = aws_efs_file_system.validator_fs.id  # Associates the mount target with the file system
  subnet_id       = var.subnet_id  # The subnet ID where the mount target is placed
  security_groups = var.security_group_ids  # Security groups that define the access rules for the mount target
}
