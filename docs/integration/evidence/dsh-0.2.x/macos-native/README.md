# Native macOS arm64 evidence

`native-macos-arm64-production-lane.log`: real `Test-Harness.ps1 -Lane production` run natively on macOS 27.2 arm64 with the pinned PowerShell 7.5.3
(106 rows, 104 pass; the two failures match the Linux lane). `auth-sweep-macos-native.json`: 14 routes, 280 checks, 0 failures against the native server.
`screenshots/`: Control Room restored after a restart; Engineering composer and profile selector. Paths are shortened to `~`; credential-shaped fixtures and
ephemeral tokens are redacted. See section L of `../../dsh-0.2.x-migration-report.md`.
