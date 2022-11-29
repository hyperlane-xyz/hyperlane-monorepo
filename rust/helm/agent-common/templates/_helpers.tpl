{{/*
Expand the name of the chart.
*/}}
{{- define "agent-common.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "agent-common.fullname" -}}
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
{{- define "agent-common.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "agent-common.labels" -}}
helm.sh/chart: {{ include "agent-common.chart" . }}
app.kubernetes.io/component: agent-common
hyperlane/deployment: {{ .Values.hyperlane.runEnv | quote }}
hyperlane/context: {{ .Values.hyperlane.context | quote }}
{{ include "agent-common.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "agent-common.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agent-common.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Create the name of the service account to use
*/}}
{{- define "agent-common.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "agent-common.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{/*
The name of the ClusterSecretStore
*/}}
{{- define "agent-common.cluster-secret-store.name" -}}
{{- default "external-secrets-gcp-cluster-secret-store" .Values.externalSecrets.clusterSecretStore }}
{{- end }}

{{/*
Recursively converts a config object into environment variables than can
be parsed by rust. For example, a config of { foo: { bar: { baz: 420 }, boo: 421 } } will
be: HYP_FOO_BAR_BAZ=420 and HYP_FOO_BOO=421
Env vars can be formatted in FOO="BAR" format if .format is "dot_env",
FOO: "BAR" format if .format is "config_map", or otherwise
they will be formatted as spec YAML-friendly environment variables
*/}}
{{- define "agent-common.config-env-vars" -}}
{{- range $key, $value := .config }}
{{- $key_name := printf "%s%s" (default "" $.key_name_prefix) $key }}
{{- if typeIs "map[string]interface {}" $value }}
{{- include "agent-common.config-env-vars" (dict "config" $value "agent_name" $.agent_name "format" $.format "key_name_prefix" (printf "%s_" $key_name)) }}
{{- else }}
{{- include "agent-common.config-env-var" (dict "agent_name" $.agent_name "key" $key_name "value" $value "format" $.format ) }}
{{- end }}
{{- end }}
{{- end }}

{{- define "agent-common.config-env-var" }}
{{- if (eq .format "dot_env") }}
HYP_{{ .agent_name | upper }}_{{ .key | upper }}={{ .value | quote }}
{{- else if (eq .format "config_map") }}
HYP_{{ .agent_name | upper }}_{{ .key | upper }}: {{ .value | quote }}
{{- else }}
- name: HYP_{{ .agent_name | upper }}_{{ .key | upper }}
  value: {{ .value | quote }}
{{- end }}
{{- end }}

