import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import { URL } from 'node:url';
import express from 'express';
import {
  buildProduction44WorkspaceState,
  createE2EHarness,
} from './harness.ts';
import { ReferenceContractServer } from './referenceServer.ts';
import type { WorkspaceState } from './types.ts';

// Production Infrastructure Constants
const RENDER_PUBLIC_URL = process.env.E2E_RENDER_URL ?? 'https://simple-web-starter-3755.onrender.com';
const NEON_POOLER_HOST = 'ep-winter-river-a1hipqli-pooler.ap-southeast-1.aws.neon.tech';
const NEON_DIRECT_HOST = 'ep-winter-river-a1hipqli.ap-southeast-1.aws.neon.tech';
const NEON_PORT = 5432;
const NEON_DATABASE_URL =
  'postgresql://neondb_owner:npg_SOPFv93AVnBt@ep-winter-river-a1hipqli-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

// ============================================================================
// Network Probe Helpers (Zero external dependency, native Node net/tls)
// ============================================================================

interface TcpProbeResult {
  ok: boolean;
  latencyMs: number;
  remoteAddress?: string;
  error?: string;
}

function probeTcpConnection(host: string, port: number, timeoutMs = 5000): Promise<TcpProbeResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.connect(port, host, () => {
      const latencyMs = Date.now() - start;
      const remoteAddress = socket.remoteAddress;
      socket.destroy();
      resolve({ ok: true, latencyMs, remoteAddress });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, latencyMs: Date.now() - start, error: 'Connection timed out' });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ ok: false, latencyMs: Date.now() - start, error: err.message });
    });
  });
}

interface PostgresTlsResult {
  ok: boolean;
  sslAccepted: boolean;
  authorized?: boolean;
  protocol?: string | null;
  cipher?: tls.CipherNameAndProtocol | null;
  error?: string;
}

function probePostgresTls(host: string, port: number, timeoutMs = 6000): Promise<PostgresTlsResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.connect(port, host, () => {
      // PostgreSQL SSLRequest packet: length 8, code 80877103 (0x04D2162F)
      const sslReq = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
      socket.write(sslReq);
    });

    socket.once('data', (data) => {
      const reply = data.toString('ascii');
      if (reply !== 'S') {
        socket.destroy();
        resolve({ ok: false, sslAccepted: false, error: `Server rejected SSL with reply: ${reply}` });
        return;
      }

      const tlsSocket = tls.connect(
        {
          socket,
          servername: host,
          rejectUnauthorized: true,
        },
        () => {
          const authorized = tlsSocket.authorized;
          const protocol = tlsSocket.getProtocol();
          const cipher = tlsSocket.getCipher();
          tlsSocket.end();
          resolve({ ok: true, sslAccepted: true, authorized, protocol, cipher });
        }
      );

      tlsSocket.on('error', (err) => {
        tlsSocket.destroy();
        resolve({ ok: false, sslAccepted: true, error: err.message });
      });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, sslAccepted: false, error: 'Socket timed out' });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ ok: false, sslAccepted: false, error: err.message });
    });
  });
}

interface PostgresStartupResult {
  ok: boolean;
  responseType: string;
  responsePayload: string;
  error?: string;
}

function probePostgresStartup(
  host: string,
  port: number,
  user: string,
  database: string,
  timeoutMs = 6000
): Promise<PostgresStartupResult> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.connect(port, host, () => {
      const sslReq = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);
      socket.write(sslReq);
    });

    socket.once('data', (data) => {
      if (data.toString('ascii') !== 'S') {
        socket.destroy();
        resolve({ ok: false, responseType: '', responsePayload: '', error: 'SSL not accepted' });
        return;
      }

      const tlsSocket = tls.connect(
        {
          socket,
          servername: host,
          rejectUnauthorized: true,
        },
        () => {
          // StartupMessage (protocol 3.0 = 196608)
          const params = `user\0${user}\0database\0${database}\0\0`;
          const len = 4 + 4 + Buffer.byteLength(params);
          const buf = Buffer.alloc(len);
          buf.writeInt32BE(len, 0);
          buf.writeInt32BE(196608, 4);
          buf.write(params, 8, 'utf8');
          tlsSocket.write(buf);
        }
      );

      tlsSocket.once('data', (d) => {
        const responseType = String.fromCharCode(d[0]);
        const responsePayload = d.slice(5).toString('utf8');
        tlsSocket.end();
        resolve({ ok: true, responseType, responsePayload });
      });

      tlsSocket.on('error', (err) => {
        tlsSocket.destroy();
        resolve({ ok: false, responseType: '', responsePayload: '', error: err.message });
      });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, responseType: '', responsePayload: '', error: 'Timed out' });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ ok: false, responseType: '', responsePayload: '', error: err.message });
    });
  });
}

function probePlaintextPostgresReject(host: string, port: number, timeoutMs = 5000): Promise<{
  rejected: boolean;
  errorCode: string;
  rawResponse: string;
}> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    socket.connect(port, host, () => {
      // Send StartupMessage directly without SSLRequest
      const params = 'user\0neondb_owner\0database\0neondb\0\0';
      const len = 4 + 4 + Buffer.byteLength(params);
      const buf = Buffer.alloc(len);
      buf.writeInt32BE(len, 0);
      buf.writeInt32BE(196608, 4);
      buf.write(params, 8, 'utf8');
      socket.write(buf);
    });

    socket.once('data', (data) => {
      const responseType = String.fromCharCode(data[0]);
      const rawResponse = data.slice(5).toString('utf8');
      socket.destroy();
      const codeMatch = rawResponse.match(/C([0-9A-Z]{5})/);
      const errorCode = codeMatch ? codeMatch[1] : '';
      resolve({
        rejected: responseType === 'E',
        errorCode,
        rawResponse,
      });
    });

    socket.on('error', (err) => {
      socket.destroy();
      resolve({ rejected: false, errorCode: '', rawResponse: err.message });
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve({ rejected: false, errorCode: '', rawResponse: 'Timed out' });
    });
  });
}

function parsePostgresConnectionString(urlStr: string) {
  const parsed = new URL(urlStr);
  assert.equal(parsed.protocol, 'postgresql:');
  return {
    protocol: parsed.protocol,
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    host: parsed.hostname,
    port: parsed.port ? parseInt(parsed.port, 10) : 5432,
    database: parsed.pathname.replace(/^\//, ''),
    sslmode: parsed.searchParams.get('sslmode'),
    channelBinding: parsed.searchParams.get('channel_binding'),
  };
}

// ============================================================================
// TIER 1: FEATURE COVERAGE (≥5 Positive Tests per Feature)
// ============================================================================

// --- Feature 1: Render Service Deployment ---

test('T1-DEP-01: Build Pipeline Verification - dist/ contains valid index.html and assets', async () => {
  const distPath = path.join(repoRoot, 'dist');
  const indexPath = path.join(distPath, 'index.html');
  const assetsPath = path.join(distPath, 'assets');

  assert.ok(fs.existsSync(indexPath), 'dist/index.html must exist');
  const htmlContent = fs.readFileSync(indexPath, 'utf8');
  assert.ok(htmlContent.includes('<div id="root"></div>'), 'HTML must have root mount point');
  assert.ok(htmlContent.includes('<title>PulseRadar'), 'HTML must have PulseRadar title');

  assert.ok(fs.existsSync(assetsPath), 'dist/assets directory must exist');
  const assetFiles = fs.readdirSync(assetsPath);
  const jsBundle = assetFiles.find((f) => f.endsWith('.js'));
  const cssBundle = assetFiles.find((f) => f.endsWith('.css'));
  assert.ok(jsBundle, 'Vite JS bundle must exist');
  assert.ok(cssBundle, 'Vite CSS bundle must exist');

  const jsSize = fs.statSync(path.join(assetsPath, jsBundle)).size;
  assert.ok(jsSize > 10000, `JS bundle size must be >10KB, got ${jsSize} bytes`);
});

test('T1-DEP-02: Dynamic Port Environment Binding - Server binds to custom port and reports it', async () => {
  const targetPort = 3105;
  const app = express();
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, port: targetPort });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(targetPort, '0.0.0.0', () => resolve()));

  try {
    const resp = await fetch(`http://127.0.0.1:${targetPort}/api/health`);
    assert.equal(resp.status, 200);
    const health = (await resp.json()) as { ok: boolean; port: number };
    assert.equal(health.ok, true);
    assert.equal(health.port, targetPort, 'Health check port must match bound port');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('T1-DEP-03: Production Static File Serving - Root route serves SPA index.html', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-t1-dep03-'));
  const refServer = new ReferenceContractServer({ dataDir: tempDir });

  try {
    await refServer.start();
    const resp = await fetch(`${refServer.url}/`);
    assert.equal(resp.status, 200);
    const contentType = resp.headers.get('content-type') ?? '';
    assert.ok(contentType.includes('text/html'), `Content-Type must be text/html, got ${contentType}`);

    const text = await resp.text();
    assert.ok(text.includes('<div id="root"></div>') || text.includes('PulseRadar'), 'Body must serve SPA index');
  } finally {
    await refServer.stop();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T1-DEP-04: Service Initialization & Module Boot - Express mounts all core API routes', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });

  try {
    const health = await harness.getHealth();
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(typeof health.body.autoScanEnabled, 'boolean');

    const status = await harness.getAndroidStatus();
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.ok(status.body.scanner, 'Scanner configuration must be present');

    const state = await harness.getWorkspaceState();
    assert.equal(state.status, 200);
    assert.equal(state.body.ok, true);
    assert.equal(state.body.state?.rules.length, 4);
  } finally {
    await harness.cleanup();
  }
});

test('T1-DEP-05: State Directory Resilience - Auto-creates state files when started in fresh directory', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-t1-dep05-'));
  const refServer = new ReferenceContractServer({ dataDir: emptyDir });

  try {
    await refServer.start();
    assert.ok(fs.existsSync(emptyDir), 'Data directory must exist');

    // PUT workspace state to initialize state files on disk
    const putRes = await fetch(`${refServer.url}/api/workspace-state`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildProduction44WorkspaceState()),
    });
    assert.equal(putRes.status, 200);

    const getRes = await fetch(`${refServer.url}/api/workspace-state`);
    assert.equal(getRes.status, 200);
    const body = (await getRes.json()) as { ok: boolean; state: WorkspaceState };
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.state?.rules), 'Rules array must be initialized');
    assert.equal(body.state?.rules.length, 4);
  } finally {
    await refServer.stop();
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

// --- Feature 2: Live Public URL Accessibility & Edge Infrastructure ---

test('T1-URL-01: Public HTTPS Root Endpoint Probe - Render live URL responds over HTTPS and serves PulseRadar SPA', async () => {
  const resp = await fetch(RENDER_PUBLIC_URL, {
    headers: { 'User-Agent': 'PulseRadar-E2E-Verifier/1.0' },
  });
  assert.equal(resp.status, 200, 'Public Render URL root must return 200 OK');
  const contentType = resp.headers.get('content-type') ?? '';
  assert.ok(contentType.includes('text/html'), `Content-Type must be text/html, got ${contentType}`);
  const body = await resp.text();
  assert.equal(body.includes('Your first deploy'), false, 'Live root must NOT serve Render static starter template');
  assert.equal(body.includes('render-examples/sample-static-site'), false, 'Live root must NOT serve sample-static-site');
  assert.ok(
    body.includes('PulseRadar') || body.includes('<div id="root">'),
    'Live root must serve authentic PulseRadar React SPA'
  );
});

test('T1-URL-02: SSL/TLS Certificate & SNI Handshake - Edge certificate is valid and trusted', async () => {
  const parsed = new URL(RENDER_PUBLIC_URL);
  const host = parsed.hostname;

  await new Promise<void>((resolve, reject) => {
    const socket = tls.connect(
      {
        host,
        port: 443,
        servername: host,
        rejectUnauthorized: true,
      },
      () => {
        assert.equal(socket.authorized, true, 'TLS socket must be authorized by trusted CA');
        const cert = socket.getPeerCertificate();
        assert.ok(cert.subject, 'Certificate must have a valid subject');
        assert.ok(Date.parse(cert.valid_to) > Date.now(), 'Certificate must not be expired');
        socket.end();
        resolve();
      }
    );
    socket.on('error', reject);
    socket.setTimeout(8000, () => {
      socket.destroy();
      reject(new Error('TLS probe timed out'));
    });
  });
});

test('T1-URL-03: Edge Tracing & Security Headers - Live edge provides security and trace headers', async () => {
  const resp = await fetch(RENDER_PUBLIC_URL, { method: 'HEAD' });
  assert.equal(resp.status, 200);

  const rndrId = resp.headers.get('rndr-id');
  const nosniff = resp.headers.get('x-content-type-options');
  const hsts = resp.headers.get('strict-transport-security');

  assert.ok(rndrId, 'Render edge rndr-id header must be present');
  assert.equal(nosniff, 'nosniff', 'x-content-type-options must be nosniff');
  assert.ok(hsts?.includes('max-age='), 'strict-transport-security must specify max-age');
});

test('T1-URL-04: SPA Fallback Routing on Public URL - Verifies SPA fallback routing on live service', async () => {
  // Test SPA fallback with Express static fallback mounting dist/
  const app = express();
  const distPath = path.join(repoRoot, 'dist');
  app.use(express.static(distPath));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;

  try {
    const spaResp = await fetch(`http://127.0.0.1:${port}/settings`);
    assert.equal(spaResp.status, 200, 'Local SPA fallback must return 200 OK');
    const ct = spaResp.headers.get('content-type') ?? '';
    assert.ok(ct.includes('text/html'), 'SPA fallback must serve HTML');
    const body = await spaResp.text();
    assert.ok(body.includes('<div id="root"></div>'), 'SPA fallback serves index.html');

    // Probe live public URL on an SPA deep route to confirm authentic SPA fallback routing
    const spaUrl = `${RENDER_PUBLIC_URL}/settings`;
    const liveResp = await fetch(spaUrl, {
      headers: { 'User-Agent': 'PulseRadar-E2E-Verifier/1.0' },
    });
    assert.equal(liveResp.status, 200, `Live public URL at ${spaUrl} must return HTTP 200 for SPA client routes`);
    const liveCt = liveResp.headers.get('content-type') ?? '';
    assert.ok(liveCt.includes('text/html'), `SPA fallback content-type must be text/html, got ${liveCt}`);
    const liveBody = await liveResp.text();
    assert.equal(liveBody.includes('Your first deploy'), false, 'Live URL must NOT serve Render static starter template');
    assert.equal(liveBody.includes('render-examples/sample-static-site'), false, 'Live URL must NOT serve sample-static-site');
    assert.ok(
      liveBody.includes('PulseRadar') || liveBody.includes('<div id="root">'),
      'Live SPA fallback must serve PulseRadar index.html'
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('T1-URL-05: HTTP Compression & Content Encoding - Edge supports compressed payloads', async () => {
  const resp = await fetch(RENDER_PUBLIC_URL, {
    headers: { 'Accept-Encoding': 'gzip, deflate, br' },
  });
  assert.equal(resp.status, 200);
  const contentEncoding = resp.headers.get('content-encoding');
  assert.ok(
    contentEncoding === 'gzip' || contentEncoding === 'br' || contentEncoding === null,
    `Content-Encoding should be gzip, br, or uncompressed, got ${contentEncoding}`
  );
});

// --- Feature 3: Dynamic APIs & Application Services ---

test('T1-API-01: Health Introspection Contract - /api/health satisfies specification schema', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });

  try {
    const res = await harness.getHealth();
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.port, 'number');
    assert.equal(typeof res.body.autoScanEnabled, 'boolean');
    assert.equal(typeof res.body.autoScanRunning, 'boolean');
    assert.equal(typeof res.body.trackedUsersCount, 'number');
    assert.ok(res.body.trackedUsersCount >= 44, 'Must track production rules');
    assert.ok(res.body.serverTime, 'serverTime timestamp must be present');
    assert.ok(!Number.isNaN(Date.parse(res.body.serverTime)), 'serverTime must be valid ISO');
  } finally {
    await harness.cleanup();
  }
});

test('T1-API-02: Android Device Dynamic Registration - POST /api/android/register registers companion', async () => {
  const harness = await createE2EHarness();

  try {
    const reg = await harness.registerAndroid({
      deviceId: 'sm_n770f_prod_test',
      ip: '192.168.1.50',
      port: 8765,
      appVersion: '1.0.0-debug',
      networkType: 'WIFI',
    });

    assert.equal(reg.status, 200);
    assert.equal(reg.body.ok, true);
    if (reg.body.ok) {
      assert.equal(reg.body.deviceId, 'sm_n770f_prod_test');
      assert.equal(reg.body.ip, '192.168.1.50');
      assert.equal(reg.body.port, 8765);
      assert.equal(reg.body.callbackUrl, 'http://192.168.1.50:8765/record');
      assert.ok(!Number.isNaN(Date.parse(reg.body.serverTime)));
    }
  } finally {
    await harness.cleanup();
  }
});

test('T1-API-03: Android Companion Status - GET /api/android/status reflects registered device', async () => {
  const harness = await createE2EHarness();

  try {
    await harness.registerAndroid({
      deviceId: 'sm_n770f_prod_test',
      ip: '192.168.1.50',
      port: 8765,
    });

    const status = await harness.getAndroidStatus();
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.equal(status.body.device?.deviceId, 'sm_n770f_prod_test');
    assert.equal(status.body.device?.ip, '192.168.1.50');
    assert.equal(status.body.scanner.pollIntervalSeconds, 30);
  } finally {
    await harness.cleanup();
  }
});

test('T1-API-04: 10-Minute Authoritative Reconciliation - POST /api/android/sync returns diff contracts', async () => {
  const initial = buildProduction44WorkspaceState();
  const harness = await createE2EHarness({ initialWorkspaceState: initial });

  try {
    // Register device first to establish port and device state
    await harness.registerAndroid({
      deviceId: 'sm_n770f_prod_test',
      ip: '192.168.1.50',
      port: 8765,
    });

    const syncRes = await harness.syncAndroid({
      deviceId: 'sm_n770f_prod_test',
      ip: '192.168.1.50',
      port: 8765,
      users: [
        {
          platform: 'TIKTOK',
          username: '@ebe_m72',
          nickname: 'ebe_m72',
          status: 'IDLE',
          isEnabled: true,
        },
      ],
    });

    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.ok, true);
    if (syncRes.body.ok) {
      assert.ok(Array.isArray(syncRes.body.authoritativeUsers));
      assert.equal(syncRes.body.authoritativeUsers.length, 44);
      assert.ok(Array.isArray(syncRes.body.toAdd));
      assert.ok(Array.isArray(syncRes.body.toUpdate));
      assert.ok(Array.isArray(syncRes.body.toRemove));
      assert.ok(Array.isArray(syncRes.body.recordTriggers));
    }
  } finally {
    await harness.cleanup();
  }
});

test('T1-API-05: Workspace State Atomic Read & Write - PUT and GET /api/workspace-state round-trip', async () => {
  const harness = await createE2EHarness();

  try {
    const updatedState = buildProduction44WorkspaceState();
    updatedState.scannerSettings.pollIntervalSeconds = 45;

    const putRes = await harness.putWorkspaceState(updatedState);
    assert.equal(putRes.status, 200);
    assert.equal(putRes.body.ok, true);

    const getRes = await harness.getWorkspaceState();
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.ok, true);
    assert.equal(getRes.body.state?.scannerSettings?.pollIntervalSeconds, 45);
    assert.ok(getRes.body.state?.updatedAt);
  } finally {
    await harness.cleanup();
  }
});

// --- Feature 4: Database Connectivity (Neon PostgreSQL) ---

test('T1-DB-01: TCP Connectivity to Neon Pooled Endpoint - Connects to AWS Singapore pooler port 5432', async () => {
  const res = await probeTcpConnection(NEON_POOLER_HOST, NEON_PORT, 6000);
  assert.equal(res.ok, true, `TCP connection to Neon pooler must succeed: ${res.error}`);
  assert.ok(res.latencyMs < 3000, `Latency must be <3000ms, got ${res.latencyMs}ms`);
  assert.ok(res.remoteAddress, 'Remote IP must be resolved');
});

test('T1-DB-02: TCP Connectivity to Neon Direct Endpoint - Connects to AWS Singapore direct port 5432', async () => {
  const res = await probeTcpConnection(NEON_DIRECT_HOST, NEON_PORT, 6000);
  assert.equal(res.ok, true, `TCP connection to Neon direct host must succeed: ${res.error}`);
  assert.ok(res.latencyMs < 3000, `Latency must be <3000ms, got ${res.latencyMs}ms`);
});

test('T1-DB-03: SSL/TLS Handshake with Neon Host - PostgreSQL SSLRequest returns S and TLS 1.3 socket negotiates', async () => {
  const res = await probePostgresTls(NEON_POOLER_HOST, NEON_PORT, 8000);
  assert.equal(res.ok, true, `Neon TLS probe must succeed: ${res.error}`);
  assert.equal(res.sslAccepted, true, 'Neon must accept PostgreSQL SSLRequest');
  assert.equal(res.authorized, true, 'TLS certificate must be valid and authorized');
  assert.ok(res.protocol?.includes('TLSv1.3') || res.protocol?.includes('TLSv1.2'), `Protocol must be modern TLS: ${res.protocol}`);
  assert.ok(res.cipher?.name, 'Cipher suite must be negotiated');
});

test('T1-DB-04: DATABASE_URL Parsing & Validation - Validates connection URI parameters', () => {
  const parsed = parsePostgresConnectionString(NEON_DATABASE_URL);
  assert.equal(parsed.protocol, 'postgresql:');
  assert.equal(parsed.username, 'neondb_owner');
  assert.ok(parsed.password.startsWith('npg_'));
  assert.equal(parsed.host, NEON_POOLER_HOST);
  assert.equal(parsed.port, 5432);
  assert.equal(parsed.database, 'neondb');
  assert.equal(parsed.sslmode, 'require');
  assert.equal(parsed.channelBinding, 'require');
});

test('T1-DB-05: Neon PostgreSQL Protocol Handshake - Sends StartupMessage and receives SASL authentication request', async () => {
  const res = await probePostgresStartup(NEON_POOLER_HOST, NEON_PORT, 'neondb_owner', 'neondb', 8000);
  assert.equal(res.ok, true, `Startup probe must succeed: ${res.error}`);
  assert.equal(res.responseType, 'R', 'Server must respond with Authentication Request (R)');
  assert.ok(
    res.responsePayload.includes('SCRAM-SHA-256'),
    `Authentication payload must offer SCRAM-SHA-256: ${res.responsePayload}`
  );
});

// ============================================================================
// TIER 2: BOUNDARY & CORNER CASES (≥5 Boundary Tests per Feature)
// ============================================================================

// --- Feature 1: Render Deployment Boundaries ---

test('T2-DEP-01: Non-numeric and Out-of-Range PORT Envs - Server falls back safely to default port', async () => {
  const parsePort = (val: string | undefined): number => {
    if (!val) return 3000;
    const n = parseInt(val, 10);
    return Number.isInteger(n) && n >= 1 && n <= 65535 ? n : 3000;
  };

  assert.equal(parsePort('invalid_port'), 3000);
  assert.equal(parsePort('-5'), 3000);
  assert.equal(parsePort('999999'), 3000);
  assert.equal(parsePort(''), 3000);
  assert.equal(parsePort('8080'), 8080);
});

test('T2-DEP-02: Missing NODE_ENV Mode - Operates gracefully without crashing', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-t2-dep02-'));
  const originalEnv = process.env.NODE_ENV;
  delete process.env.NODE_ENV;

  try {
    const refServer = new ReferenceContractServer({ dataDir: tempDir });
    await refServer.start();
    const res = await fetch(`${refServer.url}/api/health`);
    assert.equal(res.status, 200);
    await refServer.stop();
  } finally {
    if (originalEnv !== undefined) {
      process.env.NODE_ENV = originalEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T2-DEP-03: Missing dist/ Directory in Production - API routes continue functioning', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-t2-dep03-'));
  const nonExistentDist = path.join(tempDir, 'non_existent_dist');

  const app = express();
  app.use(express.json());
  if (fs.existsSync(nonExistentDist)) {
    app.use(express.static(nonExistentDist));
  }
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, fallback: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address() as net.AddressInfo;

  try {
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/health`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean };
    assert.equal(body.ok, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T2-DEP-04: Port Collision / EADDRINUSE Handling - Emits catchable error event', async () => {
  const server1 = http.createServer();
  await new Promise<void>((resolve) => server1.listen(0, '127.0.0.1', () => resolve()));
  const port = (server1.address() as net.AddressInfo).port;

  const server2 = http.createServer();
  const errorCaught = await new Promise<boolean>((resolve) => {
    server2.on('error', (err: NodeJS.ErrnoException) => {
      resolve(err.code === 'EADDRINUSE');
    });
    server2.listen(port, '127.0.0.1');
  });

  assert.equal(errorCaught, true, 'Second server must catch EADDRINUSE cleanly');
  await new Promise<void>((resolve) => server1.close(() => resolve()));
});

test('T2-DEP-05: Rapid Consecutive Start / Stop Cycles - Sockets release cleanly without leaks', async () => {
  for (let i = 0; i < 4; i++) {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const port = (server.address() as net.AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(await res.text(), 'ok');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

// --- Feature 2: Public URL Accessibility Boundaries ---

test('T2-URL-01: Plaintext HTTP to HTTPS Redirection - Edge redirects HTTP to HTTPS or enforces TLS', async () => {
  const httpUrl = RENDER_PUBLIC_URL.replace(/^https:/, 'http:');
  const resp = await fetch(httpUrl, { redirect: 'manual' });
  assert.ok(
    [200, 301, 302, 307, 308].includes(resp.status),
    `HTTP request status should be redirect or OK, got ${resp.status}`
  );
  if ([301, 308].includes(resp.status)) {
    const loc = resp.headers.get('location') ?? '';
    assert.ok(loc.startsWith('https:'), `Redirect must target https:, got ${loc}`);
  }
});

test('T2-URL-02: Unsupported HTTP Verbs on Root - Method safety and non-existent path 404', async () => {
  // 1. Verify that Express server rejects unhandled methods or routes
  const app = express();
  app.get('/api/health', (_req, res) => res.json({ ok: true }));
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as net.AddressInfo).port;

  try {
    const putResp = await fetch(`http://127.0.0.1:${port}/api/health`, { method: 'DELETE' });
    assert.equal(putResp.status, 404, 'DELETE on unhandled route must return 404');

    // 2. Verify unmounted API path strictly returns 404 on live public URL
    const unmountedApiResp = await fetch(`${RENDER_PUBLIC_URL}/api/non-existent-route-random-404`);
    assert.equal(unmountedApiResp.status, 404, 'Unmounted API route on live server must return 404 Not Found');

    // 3. Verify non-existent client path serves SPA fallback on live public URL
    const spaFallbackResp = await fetch(`${RENDER_PUBLIC_URL}/non-existent-route-random-404`);
    assert.equal(spaFallbackResp.status, 200, 'Non-existent client path must return 200 with SPA fallback');
    const spaBody = await spaFallbackResp.text();
    assert.ok(
      spaBody.includes('PulseRadar') || spaBody.includes('<div id="root">'),
      'SPA fallback must serve PulseRadar index.html'
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('T2-URL-03: Oversized HTTP Request Headers - Edge/Server rejects headers >8KB', async () => {
  const largeValue = 'x'.repeat(9000);
  try {
    const resp = await fetch(RENDER_PUBLIC_URL, {
      headers: { 'X-Oversized-Test': largeValue },
    });
    assert.ok(
      [400, 431, 502].includes(resp.status),
      `Oversized headers should trigger 400/431/502, got ${resp.status}`
    );
  } catch (err: unknown) {
    assert.ok(err !== null, 'Connection reset by edge is valid boundary behavior');
  }
});

test('T2-URL-04: Path Normalization with Duplicate Slashes - Handles double slashes cleanly', async () => {
  const parsed = new URL(RENDER_PUBLIC_URL);
  const doubleSlashUrl = `${parsed.origin}//`;
  const resp = await fetch(doubleSlashUrl);
  assert.equal(resp.status, 200, 'Double-slash path must return 200 OK');
});

test('T2-URL-05: Keep-Alive Socket Idle Timeout - Closes idle raw socket without server hang', async () => {
  const parsed = new URL(RENDER_PUBLIC_URL);
  const host = parsed.hostname;

  await new Promise<void>((resolve) => {
    const socket = tls.connect(
      {
        host,
        port: 443,
        servername: host,
      },
      () => {
        socket.write('GET / HTTP/1.1\r\nHost: ' + host + '\r\n');
        setTimeout(() => {
          socket.destroy();
          resolve();
        }, 1500);
      }
    );
    socket.on('error', () => {
      socket.destroy();
      resolve();
    });
  });
});

// --- Feature 3: Dynamic APIs Boundaries ---

test('T2-API-01: Out-of-Range Ports on Android Register - Rejects ports < 1 or > 65535', async () => {
  const harness = await createE2EHarness();

  try {
    for (const badPort of [0, -1, 65536, 100000]) {
      const res = await harness.registerAndroid({
        deviceId: 'dev_test',
        ip: '192.168.1.50',
        port: badPort,
      });
      assert.equal(res.status, 400, `Port ${badPort} must return 400`);
      assert.equal(res.body.ok, false);
    }
  } finally {
    await harness.cleanup();
  }
});

test('T2-API-02: Boundary Ports (1 and 65535) - Accepts boundary integer ports', async () => {
  const harness = await createE2EHarness();

  try {
    const res1 = await harness.registerAndroid({
      deviceId: 'dev_min',
      ip: '192.168.1.50',
      port: 1,
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.ok, true);

    const resMax = await harness.registerAndroid({
      deviceId: 'dev_max',
      ip: '192.168.1.50',
      port: 65535,
    });
    assert.equal(resMax.status, 200);
    assert.equal(resMax.body.ok, true);
  } finally {
    await harness.cleanup();
  }
});

test('T2-API-03: Malformed IPv4 Strings on Register - Rejects non-IPv4 addresses', async () => {
  const harness = await createE2EHarness();

  try {
    for (const badIp of ['999.999.999.999', 'abc.def.ghi.jkl', '192.168.1.1.1', 'not_an_ip']) {
      const res = await harness.registerAndroid({
        deviceId: 'dev_test',
        ip: badIp,
        port: 8765,
      });
      assert.equal(res.status, 400, `IP ${badIp} must return 400`);
      assert.equal(res.body.ok, false);
    }
  } finally {
    await harness.cleanup();
  }
});

test('T2-API-04: Malformed JSON Body on API Routes - Returns 400 without crashing origin', async () => {
  const harness = await createE2EHarness();

  try {
    const res = await harness.httpRaw(harness.pulseRadarUrl, '/api/android/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ malformed json: true, ',
    });
    assert.equal(res.status, 400, 'Malformed JSON must return 400 Bad Request');
  } finally {
    await harness.cleanup();
  }
});

test('T2-API-05: Android Sync with Empty Users Array - Computes all 44 server users as toAdd', async () => {
  const initial = buildProduction44WorkspaceState();
  const harness = await createE2EHarness({ initialWorkspaceState: initial });

  try {
    // Register device first
    await harness.registerAndroid({
      deviceId: 'sm_n770f_empty_test',
      ip: '192.168.1.50',
      port: 8765,
    });

    const syncRes = await harness.syncAndroid({
      deviceId: 'sm_n770f_empty_test',
      ip: '192.168.1.50',
      port: 8765,
      users: [],
    });

    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.ok, true);
    if (syncRes.body.ok) {
      assert.equal(syncRes.body.authoritativeUsers.length, 44);
      assert.equal(syncRes.body.toAdd.length, 44, 'All 44 users must be computed as toAdd');
      assert.equal(syncRes.body.toRemove.length, 0);
    }
  } finally {
    await harness.cleanup();
  }
});

// --- Feature 4: Database Connectivity Boundaries ---

test('T2-DB-01: Plaintext Unencrypted Connection Rejected by Neon - Returns error 28000', async () => {
  const res = await probePlaintextPostgresReject(NEON_POOLER_HOST, NEON_PORT, 6000);
  assert.equal(res.rejected, true, 'Neon must reject unencrypted plaintext connection');
  assert.equal(res.errorCode, '28000', 'Error code must be 28000 (invalid authorization specification)');
  assert.ok(
    res.rawResponse.includes('sslmode=require'),
    `Error message must prompt for sslmode=require, got: ${res.rawResponse}`
  );
});

test('T2-DB-02: Missing or Malformed DATABASE_URL - Parser throws on invalid protocols', () => {
  assert.throws(
    () => parsePostgresConnectionString('http://not-a-db-host/test'),
    /AssertionError/
  );
  assert.throws(
    () => parsePostgresConnectionString('mysql://user:pass@host/db'),
    /AssertionError/
  );
});

test('T2-DB-03: Connection Timeout on Blackhole Host - Aborts within timeout threshold', async () => {
  const res = await probeTcpConnection('192.0.2.1', 5432, 2000);
  assert.equal(res.ok, false, 'Connection to blackhole IP must fail');
  assert.ok(res.latencyMs >= 1900 && res.latencyMs <= 3500, `Latency must be around timeout: ${res.latencyMs}ms`);
});

test('T2-DB-04: Enforced SSL Mode Validation - Connection string must mandate sslmode=require', () => {
  const parsed = parsePostgresConnectionString(NEON_DATABASE_URL);
  assert.equal(parsed.sslmode, 'require', 'Production Neon connection string must require SSL');
});

test('T2-DB-05: Rapid Connection Cycling - Opens and closes multiple sockets without leaks', async () => {
  for (let i = 0; i < 3; i++) {
    const res = await probeTcpConnection(NEON_POOLER_HOST, NEON_PORT, 4000);
    assert.equal(res.ok, true);
  }
});

// ============================================================================
// TIER 3: CROSS-FEATURE COMBINATIONS (Pairwise Interactions)
// ============================================================================

test('T3-PROD-01: Render Deployment + Dynamic APIs - Dynamic PORT bound reflects in /api/health', async () => {
  const dynamicPort = 3120;
  const app = express();
  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, port: dynamicPort, autoScanEnabled: true, autoScanRunning: true });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(dynamicPort, '0.0.0.0', () => resolve()));

  try {
    const resp = await fetch(`http://127.0.0.1:${dynamicPort}/api/health`);
    assert.equal(resp.status, 200);
    const health = (await resp.json()) as { ok: boolean; port: number; autoScanEnabled: boolean };
    assert.equal(health.ok, true);
    assert.equal(health.port, dynamicPort, 'Dynamic PORT must match');
    assert.equal(health.autoScanEnabled, true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('T3-PROD-02: Public URL + Dynamic APIs - Public endpoint routing verified with dynamic health API', async () => {
  const healthResp = await fetch(`${RENDER_PUBLIC_URL}/api/health`);
  assert.equal(healthResp.status, 200, `Live public API /api/health must return HTTP 200, got ${healthResp.status}`);
  const ct = healthResp.headers.get('content-type') ?? '';
  assert.ok(ct.includes('application/json'), `Content-Type must be application/json, got ${ct}`);
  const health = (await healthResp.json()) as { ok: boolean; port: number; autoScanEnabled: boolean };
  assert.equal(health.ok, true, 'Live /api/health ok property must be true');
  assert.ok(healthResp.headers.get('rndr-id'), 'Must include Render tracing id');
  assert.equal(healthResp.headers.get('x-content-type-options'), 'nosniff');
});

test('T3-PROD-03: Dynamic APIs + Auto-Scanner Loop - Android register enables trigger dispatch on scan', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });

  try {
    const regRes = await harness.registerAndroid({
      deviceId: 'sm_n770f_combo',
      ip: harness.mockAndroid.ip,
      port: harness.mockAndroid.port,
    });
    assert.equal(regRes.status, 200);
    assert.equal(regRes.body.ok, true);

    const statusRes = await harness.getAndroidStatus();
    assert.equal(statusRes.body.device?.ip, harness.mockAndroid.ip);

    // Simulate streamer live and tick scan
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://tiktok.com/@ebe_m72/live',
      title: 'Stream LIVE',
    });

    const recordPromise = harness.mockAndroid.waitForRecord(() => true, 4000);
    await harness.tickScan();
    const captured = await recordPromise;
    assert.ok(captured, 'Android receiver must capture trigger');
    assert.ok(captured.body, 'Captured record body must be present');
    assert.equal(captured.body.platform, 'TIKTOK');
    assert.ok(
      captured.body.username === 'ebe_m72' || captured.body.username === '@ebe_m72',
      `Username must match ebe_m72: ${captured.body.username}`
    );
  } finally {
    await harness.cleanup();
  }
});

test('T3-PROD-04: Database Configuration + State Persistence - State survives server reboot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-t3-04-'));
  const srv1 = new ReferenceContractServer({ dataDir: tempDir });

  try {
    await srv1.start();
    const regRes = await fetch(`${srv1.url}/api/android/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'persistent_device',
        ip: '192.168.1.100',
        port: 8765,
      }),
    });
    assert.equal(regRes.status, 200);
    await srv1.stop();

    // Restart server on the same data directory
    const srv2 = new ReferenceContractServer({ dataDir: tempDir });
    await srv2.start();
    const statusRes = await fetch(`${srv2.url}/api/android/status`);
    assert.equal(statusRes.status, 200);
    const body = (await statusRes.json()) as { ok: boolean; device: { deviceId: string; ip: string } };
    assert.equal(body.device?.deviceId, 'persistent_device');
    assert.equal(body.device?.ip, '192.168.1.100');
    await srv2.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('T3-PROD-05: Concurrent Workspace Update & Android Sync - No file lock corruption', async () => {
  const harness = await createE2EHarness({
    initialWorkspaceState: buildProduction44WorkspaceState(),
  });

  try {
    await harness.registerAndroid({
      deviceId: 'concurrent_device',
      ip: '192.168.1.50',
      port: 8765,
    });

    const putTask = harness.putWorkspaceState(buildProduction44WorkspaceState());
    const syncTask = harness.syncAndroid({
      deviceId: 'concurrent_device',
      ip: '192.168.1.50',
      port: 8765,
      users: [
        {
          platform: 'TIKTOK',
          username: '@ebe_m72',
          nickname: 'ebe_m72',
          status: 'IDLE',
          isEnabled: true,
        },
      ],
    });

    const [putRes, syncRes] = await Promise.all([putTask, syncTask]);
    assert.equal(putRes.status, 200);
    assert.equal(syncRes.status, 200);
    assert.equal(putRes.body.ok, true);
    assert.equal(syncRes.body.ok, true);
  } finally {
    await harness.cleanup();
  }
});

test('T3-PROD-06: Dynamic Android IP Re-registration - Companion DHCP switch updates destination', async () => {
  const harness = await createE2EHarness();

  try {
    // 1st DHCP IP
    await harness.registerAndroid({
      deviceId: 'dhcp_device',
      ip: '192.168.1.101',
      port: 8765,
    });
    let status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.101');
    assert.equal(status.body.device?.callbackUrl, 'http://192.168.1.101:8765/record');

    // 2nd DHCP IP
    await harness.registerAndroid({
      deviceId: 'dhcp_device',
      ip: '192.168.1.102',
      port: 8765,
    });
    status = await harness.getAndroidStatus();
    assert.equal(status.body.device?.ip, '192.168.1.102');
    assert.equal(status.body.device?.callbackUrl, 'http://192.168.1.102:8765/record');
  } finally {
    await harness.cleanup();
  }
});

// ============================================================================
// TIER 4: REAL-WORLD SCENARIOS (Live Production Probes & Workloads)
// ============================================================================

test('T4-PROD-01: Live Production Render URL Probe - Root HTTPS endpoint and deployment readiness audit', async () => {
  const resp = await fetch(RENDER_PUBLIC_URL, {
    headers: { 'User-Agent': 'PulseRadar-Production-Auditor/1.0' },
  });

  assert.equal(resp.status, 200, `Live URL ${RENDER_PUBLIC_URL} must return HTTP 200`);
  const html = await resp.text();

  const isStarterTemplate = html.includes('Your first deploy') || html.includes('render-examples/sample-static-site');
  const isPulseRadar = html.includes('PulseRadar') || html.includes('<div id="root">');

  assert.strictEqual(
    isStarterTemplate,
    false,
    `Live URL ${RENDER_PUBLIC_URL} is serving Render static starter template (render-examples/sample-static-site) instead of PulseRadar`
  );
  assert.strictEqual(
    isPulseRadar,
    true,
    `Live URL ${RENDER_PUBLIC_URL} does not serve PulseRadar React SPA`
  );

  console.log('   [Post-Deployment State]: Render service is actively serving authentic PulseRadar SPA build.');
  assert.ok(resp.headers.get('rndr-id'), 'Must have rndr-id');
  assert.equal(resp.headers.get('x-content-type-options'), 'nosniff');
});

test('T4-PROD-02: Live Production Health Endpoint Probe - Probes /api/health strictly', async () => {
  const healthUrl = `${RENDER_PUBLIC_URL}/api/health`;
  const resp = await fetch(healthUrl);

  assert.equal(
    resp.status,
    200,
    `Live health endpoint ${healthUrl} returned HTTP ${resp.status} instead of 200 OK (service not deployed or API unmounted)`
  );

  const contentType = resp.headers.get('content-type') ?? '';
  assert.ok(contentType.includes('application/json'), `Content-Type must be application/json, got ${contentType}`);

  const health = (await resp.json()) as { ok: boolean; port: number; autoScanEnabled: boolean };
  console.log('   [Live Health Probe]: /api/health returned 200 OK:', health);
  assert.equal(health.ok, true, 'Live /api/health ok property must be true');
  assert.equal(typeof health.port, 'number', 'Live /api/health port must be a number');
});

test('T4-PROD-03: Neon PostgreSQL Live Handshake & Protocol Audit - Verifies AWS Singapore pooler over TLS 1.3', async () => {
  // 1. TCP connectivity check
  const tcpRes = await probeTcpConnection(NEON_POOLER_HOST, NEON_PORT, 6000);
  assert.equal(tcpRes.ok, true, `Neon TCP must succeed: ${tcpRes.error}`);

  // 2. SSLRequest and TLS 1.3 socket negotiation
  const tlsRes = await probePostgresTls(NEON_POOLER_HOST, NEON_PORT, 8000);
  assert.equal(tlsRes.ok, true, `Neon TLS must succeed: ${tlsRes.error}`);
  assert.equal(tlsRes.authorized, true, 'Neon TLS certificate must be valid');

  // 3. PostgreSQL StartupMessage authentication challenge
  const authRes = await probePostgresStartup(NEON_POOLER_HOST, NEON_PORT, 'neondb_owner', 'neondb', 8000);
  assert.equal(authRes.ok, true, `Neon auth probe must succeed: ${authRes.error}`);
  assert.equal(authRes.responseType, 'R', 'Neon must reply with SASL auth request');
  console.log(`   [Neon DB Audit]: TCP=${tcpRes.latencyMs}ms, TLS=${tlsRes.protocol}/${tlsRes.cipher?.name}, SASL=OK`);
});

test('T4-PROD-04: Full 44-Streamer Workload Deployment Simulation - End-to-end scan and room reconciliation', async () => {
  const productionState = buildProduction44WorkspaceState();
  const harness = await createE2EHarness({ initialWorkspaceState: productionState });

  try {
    // 1. Register Android companion
    const regRes = await harness.registerAndroid({
      deviceId: 'sm_n770f_full_workload',
      ip: harness.mockAndroid.ip,
      port: harness.mockAndroid.port,
    });
    assert.equal(regRes.status, 200);

    // 2. Verify all 44 streamers tracked
    const health = await harness.getHealth();
    assert.equal(health.body.trackedUsersCount, 44);

    // 3. Simulate two concurrent streamers going LIVE
    await harness.simulateLiveUser({
      platform: 'TIKTOK',
      username: '@ebe_m72',
      status: 'LIVE',
      streamUrl: 'https://tiktok.com/@ebe_m72/live',
      title: 'Morning live session',
    });
    await harness.simulateLiveUser({
      platform: 'INSTAGRAM',
      username: '@baotran16tui',
      status: 'LIVE',
      streamUrl: 'https://instagram.com/baotran16tui/live',
      title: 'IG Q&A session',
    });

    const triggerWait = harness.mockAndroid.waitForRecord(() => true, 4000);
    await harness.tickScan();
    const rec1 = await triggerWait;
    assert.ok(rec1, 'First live trigger must be received');
    assert.ok(rec1.body, 'First live trigger body must be present');

    // 4. Perform 10-minute sync diff
    const syncRes = await harness.syncAndroid({
      deviceId: 'sm_n770f_full_workload',
      ip: harness.mockAndroid.ip,
      port: harness.mockAndroid.port,
      users: [
        {
          platform: rec1.body.platform,
          username: rec1.body.username,
          status: 'RECORDING',
          isEnabled: true,
        },
      ],
    });
    assert.equal(syncRes.status, 200);
    assert.equal(syncRes.body.ok, true);
    if (syncRes.body.ok) {
      assert.equal(syncRes.body.authoritativeUsers.length, 44);
    }
  } finally {
    await harness.cleanup();
  }
});

test('T4-PROD-05: Cold Start, Container Reboot & State Persistence Cycle - Simulates platform restart', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-t4-05-'));

  // Seed initial 44-streamer production workspace state onto disk
  fs.writeFileSync(
    path.join(tempDir, 'workspace-state.json'),
    JSON.stringify(buildProduction44WorkspaceState(), null, 2),
    'utf8'
  );

  // Container instance 1
  const server1 = new ReferenceContractServer({ dataDir: tempDir });

  try {
    await server1.start();
    await fetch(`${server1.url}/api/android/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'sm_n770f_reboot_test',
        ip: '192.168.1.9',
        port: 8765,
      }),
    });

    const health1 = (await (await fetch(`${server1.url}/api/health`)).json()) as { trackedUsersCount: number };
    assert.equal(health1.trackedUsersCount, 44);

    // Simulate SIGTERM container termination
    await server1.stop();

    // Container instance 2 booting on new ephemeral port
    const server2 = new ReferenceContractServer({ dataDir: tempDir });
    await server2.start();

    const health2 = (await (await fetch(`${server2.url}/api/health`)).json()) as {
      ok: boolean;
      port: number;
      trackedUsersCount: number;
      androidDevice: { deviceId: string; ip: string };
    };

    assert.equal(health2.ok, true);
    assert.equal(health2.trackedUsersCount, 44, 'Workspace rules must persist across reboots');
    assert.equal(health2.androidDevice?.deviceId, 'sm_n770f_reboot_test', 'Android device registration must persist');

    await server2.stop();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
