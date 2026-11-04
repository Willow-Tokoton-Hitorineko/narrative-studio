import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {
  CLI_PATH,
  REPO_ROOT,
  addChapter,
  createWorkspace,
  initVault,
  type Workspace,
} from '../helpers/cli.js';

interface Boot {
  project: { project_id: string; title: string };
  manifest: { revision: string };
  chapters: { chapter_id: string; title: string; word_count: number }[];
  projection: { status: string };
}

interface Saved {
  revision: { revision_id: string; content_hash: string };
  manifest_revision: string;
  projection: { status: string };
}

let workspace: Workspace;
let child: ReturnType<typeof spawn>;
let base: string;
let token: string;
let bootstrap: Boot;
let chapterId: string;

function waitForLine(stream: NodeJS.ReadableStream, timeoutMs = 20_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for studio startup')), timeoutMs);
    const lines = readline.createInterface({ input: stream });
    lines.once('line', (line) => {
      clearTimeout(timer);
      lines.close();
      resolve(line);
    });
  });
}

async function request(
  route: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string>; auth?: string | null } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    origin: base,
    'x-ns-request': 'studio',
    ...(options.headers ?? {}),
  };
  const auth = options.auth === undefined ? token : options.auth;
  if (auth) headers['x-ns-studio-token'] = auth;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${route}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

beforeAll(async () => {
  workspace = createWorkspace({ label: 'ns-studio-api' });
  initVault(workspace, '工作台测试');
  addChapter(workspace, { title: '第一章 潮声', text: '第一段。\n\n第二段。\n' });
  const dist = path.join(workspace.root, 'studio-dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><title>test</title>', 'utf8');
  child = spawn(
    process.execPath,
    [CLI_PATH, 'studio', '--vault', workspace.vault, '--appdata', workspace.appdata, '--port', '0', '--json'],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, NS_LOG_LEVEL: 'silent', NODE_ENV: 'test', NS_STUDIO_DIST: dist },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const line = await waitForLine(child.stdout!);
  const startup = JSON.parse(line) as { url: string; port: number; project_id: string };
  const parsed = new URL(startup.url);
  token = parsed.searchParams.get('token')!;
  base = `http://127.0.0.1:${startup.port}`;
  const response = await request('/api/bootstrap');
  expect(response.status).toBe(200);
  bootstrap = await json<Boot>(response);
  chapterId = bootstrap.chapters[0]!.chapter_id;
});

afterAll(async () => {
  if (child) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve();
      }, 3000);
      child.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
  workspace?.cleanup();
});

describe('studio local service', () => {
  it('requires the session token for API access', async () => {
    const noToken = await request('/api/bootstrap', { auth: null });
    expect(noToken.status).toBe(401);
    const badToken = await request('/api/bootstrap', { auth: 'wrong-token' });
    expect(badToken.status).toBe(401);
  });

  it('sets an HttpOnly SameSite cookie only for the one-time token URL', async () => {
    const response = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    expect(response.status).toBe(302);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('ns_studio=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(response.headers.get('location')).toBe('/studio/');
    const withCookie = await fetch(`${base}/api/bootstrap`, {
      headers: { cookie: cookie.split(';')[0]! },
    });
    expect(withCookie.status).toBe(200);
  });

  it('rejects mutations without Origin or the studio header', async () => {
    const body = { content: 'x', baseRevision: bootstrap.manifest.revision };
    const noHeader = await request(`/api/chapter/${chapterId}/save`, {
      method: 'POST',
      body,
      headers: { 'x-ns-request': '' },
    });
    expect(noHeader.status).toBe(403);
    const wrongOrigin = await request(`/api/chapter/${chapterId}/save`, {
      method: 'POST',
      body,
      headers: { origin: 'http://evil.example' },
    });
    expect(wrongOrigin.status).toBe(403);
  });

  it('saves with CAS and rebuilds the SQLite projection', async () => {
    const before = await request(`/api/chapter/${chapterId}`);
    const current = await json<{ content: string; manifest_revision: string; chapter: { current_revision_id: string } }>(before);
    const saved = await request(`/api/chapter/${chapterId}/save`, {
      method: 'POST',
      body: {
        content: `${current.content}\n工作台新增一行。\n`,
        baseRevision: current.manifest_revision,
        message: 'studio api test',
      },
    });
    expect(saved.status).toBe(200);
    const result = await json<Saved>(saved);
    expect(result.revision.revision_id).not.toBe(current.chapter.current_revision_id);
    expect(result.manifest_revision).not.toBe(current.manifest_revision);
    expect(result.projection.status).toBe('current');
    const after = await json<Boot>(await request('/api/bootstrap'));
    expect(after.manifest.revision).toBe(result.manifest_revision);
    expect(after.projection.status).toBe('current');
  });

  it('returns 409 when a stale base revision would overwrite a newer save', async () => {
    const stale = await request(`/api/chapter/${chapterId}/save`, {
      method: 'POST',
      body: { content: 'stale', baseRevision: bootstrap.manifest.revision },
    });
    expect(stale.status).toBe(409);
    expect((await json<{ error: { code: string } }>(stale)).error.code).toBe('CAS_MISMATCH');
  });

  it('lists revisions and serves historical content read-only', async () => {
    const history = await json<{ revisions: { revision_id: string; seq: number }[] }>(
      await request(`/api/chapter/${chapterId}/history`),
    );
    expect(history.revisions.length).toBeGreaterThanOrEqual(2);
    const first = history.revisions.at(-1)!;
    const revision = await json<{ content: string; revision: { revision_id: string } }>(
      await request(`/api/chapter/${chapterId}/revision/${first.revision_id}`),
    );
    expect(revision.revision.revision_id).toBe(first.revision_id);
    expect(revision.content).toContain('第一段');
  });

  it('reverts by creating a new revision, never deleting history', async () => {
    const history = await json<{ revisions: { revision_id: string }[] }>(
      await request(`/api/chapter/${chapterId}/history`),
    );
    const original = history.revisions.at(-1)!;
    const current = await json<{ manifest: { revision: string } }>(await request('/api/bootstrap'));
    const restored = await request(`/api/chapter/${chapterId}/revert`, {
      method: 'POST',
      body: { revisionId: original.revision_id, baseRevision: current.manifest.revision },
    });
    expect(restored.status).toBe(200);
    const after = await json<{ content: string }>(await request(`/api/chapter/${chapterId}`));
    expect(after.content).toBe('第一段。\n\n第二段。\n');
    const afterHistory = await json<{ revisions: unknown[] }>(await request(`/api/chapter/${chapterId}/history`));
    expect(afterHistory.revisions.length).toBeGreaterThanOrEqual(3);
  });

  it('creates a chapter through the workbench API', async () => {
    const created = await request('/api/chapter', {
      method: 'POST',
      body: { title: '第二章 工作台创建' },
    });
    expect(created.status).toBe(200);
    const after = await json<Boot>(await request('/api/bootstrap'));
    expect(after.chapters.length).toBe(2);
    expect(after.chapters.some((chapter) => chapter.title === '第二章 工作台创建')).toBe(true);
  });

  it('does not serve files outside the studio dist directory', async () => {
    const traversal = await request('/..%2f..%2fpackage.json');
    expect([403, 404]).toContain(traversal.status);
  });

  it('keeps the API closed to a non-loopback Origin', async () => {
    const response = await request('/api/chapter', {
      method: 'POST',
      body: { title: 'X' },
      headers: { origin: 'http://localhost:1' },
    });
    expect(response.status).toBe(403);
  });

  it('imports a full chapter atomically, preserves source text and deduplicates retries', async () => {
    const before=await json<Boot>(await request('/api/bootstrap'));
    const content='导入首段。\r\n\r\n对白：“别开灯。”🌊\r\n尾段。';
    const body={title:'导入续写实战合成夹具',content,baseRevision:before.manifest.revision,importId:'a1111111-1111-4111-8111-111111111111'};
    const response=await request('/api/chapter',{method:'POST',body});expect(response.status).toBe(200);
    const created=await json<{chapter:{chapter_id:string}}>(response);
    const got=await json<{content:string}>(await request(`/api/chapter/${created.chapter.chapter_id}`));expect(got.content).toBe(content);
    const history=await json<{revisions:unknown[]}>(await request(`/api/chapter/${created.chapter.chapter_id}/history`));expect(history.revisions).toHaveLength(1);
    const retry=await json<{chapter:{chapter_id:string};reused:boolean}>(await request('/api/chapter',{method:'POST',body}));expect(retry.reused).toBe(true);expect(retry.chapter.chapter_id).toBe(created.chapter.chapter_id);
    expect((await json<Boot>(await request('/api/bootstrap'))).chapters).toHaveLength(before.chapters.length+1);
    expect((await request('/api/chapter',{method:'POST',body:{...body,content:'不同内容'}})).status).toBe(400);
    const original=await json<{content:string}>(await request(`/api/chapter/${chapterId}`));expect(original.content).toBe('第一段。\n\n第二段。\n');
  });

  it('refuses stale or invalid imports without creating empty chapters', async () => {
    const before=await json<Boot>(await request('/api/bootstrap'));
    const base={title:'不得留下空章',baseRevision:before.manifest.revision,importId:'b1111111-1111-4111-8111-111111111111'};
    for(const content of ['', '\u0000正文'])expect((await request('/api/chapter',{method:'POST',body:{...base,content}})).status).toBe(400);
    expect((await request('/api/chapter',{method:'POST',body:{...base,content:'有效正文',baseRevision:bootstrap.manifest.revision}})).status).toBe(409);
    expect((await json<Boot>(await request('/api/bootstrap'))).chapters).toHaveLength(before.chapters.length);
  });
});
