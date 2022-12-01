{{/*
Expand the name of the chart.
*/}}
{{- define "abacus.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "abacus.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "abacus.labels" -}}
helm.sh/chart: {{ include "abacus.chart" . }}
abacus/deployment: {{ .Values.abacus.runEnv | quote }}
abacus/context: "abacus"
{{ include "abacus.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "abacus.selectorLabels" -}}
app.kubernetes.io/name: {{ include "abacus.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
The name of the ClusterSecretStore
*/}}
{{- define "abacus.cluster-secret-store.name" -}}
{{- default "external-secrets-gcp-cluster-secret-store" .Values.externalSecrets.clusterSecretStore }}
{{- end }}
