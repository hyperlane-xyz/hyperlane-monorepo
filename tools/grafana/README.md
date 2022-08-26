# Grafana Dashboards

## Importing

1. replace all instances of `<prometheus>` with your prometheus deployment name in grafana
2. Create a new dashboard in grafana
3. Select the gear icon "dashboard settings"
4. Select "JSON Model"
5. Copy/paste from the "\*.json" file

## Exporting

1. Open a dashboard
2. Select the gear icon "dashboard settings"
3. Select "JSON Model"
4. Copy/paste to a "\*.json" file
5. Remove `deployment`, `context`, and any other variables which are specific to our internal use
6. Rename `grafanacloud-prom` to `<prometheus>`
