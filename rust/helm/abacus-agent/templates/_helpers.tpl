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

{{ define "abacus-agent.relayer-env-var" }}
{{ include "abacus-agent.config-env-var" (dict "agent_name" "relayer" "config_key" .config_key "Values" .Values) }}
{{ end }}

{{ define "abacus-agent.config-env-var" }}
{{- $agent_config := get .Values.abacus .agent_name }}
{{- $config_value := get $agent_config .config_key }}
{{- if not empty $config_value }}
- name: OPT_{{ .agent_name | upper }}_{{ .config_key | upper }}
  value: {{ .Values.abacus.relayer.pollingInterval | quote }}
{{ end }}
{{ end }}