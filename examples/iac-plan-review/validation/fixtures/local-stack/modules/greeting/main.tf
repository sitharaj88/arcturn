variable "stack_name" {
  type        = string
  description = "Name emitted into the greeting file."
}

resource "local_file" "greeting" {
  filename        = "${path.module}/../../out/greeting.txt"
  content         = "hello ${var.stack_name}\n"
  file_permission = "0644"
}

resource "null_resource" "notify" {
  triggers = {
    stack_name = var.stack_name
  }
}

output "greeting_path" {
  value = local_file.greeting.filename
}
