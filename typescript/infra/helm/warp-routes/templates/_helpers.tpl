{{/*
Expand the name of the chart.
*/}}
{{- define "hyperlane.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "hyperlane.fullname" -}}
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
{{- define "hyperlane.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "hyperlane.labels" -}}
helm.sh/chart: {{ include "hyperlane.chart" . }}
hyperlane/deployment: {{ .Values.hyperlane.runEnv | quote }}
{{ include "hyperlane.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "hyperlane.selectorLabels" -}}
app.kubernetes.io/name: {{ include "hyperlane.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
The warp-routes container
*/}}
{{- define "hyperlane.warp-routes.container" }}
- name: warp-routes
  image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
  imagePullPolicy: IfNotPresent
  command:
  - ./node_modules/.bin/tsx
  - ./typescript/infra/scripts/warp-routes/monitor-warp-routes-balances.ts
  - -v 
  - "10000"
  - -f
  - {{ .Values.configFilePath }}
{{- end }}
