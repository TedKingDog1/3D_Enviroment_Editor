export type EntityKind =
  | 'mesh'
  | 'pointLight'
  | 'directionalLight'
  | 'spotLight'
  | 'camera';

export interface WorldSettings {
  backgroundColor: string;
  fog: {
    enabled: boolean;
    color: string;
    near: number;
    far: number;
  };
  sun: {
    enabled: boolean;
    color: string;
    intensity: number;
    position: [number, number, number];
  };
  ambient: {
    skyColor: string;
    groundColor: string;
    intensity: number;
  };
  ground: {
    enabled: boolean;
    color: string;
    size: number;
  };
}

export interface ProjectObject {
  id: string;
  name: string;
  kind: EntityKind;
  position: [number, number, number];
  rotation: [number, number, number];
  scale: [number, number, number];
  geometry?: {
    type: 'box' | 'sphere' | 'cylinder' | 'plane' | 'terrain' | 'custom';
    parameters: number[];
  };
  terrainData?: {
    width: number;
    depth: number;
    segments: number;
    heights: number[];
  };
  material?: {
    color: string;
    roughness: number;
    metalness: number;
    textureDataUrl?: string;
  };
  light?: {
    color: string;
    intensity: number;
    distance?: number;
    decay?: number;
    angle?: number;
    penumbra?: number;
    castShadow: boolean;
  };
  camera?: {
    fov: number;
    near: number;
    far: number;
  };
  targetPosition?: [number, number, number];
  lightTransmissionEnabled?: boolean;
  shadowExcludedLightIds?: string[];
}

export interface WorldDocument {
  schemaVersion: 1;
  settings: WorldSettings;
  objects: ProjectObject[];
  editorCamera: {
    position: [number, number, number];
    rotation: [number, number, number];
  };
}

export interface StoredProject {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  world: WorldDocument;
}

const DATABASE_NAME = 'creation-environment-studio';
const DATABASE_VERSION = 1;
const PROJECT_STORE = 'projects';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(PROJECT_STORE)) {
        database.createObjectStore(PROJECT_STORE, { keyPath: 'id' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Could not open project database.'));
    request.onblocked = () => reject(new Error('Project database upgrade is blocked by another open tab.'));
  });
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

export async function listProjects(): Promise<StoredProject[]> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PROJECT_STORE, 'readonly');
    const projects = await requestResult(
      transaction.objectStore(PROJECT_STORE).getAll() as IDBRequest<StoredProject[]>
    );
    return projects.sort((a, b) => b.updatedAt - a.updatedAt);
  } finally {
    database.close();
  }
}

export async function getProject(id: string): Promise<StoredProject | undefined> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PROJECT_STORE, 'readonly');
    return await requestResult(
      transaction.objectStore(PROJECT_STORE).get(id) as IDBRequest<StoredProject | undefined>
    );
  } finally {
    database.close();
  }
}

export async function saveProject(project: StoredProject): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PROJECT_STORE, 'readwrite');
    transaction.objectStore(PROJECT_STORE).put(project);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not save project.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Project save was aborted.'));
    });
  } finally {
    database.close();
  }
}

export async function deleteProject(id: string): Promise<void> {
  const database = await openDatabase();
  try {
    const transaction = database.transaction(PROJECT_STORE, 'readwrite');
    transaction.objectStore(PROJECT_STORE).delete(id);
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('Could not delete project.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('Project deletion was aborted.'));
    });
  } finally {
    database.close();
  }
}

export function createProjectRecord(name: string, world: WorldDocument): StoredProject {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    name: name.trim() || 'Untitled Project',
    createdAt: now,
    updatedAt: now,
    world
  };
}
