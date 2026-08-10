{{- define "kubernetes-llmd-vcr.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "kubernetes-llmd-vcr.fullname" -}}
{{- default (include "kubernetes-llmd-vcr.name" .) .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}
