{{/*
We truncate at 63 chars - (11 + (len $suffix)) because the controller-revision-hash label adds an 11 character suffix
to the pod name, and we want the -validator suffix to still be present, but are happy to truncate the preceding name.
See https://github.com/kubernetes/kubernetes/issues/64023 for controller-revision-hash details.
*/}}
{{- define "validator.fullname" -}}
{{- $suffix := "-validator" }}
{{- include "agent-common.fullname" . | trunc (int (sub 63 (add 11 (len $suffix)))) | trimSuffix "-" }}{{ print $suffix }}
{{- end }}
