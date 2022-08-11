{{/*
Expand the name of the chart.
*/}}
{{- define "abacus.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name.
We truncate at 63 chars because some Kubernetes name fields are limited to this (by the DNS naming spec).
If release name contains chart name it will be used as a full name.
*/}}
{{- define "abacus.fullname" -}}
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
{{- define "abacus.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "abacus.labels" -}}
helm.sh/chart: {{ include "abacus.chart" . }}
abacus/deployment: {{ .Values.abacus.runEnv | quote }}
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

{{/*
The helloworld-kathy container
*/}}
{{- define "abacus.helloworld-kathy.container" }}
- name: helloworld-kathy
  image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
  imagePullPolicy: IfNotPresent
  command:
  - ./node_modules/.bin/ts-node
  - ./typescript/infra/scripts/helloworld/kathy.ts
  - -e
  - {{ .Values.abacus.runEnv }}
  - --context
  - {{ .Values.abacus.context }}
{{- if .Values.abacus.fullCycleTime }}
  - --full-cycle-time
  - "{{ .Values.abacus.fullCycleTime }}"
{{- end }}
{{- if .Values.abacus.messageSendTimeout }}
  - --message-send-timeout
  - "{{ .Values.abacus.messageSendTimeout }}"
{{- end }}
{{- if .Values.abacus.messageReceiptTimeout }}
  - --message-receipt-timeout
  - "{{ .Values.abacus.messageReceiptTimeout }}"
{{- end }}
{{- range .Values.abacus.chainsToSkip }}
  - --chains-to-skip
  - {{ . }}
{{- end }}
{{- if .Values.abacus.cycleOnce }}
  - --cycle-once
  {{- end }}
  envFrom:
  - secretRef:
      name: {{ include "abacus.fullname" . }}-secret
{{- end }}
