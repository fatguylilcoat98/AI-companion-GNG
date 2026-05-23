# Instance copy workflow

A new Lylo Companion is **copied** from this golden master template and
then customized. A companion is never rebuilt from scratch.

## Steps

### 1. Copy the master

Fork or copy `ai-companion-gng` into a new, instance-specific repository
(for example `pilot-<client>`). That new repository is the deployment
instance; this master is never deployed directly.

### 2. Configure the instance

In the copied repository:

- Set the companion identity, tone, and personality in `config/`.
- Copy `.env.example` to `.env` and fill in real values — in the
  instance only, never committed.

### 3. Provision the database

Create the instance's own database (Supabase) and run the master
migrations in `db/migrations/` against it. The master ships no client
data, so the instance starts empty.

### 4. Run Setup (provision the instance)

Fill the per-instance answers file (copy `config/answers.example.json`
in the instance, supply identity values) and run the **one-shot,
offline** provisioning script:

```sh
DATABASE_URL='postgres://USER:PASSWORD@HOST:5432/DB' \
node scripts/setup/provision-instance.js --answers ./answers.json
```

The script validates the answers in deployed mode (against
`config/companion.schema.json`), seeds the four required rows
(`pilot_instances`, the senior `users` row, `companion_profile`,
`supported_person_profile`) inside one transaction, and records a
paper-trail row in `setup_state` per step. Run while the runtime is
**not** mounted against the same database. See
`provisioning-contract.md` for the full contract, the answers shape,
the idempotency rules (`--force` is reserved for a future PR), and the
event-name catalog.

Family / authorized-circle contacts and any richer iterative wizard
remain a later GM milestone.

### 5. Deploy

Deploy the configured instance (Render). Service names and secrets are
instance-specific.

## Direction of change

- **Master to instance:** instances are born as copies of the master.
- **Instance to master:** only a genuinely generic platform improvement
  may be promoted upstream, stripped of all client specifics. Client
  customizations never flow back.

## Status

GM-0: this document describes the intended workflow. The configuration
model, migrations, Setup Mode, and deployment files are added by later
GM-series PRs.
