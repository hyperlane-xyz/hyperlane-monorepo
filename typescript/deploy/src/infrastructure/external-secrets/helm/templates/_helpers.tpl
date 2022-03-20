{{/*
Expand the name of the chart.
*/}}
{{- define "external-secrets.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "external-secrets.cluster-secret-store.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}-cluster-secret-store
{{- end }}

{{- define "external-secrets.gpsm-sa-secret.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}-gcpsm-sa-secret
{{- end }}

{{- define "external-secrets.gpsm-sa-secret.credentials-key" -}}
gcpsm-service-account-credentials
{{- end -}}

{{/*
Create chart name and version as used by the chart label.
*/}}
{{- define "external-secrets.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "external-secrets.labels" -}}
helm.sh/chart: {{ include "external-secrets.chart" . }}
app.kubernetes.io/name: {{ include "external-secrets.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}
