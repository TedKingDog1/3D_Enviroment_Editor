import type { StoredProject } from './projectStorage';
const OWNER = 'TedKingDog1';
const REPOSITORY = 'Creation-Environment-Projects';
const BRANCH = 'main';
const API_ROOT = 'https://api.github.com';
async function request<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(API_ROOT + path, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof payload.message === 'string' ? payload.message : `GitHub HTTP ${response.status}`);
  return payload as T;
}
function encodeBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
function decodeBase64(text: string): string {
  const binary = atob(text.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, c => c.charCodeAt(0)));
}
function pathFor(id: string) { return `projects/${encodeURIComponent(id)}.json`; }
export async function connectGitHub(token: string): Promise<void> {
  await request(token, `/repos/${OWNER}/${REPOSITORY}`);
}
export async function listRemoteProjects(token: string): Promise<StoredProject[]> {
  type Item = { name: string; type: string; url: string };
  let items: Item[];
  try {
    items = await request<Item[]>(token, `/repos/${OWNER}/${REPOSITORY}/contents/projects?ref=${BRANCH}`);
  } catch (error) {
    if (error instanceof Error && /Not Found/i.test(error.message)) return [];
    throw error;
  }
  const files = items.filter(item => item.type === 'file' && item.name.endsWith('.json'));
  const projects = await Promise.all(files.map(async item => {
    const file = await request<{ content: string }>(token, item.url.replace(API_ROOT, ''));
    return JSON.parse(decodeBase64(file.content)) as StoredProject;
  }));
  return projects.sort((a, b) => b.updatedAt - a.updatedAt);
}
export async function loadRemoteProject(token: string, id: string): Promise<StoredProject> {
  const file = await request<{ content: string }>(token, `/repos/${OWNER}/${REPOSITORY}/contents/${pathFor(id)}?ref=${BRANCH}`);
  return JSON.parse(decodeBase64(file.content)) as StoredProject;
}
export async function saveRemoteProject(token: string, project: StoredProject): Promise<void> {
  const path = pathFor(project.id);
  let sha: string | undefined;
  try {
    const existing = await request<{ sha: string }>(token, `/repos/${OWNER}/${REPOSITORY}/contents/${path}?ref=${BRANCH}`);
    sha = existing.sha;
  } catch (error) {
    if (!(error instanceof Error) || !/Not Found/i.test(error.message)) throw error;
  }
  await request(token, `/repos/${OWNER}/${REPOSITORY}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({
      message: `${sha ? 'Update' : 'Save'} environment: ${project.name}`,
      content: encodeBase64(JSON.stringify(project, null, 2)),
      branch: BRANCH,
      ...(sha ? { sha } : {})
    })
  });
}
