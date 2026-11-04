import { InvalidArgumentError } from '@narrative-studio/contracts';
import { startStudioServer } from '../studio/server.js';
import type { CliContext } from '../context.js';
import { flagBool, optionalNumber, requireFlag, type ParsedArgs } from '../flags.js';
import { openStudioBrowser } from '../studio/open-browser.js';
import type { CommandResult } from './types.js';

export async function commandStudio(args: ParsedArgs, context: CliContext): Promise<CommandResult> {
  const vaultDir = requireFlag(args, 'vault');
  const port = optionalNumber(args, 'port') ?? 0;
  if (port < 0 || port > 65535) throw new InvalidArgumentError('--port must be 0-65535');
  const server = await startStudioServer({
    vaultDir,
    projectId: context.projectId,
    appDataRoot: context.appDataRoot,
    port,
    logger: context.logger,
  });

  const startup = {
    ok: true,
    url: server.url,
    port: server.port,
    project_id: server.projectId,
    note: 'Local-only studio. Open the URL in this machine’s browser. Ctrl+C stops the server.',
  };
  if (context.json) process.stdout.write(`${JSON.stringify(startup)}\n`);
  else {
    process.stdout.write(`Narrative Studio is running at:\n  ${server.url}\n`);
    process.stdout.write(`Project: ${server.projectId}\nCtrl+C stops the local server.\n`);
  }
  if (flagBool(args, 'open') && process.platform === 'win32') {
    void openStudioBrowser(server.url).catch(() => {
      process.stderr.write('浏览器未能自动打开。请复制上方完整网址到浏览器；保持此服务窗口运行。\n');
    });
  }

  await new Promise<void>((resolve) => {
    const stop = (): void => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  await server.close();

  return {
    data: { ok: true, stopped: true, port: server.port },
    human: ['Studio server stopped.'],
  };
}
