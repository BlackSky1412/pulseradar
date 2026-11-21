import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTargetUser, resolvePlatformProfileUrl, extractTargetUsername } from './userValidator';

test('userValidator: extractTargetUsername handles URLs and @ handles cleanly', () => {
  assert.equal(extractTargetUsername('@baotran162008'), 'baotran162008');
  assert.equal(extractTargetUsername('https://www.tiktok.com/@baotran162008?is_from_webapp=1'), 'baotran162008');
  assert.equal(extractTargetUsername('https://instagram.com/baotran16tui/'), 'baotran16tui');
  assert.equal(extractTargetUsername('https://facebook.com/luvtint'), 'luvtint');
  assert.equal(extractTargetUsername('https://x.com/Elinaaa2511'), 'Elinaaa2511');
});

test('userValidator: resolvePlatformProfileUrl generates correct profile URLs', () => {
  assert.equal(resolvePlatformProfileUrl('@baotran162008', 'TIKTOK'), 'https://www.tiktok.com/@baotran162008');
  assert.equal(resolvePlatformProfileUrl('baotran16tui', 'INSTAGRAM'), 'https://www.instagram.com/baotran16tui/');
  assert.equal(resolvePlatformProfileUrl('luvtint', 'FACEBOOK'), 'https://www.facebook.com/luvtint');
  assert.equal(resolvePlatformProfileUrl('Elinaaa2511', 'X'), 'https://x.com/Elinaaa2511');
});

test('userValidator: rejects malformed usernames based on platform rules', async () => {
  const r1 = await validateTargetUser('a', 'TIKTOK');
  assert.equal(r1.valid, false);
  assert.match(r1.error || '', /không đúng định dạng/);

  const r2 = await validateTargetUser('invalid user with spaces', 'TIKTOK');
  assert.equal(r2.valid, false);

  const r3 = await validateTargetUser('this_handle_is_way_too_long_for_x_twitter', 'X');
  assert.equal(r3.valid, false);
  assert.match(r3.error || '', /tối đa 15 ký tự/);
});

test('userValidator: validates real TikTok account and rejects non-existent account', async () => {
  const valid = await validateTargetUser('@baotran162008', 'TIKTOK');
  assert.equal(valid.valid, true);
  assert.equal(valid.username, 'baotran162008');
  assert.equal(valid.nickname, 'Baotran16tui');
  assert.ok(valid.avatarUrl);

  const invalid = await validateTargetUser('@fake_user_99881', 'TIKTOK');
  assert.equal(invalid.valid, false);
  assert.match(invalid.error || '', /không tồn tại/);
});
