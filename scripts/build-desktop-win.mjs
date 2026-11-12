#!/usr/bin/env node
/**
 * build-desktop-win.mjs — Dedicated Windows Desktop Packager for LearnHarness.
 *
 * Produces:
 *   - dist/LearnHarness-0.4.1-x64-setup.exe (NSIS 1-click installer)
 *   - Or unpacked application directory via --dir
 *
 * Steps:
 *   1. Clean dist/ and .next/standalone
 *   2. Build plugins & Next.js in standalone mode
 *   4. Curate server standalone payload (scripts/build-server.mjs)
 *   5. Smoke-test standalone server boot (scripts/smoke-server.mjs)
 *   6. Package Windows desktop app with electron-builder
 */

import { rmSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT_DIR = resolve(import.meta.dirname, '..');
const DIST_DIR = join(ROOT_DIR, 'dist');
const STANDALONE_DIR = join(ROOT_DIR, '.next', 'standalone');

const NEXT_CLI = require.resolve('next/dist/bin/next');
const BUILDER_CLI = require.resolve('electron-builder/cli.js');

const args = process.argv.slice(2);
const IS_DIR_ONLY = args.includes('--dir');
const SKIP_BUILD = args.includes('--skip-build');
const IS_PUBLISH = args.includes('--publish');

function logStep(step, message) {
  console.log(`\n======================================================`);
  console.log(`  [Windows Desktop Build] Step ${step}: ${message}`);
  console.log(`======================================================\n`);
}

function runNode(scriptPath, cmdArgs = [], envExtra = {}) {
  const relativeScript = scriptPath.startsWith(ROOT_DIR)
    ? scriptPath.replace(ROOT_DIR, '').replace(/^[\\/]/, '')
    : scriptPath;

  console.log(`> node ${relativeScript} ${cmdArgs.join(' ')}`);
  const res = spawnSync(process.execPath, [scriptPath, ...cmdArgs], {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      ...envExtra,
    },
    windowsHide: true,
  });

  if (res.status !== 0) {
    console.error(`\n❌ Step failed with exit code ${res.status}: ${relativeScript} ${cmdArgs.join(' ')}`);
    process.exit(res.status ?? 1);
  }
}

// 1. Clean previous build artifacts
logStep('1/6', 'Cleaning previous build directories...');
if (existsSync(DIST_DIR)) {
  console.log(`Removing ${DIST_DIR}...`);
  rmSync(DIST_DIR, { recursive: true, force: true });
}
if (existsSync(STANDALONE_DIR)) {
  console.log(`Removing ${STANDALONE_DIR}...`);
  rmSync(STANDALONE_DIR, { recursive: true, force: true });
}
console.log('Clean complete.');

// 2. Next.js standalone build
if (SKIP_BUILD && existsSync(join(STANDALONE_DIR, 'server.js'))) {
  logStep('2/6', 'Skipping Next.js build (--skip-build set and server.js exists)');
} else {
  logStep('2/6', 'Building plugins and Next.js application (standalone)...');
  runNode(join(ROOT_DIR, 'scripts', 'build-core-plugins.mjs'));
  runNode(join(ROOT_DIR, 'scripts', 'build-plugin-authoring.mjs'));
  runNode(NEXT_CLI, ['build']);
}

// 3. Smoke check provider runtime
logStep('3/6', 'Smoke checking provider runtime...');
runNode(join(ROOT_DIR, 'scripts', 'smoke-provider-runtime.mjs'));

// 4. Curate standalone server payload
logStep('4/6', 'Curating standalone server payload...');
runNode(join(ROOT_DIR, 'scripts', 'build-server.mjs'));

// 5. Smoke check standalone server
logStep('5/6', 'Smoke booting packaged server...');
runNode(join(ROOT_DIR, 'scripts', 'smoke-server.mjs'));

// 6. Electron-builder packaging for Windows
logStep('6/6', `Packaging Windows desktop app (${IS_DIR_ONLY ? 'unpacked directory' : 'NSIS setup installer'})...`);

const builderArgs = ['--win', '--x64'];
if (IS_DIR_ONLY) {
  builderArgs.push('--dir');
}
if (IS_PUBLISH) {
  builderArgs.push('--publish', 'always', '-c.publish.releaseType=release');
}

runNode(BUILDER_CLI, builderArgs);

console.log(`\n======================================================`);
console.log(`  🎉 Windows Desktop App Build Completed Successfully!`);
console.log(`  Output artifacts located in: ${DIST_DIR}`);
console.log(`======================================================\n`);
