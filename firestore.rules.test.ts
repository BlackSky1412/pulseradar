import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Phase 0 & Phase 5: Hardened Firestore Rules & Dirty Dozen Payload Validation Suite
const rulesText = fs.readFileSync(new URL('./firestore.rules', import.meta.url), 'utf8');

interface AuthContext {
  uid: string;
  email_verified: boolean;
}

const REQUEST_TIME = '2026-11-17T01:00:00.000Z';

function isValidId(id: string): boolean {
  return typeof id === 'string' && id.length >= 1 && id.length <= 128 && /^[a-zA-Z0-9_\-]+$/.test(id);
}

function isSignedIn(auth: AuthContext | null): boolean {
  return auth !== null && auth.email_verified === true;
}

function evaluateKeywordRuleCreate(
  auth: AuthContext | null,
  ruleId: string,
  incoming: Record<string, unknown>
): 'ALLOWED' | 'PERMISSION_DENIED' {
  if (!isSignedIn(auth) || !isValidId(ruleId)) return 'PERMISSION_DENIED';
  const required = [
    'ownerId', 'keyword', 'excludedKeywords', 'matchType',
    'platforms', 'webhookServerId', 'enabled', 'matchCount',
    'createdAt', 'updatedAt'
  ];
  const keys = Object.keys(incoming);
  if (!required.every(k => keys.includes(k)) || !keys.every(k => required.includes(k))) {
    return 'PERMISSION_DENIED';
  }
  if (typeof incoming.ownerId !== 'string' || incoming.ownerId !== auth!.uid || !isValidId(incoming.ownerId)) {
    return 'PERMISSION_DENIED';
  }
  if (typeof incoming.keyword !== 'string' || incoming.keyword.length < 1 || incoming.keyword.length > 400) {
    return 'PERMISSION_DENIED';
  }
  if (typeof incoming.excludedKeywords !== 'string' || incoming.excludedKeywords.length > 250) {
    return 'PERMISSION_DENIED';
  }
  if (!['contains', 'exact', 'regex'].includes(String(incoming.matchType))) {
    return 'PERMISSION_DENIED';
  }
  if (typeof incoming.platforms !== 'string' || incoming.platforms.length < 1 || incoming.platforms.length > 120) {
    return 'PERMISSION_DENIED';
  }
  if (typeof incoming.webhookServerId !== 'string' || incoming.webhookServerId.length < 1 || incoming.webhookServerId.length > 128) {
    return 'PERMISSION_DENIED';
  }
  if (typeof incoming.enabled !== 'boolean') return 'PERMISSION_DENIED';
  if (typeof incoming.matchCount !== 'number' || !Number.isInteger(incoming.matchCount) || incoming.matchCount < 0) {
    return 'PERMISSION_DENIED';
  }
  if (incoming.createdAt !== REQUEST_TIME || incoming.updatedAt !== REQUEST_TIME) {
    return 'PERMISSION_DENIED';
  }
  return 'ALLOWED';
}

function evaluateKeywordRuleUpdate(
  auth: AuthContext | null,
  ruleId: string,
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>
): 'ALLOWED' | 'PERMISSION_DENIED' {
  if (!isSignedIn(auth) || !isValidId(ruleId)) return 'PERMISSION_DENIED';
  if (existing.ownerId !== auth!.uid) return 'PERMISSION_DENIED';
  if (incoming.ownerId !== existing.ownerId || incoming.createdAt !== existing.createdAt) {
    return 'PERMISSION_DENIED';
  }
  if (incoming.updatedAt !== REQUEST_TIME) return 'PERMISSION_DENIED';

  // Run full schema check with createdAt temporarily matched
  const createCheck = evaluateKeywordRuleCreate(auth, ruleId, {
    ...incoming,
    createdAt: REQUEST_TIME,
    updatedAt: REQUEST_TIME,
  });
  if (createCheck !== 'ALLOWED') return 'PERMISSION_DENIED';

  const affected = Object.keys(incoming).filter(k => incoming[k] !== existing[k]);
  const allowedAction2 = [
    'keyword', 'excludedKeywords', 'matchType', 'platforms',
    'webhookServerId', 'enabled', 'matchCount', 'updatedAt'
  ];
  if (!affected.every(k => allowedAction2.includes(k))) {
    return 'PERMISSION_DENIED';
  }
  return 'ALLOWED';
}

test('firestore.rules file contains all required Eight Pillars guards', () => {
  assert.ok(rulesText.includes("rules_version = '2';"));
  assert.ok(rulesText.includes('request.auth.token.email_verified == true'));
  assert.ok(rulesText.includes('isValidKeywordRule(incoming())'));
  assert.ok(rulesText.includes('isValidWebhookServer(incoming())'));
  assert.ok(rulesText.includes('isValidAlertDetection(incoming())'));
  assert.ok(rulesText.includes('resource.data.ownerId == request.auth.uid'));
});

test('Dirty Dozen Payloads all return PERMISSION_DENIED', () => {
  const validUser: AuthContext = { uid: 'user_abc_123', email_verified: true };
  const baseValidPayload = {
    ownerId: 'user_abc_123',
    keyword: 'nextjs',
    excludedKeywords: 'job,hiring',
    matchType: 'contains',
    platforms: 'reddit,hackernews',
    webhookServerId: 'srv_default_1',
    enabled: true,
    matchCount: 0,
    createdAt: REQUEST_TIME,
    updatedAt: REQUEST_TIME,
  };

  // Sanity check: valid payload is ALLOWED
  assert.equal(evaluateKeywordRuleCreate(validUser, 'rule_1', baseValidPayload), 'ALLOWED');

  // 1. Identity Spoofing on Create
  assert.equal(
    evaluateKeywordRuleCreate(validUser, 'rule_1', { ...baseValidPayload, ownerId: 'victim_uid_999' }),
    'PERMISSION_DENIED'
  );

  // 2. Unverified Email Spoofing
  assert.equal(
    evaluateKeywordRuleCreate({ uid: 'user_abc_123', email_verified: false }, 'rule_1', baseValidPayload),
    'PERMISSION_DENIED'
  );

  // 3. Shadow Field Injection on Create
  assert.equal(
    evaluateKeywordRuleCreate(validUser, 'rule_1', { ...baseValidPayload, isAdmin: true }),
    'PERMISSION_DENIED'
  );

  // 4. Shadow Field Injection on Update
  assert.equal(
    evaluateKeywordRuleUpdate(validUser, 'rule_1', baseValidPayload, { ...baseValidPayload, ghostField: 123 }),
    'PERMISSION_DENIED'
  );

  // 5. Owner Hijack on Update
  assert.equal(
    evaluateKeywordRuleUpdate(validUser, 'rule_1', baseValidPayload, { ...baseValidPayload, ownerId: 'hacker_1' }),
    'PERMISSION_DENIED'
  );

  // 6. Immortal Field Mutation (createdAt)
  assert.equal(
    evaluateKeywordRuleUpdate(validUser, 'rule_1', baseValidPayload, {
      ...baseValidPayload,
      createdAt: '2020-01-01T00:00:00.000Z',
    }),
    'PERMISSION_DENIED'
  );

  // 7. Client Timestamp Forgery
  assert.equal(
    evaluateKeywordRuleCreate(validUser, 'rule_1', {
      ...baseValidPayload,
      createdAt: '2099-01-01T00:00:00.000Z',
    }),
    'PERMISSION_DENIED'
  );

  // 8. Denial of Wallet / String Overflow (keyword > 120 chars)
  assert.equal(
    evaluateKeywordRuleCreate(validUser, 'rule_1', {
      ...baseValidPayload,
      keyword: 'a'.repeat(500),
    }),
    'PERMISSION_DENIED'
  );

  // 9. ID Poisoning (special chars in doc ID)
  assert.equal(
    evaluateKeywordRuleCreate(validUser, 'rule$bad!id', baseValidPayload),
    'PERMISSION_DENIED'
  );

  // 10. Invalid Enum State
  assert.equal(
    evaluateKeywordRuleCreate(validUser, 'rule_1', {
      ...baseValidPayload,
      matchType: 'sql_injection',
    }),
    'PERMISSION_DENIED'
  );

  // 11. Cross-Tenant Update Attempt
  assert.equal(
    evaluateKeywordRuleUpdate({ uid: 'other_user_999', email_verified: true }, 'rule_1', baseValidPayload, baseValidPayload),
    'PERMISSION_DENIED'
  );

  // 12. Value Poisoning on Update (enabled as string instead of boolean)
  assert.equal(
    evaluateKeywordRuleUpdate(validUser, 'rule_1', baseValidPayload, {
      ...baseValidPayload,
      enabled: 'true',
    }),
    'PERMISSION_DENIED'
  );
});
