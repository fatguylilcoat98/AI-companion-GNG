# Template boundaries — what must never enter the master

The golden master template (`ai-companion-gng`) stays clean and generic.
The following must **never** be committed to this repository.

## Never in the master

- **Real client data** — any data belonging to a real client or pilot.
- **Real supported-person data** — for example Sandy's data from the
  Mattie reference system. Mattie is a source of lessons, not of data.
- **Production secrets** — API keys, database URLs, service-role keys,
  JWT secrets, or credentials of any kind.
- **Live memories** — no export of any instance's memory store.
- **One-off personas** — a specific companion's persona / soul text
  (for example `MATTIE_SOUL`). The master ships only a generic demo
  persona; real personas live in instance configuration.
- **Facility / family information** — names, contacts, relationships, or
  any detail of a real client's circle.
- **Instance-specific configuration** — Render service names, region
  settings, or per-client tuning.

## Allowed in the master

- Reusable platform code and architecture.
- The memory / governance system.
- The onboarding / Setup flow.
- Configurable companion identity and tone — the *mechanism*, not any
  client's *values*.
- Admin tooling.
- Render / Supabase readiness — templates and placeholders only.
- Demo / sample data only — clearly fictional, never real.

## The rule

If a change is specific to one client, it belongs in that client's
instance, not here. The master changes only when the platform improves
for **all** future companions.
