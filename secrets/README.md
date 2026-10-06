Secret files created by `./scripts/bootstrap.sh` (never commit, never copy into images):

- `db_password`     PostgreSQL password
- `master_key`      AES-256-GCM key(ring) that encrypts stored API keys and TOTP secrets.
                    Back it up separately and offline. Losing it makes encrypted credentials unrecoverable.
- `internal_token`  shared token between worker and agent-runner / api and native-claude

The directory is mode 0700 (only the installing user can enter it). The files are 0444 so the
non-root container user can read them through the Compose secret mount; the directory permission
is what keeps other host users out. This is file permission, not encryption at rest.
