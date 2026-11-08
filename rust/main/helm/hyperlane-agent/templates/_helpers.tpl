{{/*
We truncate at 63 chars - (11 + (len $suffix)) because the controller-revision-hash label adds an 11 character suffix
to the pod name, and we want the -validator suffix to still be present, but are happy to truncate the preceding name.
See https://github.com/kubernetes/kubernetes/issues/64023 for controller-revision-hash details.
*/}}
{{- define "validator.fullname" -}}
{{- $suffix := "-validator" }}
{{- include "agent-common.fullname" . | trunc (int (sub 63 (add 11 (len $suffix)))) | trimSuffix "-" }}{{ print $suffix }}
{{- end }}

{{/* Absolute or current-directory executable path; no shell syntax in validator command. */}}
{{- define "agent.binary" -}}
{{- $directory := .root.Values.image.binaryDirectory -}}
{{- if not (regexMatch "^(\\.|/[A-Za-z0-9_./-]+)$" $directory) -}}
{{- fail "image.binaryDirectory must be '.' or an absolute path without shell syntax" -}}
{{- end -}}
{{- printf "%s/%s" (trimSuffix "/" $directory) .role -}}
{{- end -}}

{{/* Only nonroot numeric bootstrap owners may enter the existing shell command. */}}
{{- define "agent.bootstrapOwner" -}}
{{- $uid := toString .Values.hyperlane.relayer.dbBootstrap.ownerUid -}}
{{- $gid := toString .Values.hyperlane.relayer.dbBootstrap.ownerGid -}}
{{- range $value := list $uid $gid -}}
{{- if or (not (regexMatch "^[0-9]+$" $value)) (lt (int64 $value) 1) (gt (int64 $value) 2147483647) -}}
{{- fail "dbBootstrap ownerUid and ownerGid must be positive numeric nonroot IDs" -}}
{{- end -}}
{{- end -}}
{{- printf "%s:%s" $uid $gid -}}
{{- end -}}
