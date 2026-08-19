# Security

## Credentials

Never commit DeepSeek keys, Codex/OpenAI `auth.json`, `.env` files, logs, session
captures, or anything under `data/`. The supplied `.gitignore` excludes these
paths. Each user must authenticate with their own accounts.

`openai-oauth` is a third-party package that exposes a loopback-only local API
backed by the user's ChatGPT/Codex session. Do not change its host from
`127.0.0.1`; exposing it to a LAN or the internet would allow other users to
consume the authenticated account's quota.

If a credential is ever committed, revoke or rotate it immediately. Removing a
secret from the latest commit is not enough because it remains in Git history.

## Reporting

For a private repository, report security issues directly to the repository
owner. Do not include live credentials, complete auth files, or private session
logs in an issue.
