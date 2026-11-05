/**
 * Force a WebGL context loss under SwiftShader and check the camera survives
 * recreateViewer(). The same check runs in the unit suite.
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  process.execPath,
  ['--test', 'src/app/webglRecovery.browser.test.mjs'],
  { cwd: root, stdio: 'inherit' },
);
process.exit(result.status ?? 1);
