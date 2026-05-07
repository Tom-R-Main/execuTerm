import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

function requireCommand(command: string, args: string[] = []): string {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch (error) {
    throw new Error(`${command} ${args.join(' ')} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function postJson(url: string, token: string, body: unknown): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-execuTerm-Dashboard-Token': token,
    },
    body: JSON.stringify(body),
  });
  const parsed = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`POST ${url} failed ${response.status}: ${JSON.stringify(parsed)}`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const codexPath = requireCommand('sh', ['-lc', 'command -v codex']);
  const codexVersion = requireCommand('codex', ['--version']);
  const sandbox = mkdtempSync(join(tmpdir(), 'executerm-codex-smoke-'));
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({
    scripts: {
      build: 'node -e "process.exit(0)"',
      test: 'node -e "process.exit(0)"',
    },
  }, null, 2));
  writeFileSync(join(sandbox, 'README.md'), 'execuTerm Codex smoke sandbox\n');

  const dashboardUrl = process.env.EXECUTERM_DASHBOARD_URL;
  const dashboardToken = process.env.EXECUTERM_DASHBOARD_TOKEN;
  const taskId = process.env.EXECUTERM_SMOKE_TASK_ID;

  console.log(JSON.stringify({
    ok: true,
    codexPath,
    codexVersion,
    sandbox,
    expectedCommandShape: 'codex "$(cat <prompt-file>)"',
    dispatchReady: Boolean(dashboardUrl && dashboardToken && taskId),
  }, null, 2));

  if (dashboardUrl && dashboardToken && taskId) {
    const result = await postJson(
      `${dashboardUrl.replace(/\/$/, '')}/api/dispatch`,
      dashboardToken,
      { taskId, agentType: 'codex' }
    );
    console.log(JSON.stringify({ dispatched: true, result }, null, 2));
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
