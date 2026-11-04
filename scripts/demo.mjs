import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const cli = join(root, 'apps/cli/dist/main.js');
const workspace = await mkdtemp(join(tmpdir(), 'narrative-studio-demo-'));
const vault = join(workspace, 'vault');
const appdata = join(workspace, 'runtime');
const env = Object.fromEntries(
  Object.entries(process.env).filter(([name]) => !/^(NS_|DEEPSEEK_)/i.test(name)),
);

const imported = JSON.parse(execFileSync(process.execPath, [
  cli, 'import', '--vault', vault, '--appdata', appdata, '--title', '末班车没有到站',
  '--file', join(root, 'examples/last-train.md'), '--json',
], { cwd: root, env, encoding: 'utf8', windowsHide: true }));

for (const name of Object.keys(process.env)) {
  if (/^(NS_|DEEPSEEK_)/i.test(name)) delete process.env[name];
}
const { startStudioServer } = await import('../apps/cli/dist/studio/server.js');
const server = await startStudioServer({
  vaultDir: vault,
  projectId: imported.project_id,
  appDataRoot: appdata,
  distDir: join(root, 'apps/studio/dist'),
});
console.log('Offline demo. Open this temporary local URL in your browser:');
console.log(server.url);
console.log('Demo files:', workspace);
console.log('Press Ctrl+C to stop. Each run creates a fresh demo workspace.');
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void server.close(); });
}
