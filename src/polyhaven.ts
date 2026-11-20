export type PolyHavenAssetType = 'models' | 'textures' | 'hdris';

export interface PolyHavenAsset {
  id: string;
  name: string;
  description: string;
  category: string;
  tags: string[];
  thumbnail_url: string;
  max_resolution?: number[];
  download_count?: number;
  type: number;
}

type FileLink = { url: string; path: string[] };

const API_ROOT = '/polyhaven-api';

// Keep the in-editor catalog focused on environment-building assets.
const SAFE_CATEGORIES: Record<Exclude<PolyHavenAssetType, 'hdris'>, string[]> = {
  models: ['Nature', 'Architecture'],
  textures: ['Ground & Terrain', 'Stone', 'Wood', 'Concrete', 'Brick & Block', 'Asphalt & Bitumen', 'Organic']
};

async function requestJson<T>(path: string): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`);
  if (!response.ok) {
    throw new Error(`Poly Haven API returned ${response.status} for ${path}.`);
  }
  return response.json() as Promise<T>;
}

function normalizeAsset(id: string, raw: Record<string, unknown>): PolyHavenAsset {
  return {
    id,
    name: typeof raw.name === 'string' ? raw.name : id,
    description: typeof raw.description === 'string' ? raw.description : '',
    category: typeof raw.category === 'string' ? raw.category : '',
    tags: Array.isArray(raw.tags) ? raw.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    thumbnail_url: typeof raw.thumbnail_url === 'string' ? raw.thumbnail_url : '',
    max_resolution: Array.isArray(raw.max_resolution) ? raw.max_resolution.filter((value): value is number => typeof value === 'number') : undefined,
    download_count: typeof raw.download_count === 'number' ? raw.download_count : 0,
    type: typeof raw.type === 'number' ? raw.type : -1
  };
}

function categoryMatches(category: string, allowed: string[]): boolean {
  const normalized = category.trim().toLowerCase();
  return allowed.some(item => {
    const prefix = item.toLowerCase();
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

export async function getPolyHavenAssets(type: PolyHavenAssetType): Promise<PolyHavenAsset[]> {
  const categories = type === 'hdris' ? [null] : SAFE_CATEGORIES[type];
  const responses = await Promise.allSettled(categories.map(category => {
    const params = new URLSearchParams({ type });
    if (category) params.set('category', category);
    return requestJson<Record<string, Record<string, unknown>>>(`/assets?${params.toString()}`);
  }));

  const byId = new Map<string, PolyHavenAsset>();
  let successfulRequests = 0;
  for (const result of responses) {
    if (result.status !== 'fulfilled') continue;
    successfulRequests++;
    for (const [id, raw] of Object.entries(result.value)) {
      const asset = normalizeAsset(id, raw);
      if (type !== 'hdris' && !categoryMatches(asset.category, SAFE_CATEGORIES[type])) continue;
      if (asset.thumbnail_url) byId.set(id, asset);
    }
  }

  if (!successfulRequests) {
    const firstFailure = responses.find(result => result.status === 'rejected');
    throw firstFailure?.status === 'rejected'
      ? firstFailure.reason
      : new Error('Poly Haven did not return any asset data.');
  }

  return [...byId.values()].sort((a, b) => (b.download_count ?? 0) - (a.download_count ?? 0));
}

function collectFileLinks(value: unknown, path: string[] = [], output: FileLink[] = []): FileLink[] {
  if (!value || typeof value !== 'object') return output;
  const record = value as Record<string, unknown>;
  if (typeof record.url === 'string' && /^https:\/\//i.test(record.url)) {
    output.push({ url: record.url, path });
  }
  for (const [key, child] of Object.entries(record)) {
    if (key !== 'url' && key !== 'md5' && key !== 'size') {
      collectFileLinks(child, [...path, key.toLowerCase()], output);
    }
  }
  return output;
}

function resolutionScore(path: string[]): number {
  const match = path.join('/').match(/(?:^|\/)(\d+)k(?:\/|$)/i);
  return match ? Number(match[1]) : 999;
}

function chooseFile(links: FileLink[], predicate: (path: string[], url: string) => boolean): string | null {
  return links
    .filter(link => predicate(link.path, link.url))
    .sort((a, b) => resolutionScore(a.path) - resolutionScore(b.path))[0]?.url ?? null;
}

async function getFiles(id: string): Promise<unknown> {
  return requestJson<unknown>(`/files/${encodeURIComponent(id)}`);
}

export async function getPolyHavenModelUrl(id: string): Promise<string> {
  const files = await getFiles(id);
  const links = collectFileLinks(files);
  const url = chooseFile(links, (path, candidate) =>
    path.includes('gltf') && /\.(gltf|glb)(?:$|\?)/i.test(candidate)
  );
  if (!url) throw new Error('This model does not currently provide a compatible glTF download.');
  return url;
}

export async function getPolyHavenTextureUrl(id: string): Promise<string> {
  const files = await getFiles(id);
  const links = collectFileLinks(files);
  const preferred = chooseFile(links, (path, candidate) =>
    path.some(part => ['diffuse', 'albedo', 'color'].includes(part)) &&
    /\.(png|jpe?g|webp|tif?f)(?:$|\?)/i.test(candidate)
  );
  const fallback = chooseFile(links, (_path, candidate) =>
    /\.(png|jpe?g|webp)(?:$|\?)/i.test(candidate)
  );
  const url = preferred ?? fallback;
  if (!url) throw new Error('This texture does not currently provide a compatible image map.');
  return url;
}

export async function getPolyHavenHdriUrl(id: string): Promise<string> {
  const files = await getFiles(id);
  const links = collectFileLinks(files);
  const url = chooseFile(links, (path, candidate) =>
    path.includes('hdri') && path.includes('hdr') &&
    !path.includes('exr') && /\.hdr(?:$|\?)/i.test(candidate)
  );
  if (!url) throw new Error('This HDRI does not currently provide an HDR download.');
  return url;
}
