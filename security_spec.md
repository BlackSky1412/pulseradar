# Security Specification (Phase 0: Payload-First Security TDD)

## 1. Data Invariants
1. **Identity Ownership Invariant**: Every document in `/keyword_rules/{ruleId}`, `/webhook_servers/{serverId}`, and `/alert_detections/{alertId}` must have an `ownerId` strictly equal to `request.auth.uid`, and the user must be authenticated with `request.auth.token.email_verified == true`.
2. **Immutable Ownership & Creation Time**: `ownerId` and `createdAt` can never be modified after document creation (`incoming().ownerId == existing().ownerId && incoming().createdAt == existing().createdAt`).
3. **Temporal Integrity**: On `create`, `createdAt == request.time` and `updatedAt == request.time`. On `update`, `updatedAt == request.time`.
4. **Strict Schema & Volumetric Boundaries**: Every collection strictly enforces `hasAll` and `hasOnly` keys on creation, `affectedKeys().hasOnly(...)` on action-based updates, and `.size()` limits on every string field and document ID (`isValidId`).
5. **Query Enforcer on List Operations**: `allow list` on all collections enforces `resource.data.ownerId == request.auth.uid` so no user can query another user's rules, webhook URLs, or alert logs.

## 2. The "Dirty Dozen" Payloads (Designed to Break Identity, Integrity, and State)
1. **Payload 1 (Identity Spoofing on Create)**: Creating a `keyword_rules` doc where `ownerId` is `"victim-uid-999"` instead of `request.auth.uid`. -> `PERMISSION_DENIED`
2. **Payload 2 (Unverified Email Spoofing)**: Authenticated user with `email_verified: false` attempting to create a `webhook_servers` document. -> `PERMISSION_DENIED`
3. **Payload 3 (Shadow Field Injection on Create)**: Creating a `keyword_rules` doc with an undeclared field `isAdmin: true`. -> `PERMISSION_DENIED`
4. **Payload 4 (Shadow Field Injection on Update)**: Updating a `webhook_servers` doc with an extra key `bypassed: true` outside `affectedKeys().hasOnly(...)`. -> `PERMISSION_DENIED`
5. **Payload 5 (Owner Hijack on Update)**: Updating `ownerId` on an existing `keyword_rules` document to transfer ownership. -> `PERMISSION_DENIED`
6. **Payload 6 (Immortal Field Mutation)**: Mutating `createdAt` during an update on `alert_detections`. -> `PERMISSION_DENIED`
7. **Payload 7 (Client Timestamp Forgery)**: Creating a `keyword_rules` document with a forged past/future `createdAt` instead of `request.time`. -> `PERMISSION_DENIED`
8. **Payload 8 (Denial of Wallet / String Overflow)**: Creating a `keyword_rules` doc with a 5,000-character `keyword` string (exceeding `maxLength: 120`). -> `PERMISSION_DENIED`
9. **Payload 9 (ID Poisoning)**: Creating a document with an invalid ID containing spaces or special characters (`rule$123!`). -> `PERMISSION_DENIED`
10. **Payload 10 (Invalid Enum State)**: Creating a `webhook_servers` document with `format: "xml-exploit"` outside `['json', 'discord', 'slack', 'telegram']`. -> `PERMISSION_DENIED`
11. **Payload 11 (Cross-Tenant Read/PII Leak)**: User A attempting to `get` or `list` User B's `/webhook_servers/{serverId}` containing secret webhook URLs and tokens. -> `PERMISSION_DENIED`
12. **Payload 12 (Value Poisoning on Update)**: Updating `enabled` on `keyword_rules` with a string `"yes"` instead of a boolean. -> `PERMISSION_DENIED`
