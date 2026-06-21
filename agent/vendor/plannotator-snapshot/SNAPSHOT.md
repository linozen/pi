# Plannotator snapshot

- Source: https://github.com/backnotprop/plannotator
- Snapshot date: 2026-06-21T10:03:08Z
- Commit: 90bc8f8db533587ed138f843e062cd949e8daf78
- Pi extension package observed: @plannotator/pi-extension@0.21.0

Local paths:

- Full git clone: ~/.pi/agent/vendor/plannotator-snapshot/repo
- Installed Pi extension copy: ~/.pi/agent/npm/node_modules/@plannotator/pi-extension

To use the local clone as a Pi package after building assets:

```sh
cd ~/.pi/agent/vendor/plannotator-snapshot/repo
bun install
bun run build:pi
pi install ~/.pi/agent/vendor/plannotator-snapshot/repo/apps/pi-extension
```
