export const HELP_TEXT = `Narrative Studio (ns) ${'0.1.0'} — Gate 0 CLI

Local-first writing workspace. The portable Vault is authoritative; the local
SQLite projection is disposable and rebuilt from the Vault.

USAGE
  ns <command> [subcommand] [options]

VAULT & PROJECT
  ns init --vault <dir> --title <title> [--description <text>] [--language <tag>]
      Create a new portable Vault with one project (directory must be empty).

  ns status [--vault <dir>] [--project <id>]
      Show the real saved revision, chapters, lock state and projection status.

  ns import --vault <dir> --file <manuscript.txt|md> [--title <title>]
      Import a UTF-8/UTF-16/GB18030 manuscript into a new (or empty) project.
      The untouched source bytes are preserved and hashed in the Vault.

  ns chapters --vault <dir>
      List chapters (workbench read-only view).

  ns read --vault <dir> --chapter <chapter_id>
      Print the current chapter text.

  ns studio --vault <dir> [--port <0-65535>]
      Start the local-only writing workbench (127.0.0.1, random token).

  ns verify [--vault <dir>] [--project <id>]
      Re-hash every authoritative file against the manifest (read-only).

  ns doctor [--vault <dir>] [--project <id>] [--appdata <dir>] [--repair]
      Environment/storage/lock/journal checks. --repair recovers interrupted
      commits, removes orphan staging dirs, clears provably dead locks.

  ns recover [--vault <dir>] [--project <id>]
      Explicitly finish (redo) or roll back interrupted commit journals.

  ns unlock [--vault <dir>] [--project <id>] [--force]
      Remove a stale writer lock. Refuses a live local writer without --force.

WRITING
  ns chapter add --vault <dir> --title <title> (--file <path>|--stdin|--text <s>)
      [--volume <vol_id>] [--message <text>] [--origin author|model]
      [--approval <approval_id>] [--base-revision <token>]
      Create a chapter and commit its first revision.

  ns commit --vault <dir> --chapter <chapter_id> (--file <path>|--stdin|--text <s>)
      [--message <text>] [--base-revision <token>] [--origin author|model]
      [--approval <approval_id>]
      Commit a new revision of an existing chapter (base_revision CAS).

  ns history --vault <dir> --chapter <chapter_id>
      List committed revisions (seq, id, hash, line endings, message).

  ns export --vault <dir> --out <dir> [--without-history]
      Write a plain, readable export + snapshot-manifest.json (no SQLite needed).

APPROVALS & PROPOSALS
  ns proposal add --vault <dir> --chapter <id> (--file|--stdin|--text)
  ns proposal list --vault <dir>
  ns proposal approve --vault <dir> --id <proposal_id>
  ns proposal reject  --vault <dir> --id <proposal_id> [--reason <text>]
      An AI/agent proposal is never authoritative. Approval records a receipt
      scoped to the exact content hash, then commits it through Story Core.

NARRATIVE MEMORY (Gate 2)
  ns narrative index --vault <dir> [--full] [--chapter <id>]
  ns narrative status --vault <dir>
  ns narrative search --vault <dir> <query> [--at-order <n>]
  ns narrative chapter --vault <dir> --chapter <id>
  ns narrative seed --vault <dir> --file <canon.json>
      Author-confirmed canon is written through Story Core CAS/journal. Candidate facts
      remain in the disposable projection and are never promoted automatically.

VOICE FORGE (Gate 3A)
  ns voice status --vault <dir> [--project <id>]
  ns voice analyze --vault <dir>
  ns voice source-add --vault <dir> --name <n> --rights <text> [--scope project] [--permissions local_analysis,quote_display]
  ns voice source-revoke --vault <dir> --id <source-id> --reason <text>
  ns voice approve --vault <dir> --id <proposal-id>
  ns voice rule-revoke --vault <dir> --id <rule-id> --reason <text>
  ns voice rule-rollback --vault <dir> --id <rule-id>
      Source licences and the Style Constitution are author-only Vault writes; profiles
      are deterministic, explainable local projections and never auto-approve rules.

BACKUP & RESTORE
  ns backup create --vault <dir> [--dest <dir>]
  ns backup verify --backup <dir>
  ns backup restore --backup <dir> --dest-vault <dir>
      Restore refuses to overwrite an existing project and verifies every hash.

LOCAL JOBS
  ns job submit --vault <dir> --kind projection.rebuild|demo.count
  ns job list --vault <dir>
  ns job run [--id <job_id>] --vault <dir>
  ns job cancel --vault <dir> --id <job_id>

GLOBAL OPTIONS
  --json            Machine-readable JSON (default when not --human)
  --human           Human-readable output
  --appdata <dir>   Device-local runtime root (default %LOCALAPPDATA%\\NarrativeStudio)
  --verbose | --quiet
  --help, --version
`;
