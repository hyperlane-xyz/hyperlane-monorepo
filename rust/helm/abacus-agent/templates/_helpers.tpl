{{/*
Expand the name of the chart.
*/}}
{{- define "abacus-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "abacus-agent.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "abacus-agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "abacus-agent.labels" -}}
helm.sh/chart: {{ include "abacus-agent.chart" . }}
abacus/deployment: {{ .Values.abacus.runEnv | quote }}
abacus/context: {{ .Values.abacus.context | quote }}
{{ include "abacus-agent.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "abacus-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "abacus-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "abacus-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "abacus-agent.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
The name of the ClusterSecretStore
*/}}
{{- define "abacus-agent.cluster-secret-store.name" -}}
{{- default "external-secrets-gcp-cluster-secret-store" .Values.externalSecrets.clusterSecretStore }}
{{- end }}

{{/*
Recursively converts a config object into environment variables than can
be parsed by rust. For example, a config of { foo: { bar: { baz: 420 }, boo: 421 } } will
be: ABC_FOO_BAR_BAZ=420 and ABC_FOO_BOO=421
Env vars can be formatted in FOO="BAR" format if .format is "dot_env",
FOO: "BAR" format if .format is "config_map", or otherwise
they will be formatted as spec YAML-friendly environment variables
*/}}
{{- define "abacus-agent.config-env-vars" -}}
{{- range $key, $value := .config }}
{{- $key_name := printf "%s%s" (default "" $.key_name_prefix) $key }}
{{- if typeIs "map[string]interface {}" $value }}
{{- include "abacus-agent.config-env-vars" (dict "config" $value "agent_name" $.agent_name "format" $.format "key_name_prefix" (printf "%s_" $key_name)) }}
{{- else }}
{{- include "abacus-agent.config-env-var" (dict "agent_name" $.agent_name "key" $key_name "value" $value "format" $.format ) }}
{{- end }}
{{- end }}
{{- end }}

{{- define "abacus-agent.config-env-var" }}
{{- if (eq .format "dot_env") }}
ABC_{{ .agent_name | upper }}_{{ .key | upper }}={{ .value | quote }}
{{- else if (eq .format "config_map") }}
ABC_{{ .agent_name | upper }}_{{ .key | upper }}: {{ .value | quote }}
{{- else }}
- name: ABC_{{ .agent_name | upper }}_{{ .key | upper }}
  value: {{ .value | quote }}
{{- end }}
{{- end }}
