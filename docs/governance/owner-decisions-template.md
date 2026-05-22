# Owner Decisions — New Instance Template

**What this is:** a template checklist of the decisions a deployment
owner must record **before** creating a new companion instance from the
master template.

**How to use it:** when a new instance is created, copy this file into
that instance and fill in the answers there. Answers are
instance-specific and are **never** committed back to the master
template (see `../setup/template-boundaries.md`). In the master
template every answer stays blank.

Each decision below is marked **[ ] UNANSWERED** in the template.

---

## 1. Database tenancy
A dedicated database per instance, or a shared database with
pilot-instance scoping?
**[ ] UNANSWERED**

## 2. Companion identity
The companion's name, tone, and personality. These become the companion
profile / persona configuration for the instance.
**[ ] UNANSWERED**

## 3. Supported person
Who is the supported person for this instance — identity, timezone,
locale?
**[ ] UNANSWERED**

## 4. Authorized circle
Who is in the authorized circle, and what is each member's role and
permission scope (which `visibility` levels they may see)?
**[ ] UNANSWERED**

## 5. Vault PIN policy
Vault PIN length, and lockout policy (failed-attempt threshold and
lockout duration).
**[ ] UNANSWERED**

## 6. Memory admissibility default
Auto-admit `USER_STATED` memories, or require owner approval for every
fact before it enters `governed context`?
**[ ] UNANSWERED**

## 7. Legacy Project default scope
If the Legacy Project feature is enabled: circle-readable by default, or
private-by-default until explicitly shared?
**[ ] UNANSWERED**

## 8. Voice support
Voice enabled for this instance, or text-only first?
**[ ] UNANSWERED**

## 9. Feature flags
Confirm flag names, defaults, and rollout order for this instance (see
`feature-flag-model.md`).
**[ ] UNANSWERED**

## 10. Deployment target
Hosting target and region; service names for the instance.
**[ ] UNANSWERED**

## 11. Data residency / compliance
Any jurisdiction-specific data-residency, retention, or compliance
requirements for this instance.
**[ ] UNANSWERED**

## 12. Operator and escalation contacts
Who operates this instance; who are the escalation contacts for
technical and for care concerns.
**[ ] UNANSWERED**

---

## Summary

| # | Decision | Status |
|---|---|---|
| 1 | Database tenancy | [ ] UNANSWERED |
| 2 | Companion identity | [ ] UNANSWERED |
| 3 | Supported person | [ ] UNANSWERED |
| 4 | Authorized circle | [ ] UNANSWERED |
| 5 | Vault PIN policy | [ ] UNANSWERED |
| 6 | Memory admissibility default | [ ] UNANSWERED |
| 7 | Legacy Project default scope | [ ] UNANSWERED |
| 8 | Voice support | [ ] UNANSWERED |
| 9 | Feature flags | [ ] UNANSWERED |
| 10 | Deployment target | [ ] UNANSWERED |
| 11 | Data residency / compliance | [ ] UNANSWERED |
| 12 | Operator and escalation contacts | [ ] UNANSWERED |

In the master template every row stays UNANSWERED. A copied instance
fills them in.
