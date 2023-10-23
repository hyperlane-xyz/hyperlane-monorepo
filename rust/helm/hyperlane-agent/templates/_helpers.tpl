{{/*
We truncate at 63 chars - (11 + (len $suffix)) because the controller-revision-hash label adds an 11 character suffix
to the pod name. See https://github.com/kubernetes/kubernetes/issues/64023
*/}}
{{- define "validator.fullname" -}}
{{- $suffix := "-validator" }}
{{- include "agent-common.fullname" . | trunc (int (sub 63 (add 11 (len $suffix)))) | trimSuffix "-" }}{{ print $suffix }}
{{- end }}
