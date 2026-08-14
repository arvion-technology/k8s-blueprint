{{/* Names are intentionally stable across environments; the namespace differs. */}}
{{- define "k8s-blueprint.fullname" -}}
{{ .Values.app.name }}
{{- end -}}

{{- define "k8s-blueprint.serviceAccountName" -}}
{{ .Values.serviceAccount.name }}
{{- end -}}
