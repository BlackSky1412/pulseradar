import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const checkAndroidSource = process.env.E2E_CHECK_ANDROID_SOURCE === '1';
const streamRecorderRoot =
  process.env.E2E_STREAM_RECORDER_ROOT ??
  'c:\\Users\\tranm\\Documents\\antigravity\\elegant-einstein\\StreamRecorder';
const appSrcRoot = path.join(streamRecorderRoot, 'app', 'src', 'main', 'java', 'com', 'example', 'streamrecorder');

const skipReason = !checkAndroidSource
  ? 'M3 gate: set E2E_CHECK_ANDROID_SOURCE=1 after M2 finishes'
  : false;

function stripKotlinComments(src: string): string {
  // Strip block comments /* ... */ and line comments // ... outside string literals
  let out = '';
  let i = 0;
  let inString = false;
  let inRawString = false;
  while (i < src.length) {
    if (!inString && !inRawString && src.startsWith('"""', i)) {
      inRawString = true;
      out += '"""';
      i += 3;
      continue;
    }
    if (inRawString) {
      if (src.startsWith('"""', i)) {
        inRawString = false;
        out += '"""';
        i += 3;
      } else {
        out += src[i++];
      }
      continue;
    }
    if (inString) {
      if (src[i] === '\\' && i + 1 < src.length) {
        out += src[i] + src[i + 1];
        i += 2;
      } else if (src[i] === '"') {
        inString = false;
        out += '"';
        i += 1;
      } else {
        out += src[i++];
      }
      continue;
    }
    if (src[i] === '"') {
      inString = true;
      out += '"';
      i += 1;
      continue;
    }
    if (src.startsWith('/*', i)) {
      const endIdx = src.indexOf('*/', i + 2);
      i = endIdx === -1 ? src.length : endIdx + 2;
      out += ' ';
      continue;
    }
    if (src.startsWith('//', i)) {
      const nlIdx = src.indexOf('\n', i + 2);
      i = nlIdx === -1 ? src.length : nlIdx;
      continue;
    }
    out += src[i++];
  }
  return out;
}

test(
  'SI-01: Comment-strip helper ignores comments while preserving code',
  { skip: skipReason },
  () => {
    const sample = '/* startPollingLoop() */ val x = "ok" // checkAllUsers()\nfun active() {}';
    const stripped = stripKotlinComments(sample);
    assert.equal(stripped.includes('startPollingLoop'), false);
    assert.equal(stripped.includes('checkAllUsers'), false);
    assert.equal(stripped.includes('fun active()'), true);
  }
);

test(
  'SI-02: StreamMonitorService.kt passive-mode & 10-min sync invariants',
  { skip: skipReason },
  () => {
    const servicePath = path.join(appSrcRoot, 'service', 'StreamMonitorService.kt');
    assert.equal(fs.existsSync(servicePath), true, `Missing ${servicePath}`);
    const stripped = stripKotlinComments(fs.readFileSync(servicePath, 'utf8'));

    assert.equal(/startPollingLoop\s*\(/.test(stripped), false, 'startPollingLoop( must be removed');
    assert.equal(/checkAllUsers\s*\(/.test(stripped), false, 'checkAllUsers( must be removed');
    assert.equal(
      stripped.includes('Bắt đầu chu kỳ quét Live'),
      false,
      'Legacy polling log message must be removed'
    );
    assert.equal(
      /syncPendingUploads|triggerSyncPendingUploads/.test(stripped),
      true,
      'Telegram upload pipeline must remain intact'
    );
    assert.equal(stripped.includes('LocalCommandHttpServer'), true);
    assert.equal(stripped.includes('PulseRadarClient'), true);

    const clientPath = path.join(appSrcRoot, 'service', 'PulseRadarClient.kt');
    const clientStripped = fs.existsSync(clientPath)
      ? stripKotlinComments(fs.readFileSync(clientPath, 'utf8'))
      : '';
    const combined = `${stripped}\n${clientStripped}`;
    assert.match(
      combined,
      /10\s*\*\s*60\s*\*\s*1000L?|10\s*\*\s*60_000L?|600_?000L?|TimeUnit\.MINUTES\.toMillis\(\s*10\s*\)/,
      'Expected 10-minute sync interval'
    );
  }
);

test(
  'SI-03: HomeViewModel.kt & HomeScreen.kt no-polling invariants',
  { skip: skipReason },
  () => {
    const vmPath = path.join(appSrcRoot, 'ui', 'home', 'HomeViewModel.kt');
    const screenPath = path.join(appSrcRoot, 'ui', 'home', 'HomeScreen.kt');
    assert.equal(fs.existsSync(vmPath), true);
    assert.equal(fs.existsSync(screenPath), true);

    const vmStripped = stripKotlinComments(fs.readFileSync(vmPath, 'utf8'));
    const screenStripped = stripKotlinComments(fs.readFileSync(screenPath, 'utf8'));

    assert.equal(
      /StreamMonitorService\.checkNow\s*\(/.test(vmStripped),
      false,
      'HomeViewModel must not invoke StreamMonitorService.checkNow('
    );
    assert.equal(
      /viewModel\.checkNow\s*\(/.test(screenStripped),
      false,
      'HomeScreen must not invoke viewModel.checkNow('
    );
  }
);

test(
  'SI-04: LocalCommandHttpServer.kt, PulseRadarClient.kt & NetworkMonitor.kt contract presence',
  { skip: skipReason },
  () => {
    const httpServerPath = path.join(appSrcRoot, 'service', 'LocalCommandHttpServer.kt');
    const clientPath = path.join(appSrcRoot, 'service', 'PulseRadarClient.kt');
    const netPath = path.join(appSrcRoot, 'service', 'NetworkMonitor.kt');

    assert.equal(fs.existsSync(httpServerPath), true, `Missing ${httpServerPath}`);
    assert.equal(fs.existsSync(clientPath), true, `Missing ${clientPath}`);
    assert.equal(fs.existsSync(netPath), true, `Missing ${netPath}`);

    const httpSrc = stripKotlinComments(fs.readFileSync(httpServerPath, 'utf8'));
    for (const token of [
      '/record',
      '/health',
      'RECORDING_STARTED',
      'ALREADY_RECORDING',
      'SKIPPED_CELLULAR_POLICY',
      'pollingDisabled',
    ]) {
      assert.equal(httpSrc.includes(token), true, `LocalCommandHttpServer.kt missing ${token}`);
    }

    const clientSrc = stripKotlinComments(fs.readFileSync(clientPath, 'utf8'));
    assert.equal(clientSrc.includes('/api/android/register'), true);
    assert.equal(clientSrc.includes('/api/android/sync'), true);

    const netSrc = stripKotlinComments(fs.readFileSync(netPath, 'utf8'));
    assert.equal(netSrc.includes('onLinkPropertiesChanged'), true);
    assert.equal(/Inet4Address|LinkProperties/.test(netSrc), true);
  }
);

test(
  'SI-05: AndroidManifest.xml & app/build.gradle.kts preserved invariants',
  { skip: skipReason },
  () => {
    const manifestPath = path.join(streamRecorderRoot, 'app', 'src', 'main', 'AndroidManifest.xml');
    const gradlePath = path.join(streamRecorderRoot, 'app', 'build.gradle.kts');
    assert.equal(fs.existsSync(manifestPath), true);
    assert.equal(fs.existsSync(gradlePath), true);

    const manifest = fs.readFileSync(manifestPath, 'utf8');
    assert.match(manifest, /android:usesCleartextTraffic="true"/);
    assert.match(manifest, /android:foregroundServiceType="dataSync"/);
    for (const perm of [
      'INTERNET',
      'ACCESS_NETWORK_STATE',
      'FOREGROUND_SERVICE',
      'FOREGROUND_SERVICE_DATA_SYNC',
      'WAKE_LOCK',
    ]) {
      assert.equal(manifest.includes(perm), true, `AndroidManifest.xml missing ${perm}`);
    }

    const gradle = fs.readFileSync(gradlePath, 'utf8');
    assert.match(gradle, /applicationIdSuffix\s*=\s*"\.debug"/);
  }
);
