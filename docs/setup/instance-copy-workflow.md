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

### 4. Run Setup

Run Setup Mode to create the companion and its supported person, and to
record the family / circle contacts. This is where instance-specific
data is entered — in the instance, never in the master.

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
