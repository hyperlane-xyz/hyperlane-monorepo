variable "creation_token" {
  description = "Unique string to ensure the idempotent creation of the file system"
  type        = string
}

variable "subnet_id" {
  description = "The ID of the subnet to create the mount target in"
  type        = string
}

variable "security_group_ids" {
  description = "A list of security group IDs to associate with the mount target"
  type        = list(string)
}

variable "posix_user_gid" {
  description = "The POSIX group ID for the EFS access point"
  type        = number
  default     = 1000
}

variable "posix_user_uid" {
  description = "The POSIX user ID for the EFS access point"
  type        = number
  default     = 1000
}

variable "root_directory_path" {
  description = "Path to the root directory on the EFS volume"
  type        = string
  default     = "/hyperlane_db"
}

variable "root_directory_permissions" {
  description = "Permissions to apply to the root directory on the EFS volume"
  type        = string
  default     = "700"
}
