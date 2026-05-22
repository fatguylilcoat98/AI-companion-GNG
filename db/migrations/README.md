# Database migrations

Migrations for the Lylo Companion platform live here, one file per
migration, numbered sequentially (`NNN_short_description.sql`).

## GM-0 status

Placeholder only. No migration files exist yet — the schema is added by a
later GM-series PR. Per the extraction plan, the master starts a **clean**
migration chain: no historical or archived SQL is carried over from the
Mattie reference system.

## Rules (to apply once migrations exist)

- One file per migration, numbered `NNN_*.sql`.
- Additive-first; destructive changes require explicit owner sign-off
  recorded in the migration header.
- Each migration opens with a `-- Plan:` comment.
- The master ships schema only — never client data. A copied instance
  runs these migrations against its own empty database.
