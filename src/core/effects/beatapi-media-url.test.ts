import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isOfficialBeatApiInputUrl,
  isOfficialBeatApiMediaUrl,
  isPublicHttpMediaUrl,
  isUrlAllowedForMediaOutput,
  OFFICIAL_BEATAPI_MEDIA_HOST,
} from './beatapi-media-url';

const BEATAPI_ALLOWLIST = [OFFICIAL_BEATAPI_MEDIA_HOST];

test('BeatAPI allowlist still accepts the official media origin (backward compatible)', () => {
  assert.equal(
    isUrlAllowedForMediaOutput(
      'https://media.beatapi.io/outputs/task_123/result.mp4',
      BEATAPI_ALLOWLIST
    ),
    true
  );
});

test('BeatAPI allowlist rejects unrelated public hosts', () => {
  for (const url of [
    'https://example.com/video.mp4',
    'https://cdn.example.org/result.png',
    'https://other-beatapi.net/out.mp4',
  ]) {
    assert.equal(isUrlAllowedForMediaOutput(url, BEATAPI_ALLOWLIST), false, url);
  }
});

test('a second provider can declare its own trusted media host', () => {
  const testAllowlist = ['media.example.test'];
  assert.equal(
    isUrlAllowedForMediaOutput('https://media.example.test/output.mp4', testAllowlist),
    true
  );
});

test('a provider cannot use the BeatAPI host unless it explicitly allows it', () => {
  const testAllowlist = ['media.example.test'];
  assert.equal(
    isUrlAllowedForMediaOutput('https://media.beatapi.io/x.mp4', testAllowlist),
    false
  );
});

test('malicious and lookalike hostnames are rejected by exact host match', () => {
  for (const url of [
    'https://media.beatapi.io.attacker.com/output.mp4',
    'https://evilmedia.beatapi.io/output.mp4',
    'https://beatapi.io/output.mp4',
    'https://media.beatapi.io.evil.example/output.mp4',
    'https://xmediabeatapiio.com/output.mp4',
  ]) {
    assert.equal(isUrlAllowedForMediaOutput(url, BEATAPI_ALLOWLIST), false, url);
  }
});

test('host matching is case-insensitive but protocol/port/credentials are strict', () => {
  assert.equal(
    isUrlAllowedForMediaOutput('https://MEDIA.BEATAPI.IO/output.mp4', BEATAPI_ALLOWLIST),
    true
  );
  for (const url of [
    'http://media.beatapi.io/output.mp4',
    'https://media.beatapi.io:8443/output.mp4',
    'https://user:pass@media.beatapi.io/output.mp4',
    'not-a-url',
    '',
  ]) {
    assert.equal(isUrlAllowedForMediaOutput(url, BEATAPI_ALLOWLIST), false, url);
  }
});

test('no allowlist is default-deny (rejects all remote media)', () => {
  const noAllowlist = undefined as string[] | undefined;
  for (const url of [
    'https://media.beatapi.io/output.mp4',
    'https://example.com/output.mp4',
  ]) {
    assert.equal(isUrlAllowedForMediaOutput(url, []), false, url);
    assert.equal(isUrlAllowedForMediaOutput(url, noAllowlist), false, url);
  }
});

test('private/local URLs remain rejected even when the host appears in the allowlist', () => {
  const allowlist = ['media.beatapi.io', 'localhost', '127.0.0.1'];
  for (const url of [
    'http://localhost/result.mp4',
    'https://127.0.0.1/result.mp4',
    'https://10.1.2.3/result.mp4',
    'https://172.16.0.5/result.mp4',
    'https://192.168.1.1/result.mp4',
    'https://[::1]/result.mp4',
    'https://[::ffff:127.0.0.1]/result.mp4',
  ]) {
    assert.equal(isUrlAllowedForMediaOutput(url, allowlist), false, url);
  }
});

test('accepts arbitrary public provider media URLs without requiring an official path', () => {
  for (const url of [
    'https://cdn.example.com/custom/result.mp4?signature=abc&expires=123',
    'http://media.example.org/files/result.png#preview',
    'https://8.8.8.8:8443/output.webm',
  ]) {
    assert.equal(isPublicHttpMediaUrl(url), true, url);
  }

  for (const url of [
    'file:///tmp/result.mp4',
    'javascript:alert(1)',
    'https://user:pass@cdn.example.com/result.mp4',
    'http://localhost/result.mp4',
    'https://127.0.0.1/result.mp4',
    'https://10.1.2.3/result.mp4',
    'https://203.0.113.10/result.mp4',
    'https://[::1]/result.mp4',
    'https://[::ffff:127.0.0.1]/result.mp4',
  ]) {
    assert.equal(isPublicHttpMediaUrl(url), false, url);
  }
});

test('allows only the official BeatAPI media origin', () => {
  assert.equal(
    isOfficialBeatApiMediaUrl(
      'https://media.beatapi.io/outputs/task_123/result.mp4'
    ),
    true
  );

  for (const url of [
    'http://media.beatapi.io/output.mp4',
    'https://media.beatapi.io.evil.example/output.mp4',
    'https://127.0.0.1/output.mp4',
    'https://media.beatapi.io:8443/output.mp4',
    'https://user:pass@media.beatapi.io/output.mp4',
    'not-a-url',
  ]) {
    assert.equal(isOfficialBeatApiMediaUrl(url), false, url);
  }
});

test('treats only /inputs/ objects as BeatAPI input files', () => {
  assert.equal(
    isOfficialBeatApiInputUrl('https://media.beatapi.io/inputs/character.png'),
    true
  );
  assert.equal(
    isOfficialBeatApiInputUrl(
      'https://media.beatapi.io/outputs/task_123/result.png'
    ),
    false
  );
});
