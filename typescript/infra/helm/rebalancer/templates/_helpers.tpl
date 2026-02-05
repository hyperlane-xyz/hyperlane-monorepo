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
hyperlane/context: {{ .Values.hyperlane.context | quote }}
app.kubernetes.io/component: rebalancer
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
The name of the ClusterSecretStore
*/}}
{{- define "hyperlane.cluster-secret-store.name" -}}
{{- default "external-secrets-gcp-cluster-secret-store" .Values.externalSecrets.clusterSecretStore }}
{{- end }}

{{/*
The rebalancer container
*/}}
{{- define "hyperlane.rebalancer.container" }}
- name: rebalancer
  image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
  imagePullPolicy: IfNotPresent
  env:
  - name: LOG_FORMAT
    value: json
  - name: LOG_LEVEL
    value: info
  {{- if .Values.warpRouteId }}
  - name: WARP_ROUTE_ID
    value: {{ .Values.warpRouteId }}
  {{- end }}
  {{- if .Values.hyperlane.registryUri }}
  - name: REGISTRY_URI
    value: {{ .Values.hyperlane.registryUri }}
  {{- end }}
  - name: HYP_KEY
    value: $(REBALANCER_KEY)
  - name: COINGECKO_API_KEY
    value: $(COINGECKO_API_KEY)
  - name: REBALANCER_CONFIG_FILE
    value: "/config/rebalancer-config.yaml"
  - name: CHECK_FREQUENCY
    value: "60000"
  - name: WITH_METRICS
    value: "true"
  - name: MONITOR_ONLY
    value: "false"
  envFrom:
  - secretRef:
      name: {{ include "hyperlane.fullname" . }}-secret
  volumeMounts:
  - name: config
    mountPath: /config
    readOnly: true
{{- end }}
