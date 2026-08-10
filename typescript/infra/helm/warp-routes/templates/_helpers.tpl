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
app.kubernetes.io/component: warp-routes
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
The warp-routes container
*/}}
{{- define "hyperlane.warp-routes.container" }}
- name: warp-routes
  image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
  imagePullPolicy: IfNotPresent
  resources:
    requests:
      cpu: 100m
      memory: 512Mi
    limits:
      memory: 1Gi
  env:
  - name: SERVICE_NAME
    value: {{ .Values.serviceName | default "warp-monitor" | quote }}
  - name: LOG_FORMAT
    value: json
  - name: LOG_LEVEL
    value: info
  {{- if .Values.hyperlane.registryUri }}
  - name: REGISTRY_URI
    value: {{ .Values.hyperlane.registryUri }}
  {{- end }}
  - name: WARP_ROUTE_ID
    value: {{ .Values.warpRouteId }}
  - name: CHECK_FREQUENCY
    value: "30000"
  envFrom:
  - secretRef:
      name: {{ include "hyperlane.fullname" . }}-secret
{{- end }}

{{/*
The centralized warp-monitor container. One long-running process monitors many
routes and emits all their metrics into one scraped registry, replacing the
fleet of per-route StatefulSets. Resources are Guaranteed QoS (requests ==
limits) so GKE does not evict it under node memory pressure the way it did the
BestEffort per-route pods.
*/}}
{{- define "hyperlane.warp-routes.centralized-container" }}
- name: warp-routes
  image: {{ .Values.image.repository }}:{{ .Values.image.tag }}
  imagePullPolicy: IfNotPresent
  resources:
    requests:
      cpu: {{ .Values.centralized.resources.cpu | quote }}
      memory: {{ .Values.centralized.resources.memory | quote }}
    limits:
      cpu: {{ .Values.centralized.resources.cpu | quote }}
      memory: {{ .Values.centralized.resources.memory | quote }}
  env:
  - name: SERVICE_NAME
    value: {{ .Values.serviceName | default "warp-monitor" | quote }}
  - name: LOG_FORMAT
    value: json
  - name: LOG_LEVEL
    value: info
  {{- if .Values.hyperlane.registryUri }}
  - name: REGISTRY_URI
    value: {{ .Values.hyperlane.registryUri }}
  {{- end }}
  {{- if .Values.centralized.warpRouteAll }}
  - name: WARP_ROUTE_ALL
    value: "true"
  {{- else if .Values.centralized.warpRouteIds }}
  - name: WARP_ROUTE_IDS
    value: {{ join "," .Values.centralized.warpRouteIds | quote }}
  {{- else }}
  {{- fail "centralized.warpRouteIds must be non-empty when centralized.warpRouteAll is false" }}
  {{- end }}
  - name: WARP_MONITOR_CONCURRENCY
    value: {{ .Values.centralized.concurrency | quote }}
  {{- if .Values.centralized.skipSharedBalanceWarpRouteIds }}
  - name: SKIP_SHARED_BALANCE_WARP_ROUTE_IDS
    value: {{ join "," .Values.centralized.skipSharedBalanceWarpRouteIds | quote }}
  {{- end }}
  {{- if .Values.centralized.explorerApiUrl }}
  - name: EXPLORER_API_URL
    value: {{ .Values.centralized.explorerApiUrl | quote }}
  {{- end }}
  {{- if .Values.centralized.explorerQueryLimit }}
  - name: EXPLORER_QUERY_LIMIT
    value: {{ .Values.centralized.explorerQueryLimit | quote }}
  {{- end }}
  {{- if .Values.centralized.inventoryAddress }}
  - name: INVENTORY_ADDRESS
    value: {{ .Values.centralized.inventoryAddress | quote }}
  {{- end }}
  - name: CHECK_FREQUENCY
    value: {{ .Values.centralized.checkFrequency | default 30000 | quote }}
  envFrom:
  - secretRef:
      name: {{ include "hyperlane.fullname" . }}-secret
{{- end }}
