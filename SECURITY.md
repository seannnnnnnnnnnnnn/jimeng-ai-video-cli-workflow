# Security Policy

## Sensitive Data

This app can handle local credentials and generated media. Do not commit:

- LLM API keys
- Electron settings files
- `~/.dreamina_cli`
- `~/.jimeng-accounts`
- macOS keychain files
- generated images, generated videos, or private project outputs
- packaged installers such as `.exe`, `.dmg`, `.blockmap`

The repository `.gitignore` excludes common build artifacts and local credential paths, but contributors should still review changes before publishing.

## Login Model

The app does not bundle or replace the official `dreamina` CLI. Users must install and log in to the official CLI separately.

The local multi-account Router isolates additional accounts with separate HOME directories and separate keychain databases. Existing CLI login state should not be migrated by copying `~/.dreamina_cli`; each additional account should complete its own OAuth login flow once.

## Reporting Issues

For security-sensitive bugs, avoid posting tokens, logs with credentials, local account files, or generated private media in public issues. Share only minimal reproduction steps and redacted logs.

## Disclaimer

This is an unofficial workflow tool. It is not affiliated with, endorsed by, or maintained by 即梦, 剪映, or 字节跳动.
