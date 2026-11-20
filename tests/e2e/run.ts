import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

interface TierDefinition {
  id: '1' | '2' | '3' | '4' | 'server' | 'android' | 'prod';
  label: string;
  files: string[];
}

interface TapCounts {
  tests: number;
  pass: number;
  fail: number;
  skipped: number;
}

const repoRoot = path.resolve(import.meta.dirname, '..', '..');

function withOptionalFiles(requiredFiles: string[], optionalFiles: string[]): string[] {
  const existingOptional = optionalFiles.filter((file) =>
    fs.existsSync(path.resolve(repoRoot, file))
  );
  return [...requiredFiles, ...existingOptional];
}

const ALL_TIERS: TierDefinition[] = [
  {
    id: '1',
    label: 'Tier 1 (Feature Coverage)',
    files: withOptionalFiles(
      ['tests/e2e/tier1-features.test.ts'],
      ['tests/e2e/tier1-r1r2r3.test.ts']
    ),
  },
  {
    id: '2',
    label: 'Tier 2 (Boundary & Corner Cases)',
    files: withOptionalFiles(
      ['tests/e2e/tier2-boundaries.test.ts'],
      ['tests/e2e/tier2-r1r2r3.test.ts']
    ),
  },
  {
    id: '3',
    label: 'Tier 3 (Cross-Feature Combinations)',
    files: withOptionalFiles(
      ['tests/e2e/tier3-combinations.test.ts'],
      ['tests/e2e/tier3-r1r2r3.test.ts']
    ),
  },
  {
    id: '4',
    label: 'Tier 4 (Real-World Scenarios)',
    files: withOptionalFiles(
      ['tests/e2e/tier4-scenarios.test.ts'],
      ['tests/e2e/tier4-r1r2r3.test.ts']
    ),
  },
  {
    id: 'server',
    label: 'Server Integration (Access Control & Media Downloader)',
    files: ['tests/e2e/accessControl.test.ts', 'tests/e2e/mediaDownloader.test.ts'],
  },
  {
    id: 'android',
    label: 'Android Contract & Source Invariants',
    files: [
      'tests/e2e/androidContract.test.ts',
      'tests/e2e/androidSourceInvariants.test.ts',
    ],
  },
  {
    id: 'prod',
    label: 'Production Deployment & Cloud Infrastructure',
    files: ['tests/e2e/productionDeployment.test.ts'],
  },
];

function printUsage(): void {
  console.log(
    [
      'PulseRadar <-> StreamRecorder E2E Test Runner',
      '',
      'Usage:',
      '  node --import tsx tests/e2e/run.ts [--tier 1|2|3|4|server|android|prod|all] [--help]',
      '',
      'Options:',
      '  --tier <list>   Comma-separated tiers to run: 1, 2, 3, 4, server, android, prod, all',
      '                  (default: all = local deterministic tiers 1,2,3,4,server,android; prod runs explicitly)',
      '  --help, -h      Show this help message',
      '',
      'Environment:',
      '  E2E_PULSE_RADAR_URL          Target live PulseRadar base URL (default: Self-Test ReferenceContractServer)',
      '  E2E_ANDROID_URL              Target live Android HTTP URL (default: MockAndroidReceiver)',
      '  E2E_ANDROID_ALLOW_LIVE_RECORD=1  Allow mutating POST /record in live Android mode',
      '  E2E_CHECK_ANDROID_SOURCE=1   Enable static Kotlin/XML/Gradle invariant checks',
      '  E2E_RUN_REPO_BUILDS=1        Enable repo-wide npm build / npm test / Gradle subprocess checks',
    ].join('\n')
  );
}

function parseArgs(argv: string[]): { help: boolean; tiers: TierDefinition[] } | null {
  let tierSpec = 'all';
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--tier') {
      const next = argv[i + 1];
      if (!next || next.startsWith('-')) {
        console.error('Error: --tier requires a value (1|2|3|4|server|android|prod|all)');
        return null;
      }
      tierSpec = next;
      i += 1;
      continue;
    }
    if (arg.startsWith('--tier=')) {
      tierSpec = arg.slice('--tier='.length);
      continue;
    }
    console.error(`Error: Unknown argument "${arg}"`);
    return null;
  }

  if (help) {
    return { help: true, tiers: [] };
  }

  const tokens = tierSpec
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) {
    console.error('Error: Empty --tier value');
    return null;
  }

  if (tokens.includes('all')) {
    return { help: false, tiers: ALL_TIERS.filter((t) => t.id !== 'prod') };
  }

  const selected: TierDefinition[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    const found = ALL_TIERS.find((t) => t.id === tok);
    if (!found) {
      console.error(`Error: Invalid tier "${tok}". Expected one of: 1, 2, 3, 4, server, android, prod, all`);
      return null;
    }
    if (!seen.has(found.id)) {
      seen.add(found.id);
      selected.push(found);
    }
  }

  return { help: false, tiers: selected };
}

function parseTapCounts(tapText: string): TapCounts {
  const matchStat = (label: string): number => {
    const re = new RegExp(`^#\\s+${label}\\s+(\\d+)\\s*$`, 'gm');
    let last: number | null = null;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tapText)) !== null) {
      last = Number(m[1]);
    }
    return last ?? 0;
  };
  return {
    tests: matchStat('tests'),
    pass: matchStat('pass'),
    fail: matchStat('fail'),
    skipped: matchStat('skipped'),
  };
}

async function runTierProcess(
  tier: TierDefinition,
  cwd: string
): Promise<{ exitCode: number; counts: TapCounts }> {
  const tmpTapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pulseradar-tap-'));
  const tapPath = path.join(tmpTapDir, `tier-${tier.id}.tap`);

  try {
    const args = [
      '--import',
      'tsx',
      '--test',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=tap',
      `--test-reporter-destination=${tapPath}`,
      ...tier.files,
    ];

    const repoLocalStreamRecorderRoot = path.resolve(cwd, 'StreamRecorder_Android');
    const parentStreamRecorderRoot = path.resolve(cwd, '..', 'StreamRecorder_Android');
    const defaultStreamRecorderRoot = fs.existsSync(repoLocalStreamRecorderRoot)
      ? repoLocalStreamRecorderRoot
      : parentStreamRecorderRoot;
    const childEnv = {
      ...process.env,
      E2E_STREAM_RECORDER_ROOT:
        process.env.E2E_STREAM_RECORDER_ROOT ??
        (fs.existsSync(defaultStreamRecorderRoot) ? defaultStreamRecorderRoot : undefined),
    };

    const exitCode = await new Promise<number>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        cwd,
        stdio: 'inherit',
        shell: false,
        env: childEnv,
      });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (signal) {
          resolve(1);
        } else {
          resolve(code ?? 1);
        }
      });
    });

    const tapContent = fs.existsSync(tapPath) ? fs.readFileSync(tapPath, 'utf8') : '';
    const counts = parseTapCounts(tapContent);
    return { exitCode, counts };
  } finally {
    if (fs.existsSync(tmpTapDir)) {
      fs.rmSync(tmpTapDir, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    printUsage();
    process.exit(2);
  }
  if (parsed.help) {
    printUsage();
    process.exit(0);
  }

  const results: Array<{ tier: TierDefinition; exitCode: number; counts: TapCounts }> = [];

  for (const tier of parsed.tiers) {
    console.log(`\n=== Running ${tier.label} ===`);
    const res = await runTierProcess(tier, repoRoot);
    results.push({ tier, ...res });
  }

  console.log('\n=== E2E Summary ===');
  let totalTests = 0;
  let totalPass = 0;
  let totalFail = 0;
  let totalSkipped = 0;
  let anyFailure = false;

  for (const r of results) {
    totalTests += r.counts.tests;
    totalPass += r.counts.pass;
    totalFail += r.counts.fail;
    totalSkipped += r.counts.skipped;
    if (r.exitCode !== 0 || r.counts.fail > 0) {
      anyFailure = true;
    }
    console.log(
      `${r.tier.label}: tests=${r.counts.tests} pass=${r.counts.pass} fail=${r.counts.fail} skipped=${r.counts.skipped} (exit=${r.exitCode})`
    );
  }

  console.log(
    `TOTAL: tests=${totalTests} pass=${totalPass} fail=${totalFail} skipped=${totalSkipped}`
  );
  process.exit(anyFailure ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
