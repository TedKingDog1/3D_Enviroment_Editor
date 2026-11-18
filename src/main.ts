import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { createTerrainGeometry, getTerrainHeights, sculptTerrain, type SculptMode } from './terrainTools';
import {
  createProjectRecord,
  deleteProject,
  listProjects,
  saveProject,
  type EntityKind,
  type ProjectObject,
  type ProjectFolder,
  type StoredProject,
  type WorldDocument
} from './projectStorage';
import { connectGitHub, listRemoteProjects, loadRemoteProject, saveRemoteProject } from './githubStorage';
import { createNatureAsset, NATURE_ASSETS, type NatureAssetType } from './assetFactory';
import './style.css';

interface Entity {
  id: string;
  object: THREE.Object3D;
  kind: EntityKind;
  primitiveType?: 'box' | 'sphere' | 'cylinder' | 'plane' | 'terrain' | NatureAssetType;
  helper?: THREE.Object3D;
  name: string;
  folderId?: string;
  shadowLayer?: number;
  shadowExcludedLights?: Set<Entity>;
  lightTransmissionEnabled?: boolean;
}

const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const objectList = document.querySelector<HTMLDivElement>('#object-list')!;
const properties = document.querySelector<HTMLDivElement>('#properties')!;
const inspectorHeading = document.querySelector<HTMLDivElement>('#inspector-heading')!;
let showingWorldSettings = false;
const cameraStatus = document.querySelector<HTMLSpanElement>('#camera-status')!;
const selectionStatus = document.querySelector<HTMLSpanElement>('#selection-status')!;
const projectManager = document.querySelector<HTMLDivElement>('#project-manager')!;
const projectListElement = document.querySelector<HTMLDivElement>('#project-list')!;
const projectNameInput = document.querySelector<HTMLInputElement>('#new-project-name')!;
const currentProjectName = document.querySelector<HTMLElement>('#current-project-name')!;
const saveStatus = document.querySelector<HTMLSpanElement>('#save-status')!;

let currentProject: StoredProject | null = null;

type AppPreferences = {
  theme: 'dark' | 'light' | 'system';
  accent: string;
  density: 'comfortable' | 'compact';
  keybindings: { delete: string; move: string; rotate: string; scale: string };
};
const defaultPreferences: AppPreferences = {
  theme: 'dark',
  accent: '#d2b16d',
  density: 'comfortable',
  keybindings: { delete: 'Delete', move: 'KeyG', rotate: 'KeyR', scale: 'KeyS' }
};
let preferences: AppPreferences = (() => {
  try {
    const saved = localStorage.getItem('ces-app-preferences');
    if (!saved) return structuredClone(defaultPreferences);
    const parsed = JSON.parse(saved) as Partial<AppPreferences>;
    return {
      ...defaultPreferences,
      ...parsed,
      keybindings: { ...defaultPreferences.keybindings, ...parsed.keybindings }
    };
  } catch {
    return structuredClone(defaultPreferences);
  }
})();
let capturingKeybinding: keyof AppPreferences['keybindings'] | null = null;

function savePreferences() {
  localStorage.setItem('ces-app-preferences', JSON.stringify(preferences));
}

function applyPreferences() {
  document.documentElement.dataset.theme = preferences.theme;
  document.documentElement.dataset.density = preferences.density;
  document.documentElement.style.setProperty('--accent', preferences.accent);
  const accent = document.querySelector<HTMLInputElement>('#accent-color');
  const accentHex = document.querySelector<HTMLInputElement>('#accent-hex');
  const theme = document.querySelector<HTMLSelectElement>('#theme-select');
  const density = document.querySelector<HTMLSelectElement>('#density-select');
  if (accent) accent.value = preferences.accent;
  if (accentHex) accentHex.value = preferences.accent.toUpperCase();
  if (theme) theme.value = preferences.theme;
  if (density) density.value = preferences.density;
  document.querySelectorAll<HTMLButtonElement>('[data-keybinding]').forEach(button => {
    const action = button.dataset.keybinding as keyof AppPreferences['keybindings'];
    button.textContent = capturingKeybinding === action
      ? 'Press a key…'
      : formatKeybinding(preferences.keybindings[action]);
    button.classList.toggle('listening', capturingKeybinding === action);
  });
}

function formatKeybinding(code: string) {
  return code.replace(/^Key/, '').replace(/^Digit/, '').replace('Delete', 'Del')
    .replace('Backspace', 'Backspace').replace('Space', 'Space')
    .replace('ArrowUp', '↑').replace('ArrowDown', '↓')
    .replace('ArrowLeft', '←').replace('ArrowRight', '→');
}

function openSettings() {
  document.querySelector<HTMLDivElement>('#settings-panel')!.classList.add('visible');
  applyPreferences();
}
function closeSettings() {
  document.querySelector<HTMLDivElement>('#settings-panel')!.classList.remove('visible');
  capturingKeybinding = null;
  applyPreferences();
}


const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8295a8);
scene.fog = new THREE.Fog(0x8295a8, 45, 150);

const editorCamera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
editorCamera.position.set(10, 8, 12);
editorCamera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
viewport.appendChild(renderer.domElement);

const ambientLight = new THREE.HemisphereLight(0xdceaff, 0x46505b, 2);
scene.add(ambientLight);

const fogSettings = {
  enabled: true,
  color: '#8295a8',
  near: 45,
  far: 150
};

const sunlight = new THREE.DirectionalLight(0xffedcf, 3);
sunlight.position.set(12, 20, 8);
sunlight.castShadow = true;
sunlight.shadow.camera.layers.set(1);
scene.add(sunlight);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x59635c, roughness: 0.95 })
);
ground.rotation.x = -Math.PI / 2;
ground.position.y = -0.025;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(200, 200, 0x8995a5, 0x596575);
grid.position.y = 0.005;
scene.add(grid);
scene.add(new THREE.AxesHelper(2));

const transform = new TransformControls(editorCamera, renderer.domElement);
scene.add(transform.getHelper());

const entities: Entity[] = [];
let selected: Entity | null = null;
let selectedEntities = new Set<Entity>();
let folders: ProjectFolder[] = [];
const collapsedFolders = new Set<string>();
let selectionAnchor: Entity | null = null;
let selectionTransformGroup: THREE.Group | null = null;
const folderList = document.createElement('div');
folderList.className = 'outliner-folders';
let terrainSculptActive = false;
let isSculptingTerrain = false;
let sculptMode: SculptMode = 'raise';
let brushRadius = 5;
let brushStrength = 0.5;
let flattenHeight = 0;
const brushRaycaster = new THREE.Raycaster();
const brushPointer = new THREE.Vector2();

type TerrainPaintMaterial = 'grass' | 'dirt' | 'rock' | 'snow';
type TerrainToolMode = 'sculpt' | 'paint';
let terrainToolMode: TerrainToolMode = 'sculpt';
let selectedPaintMaterial: TerrainPaintMaterial = 'grass';
let paintOpacity = 0.75;
const terrainPaintCanvases = new WeakMap<THREE.Mesh, HTMLCanvasElement>();
const terrainTextureSize = 1024;

function createMaterialTile(material: TerrainPaintMaterial): HTMLCanvasElement {
  const tile = document.createElement('canvas');
  tile.width = 128;
  tile.height = 128;
  const ctx = tile.getContext('2d')!;
  const palettes: Record<TerrainPaintMaterial, [string, string, string]> = {
    grass: ['#536d3c', '#78934e', '#344b2d'],
    dirt: ['#76563b', '#a17a52', '#503b2d'],
    rock: ['#777b7b', '#a4a5a0', '#4f5558'],
    snow: ['#d8e0e5', '#ffffff', '#aebdca']
  };
  const [base, light, dark] = palettes[material];
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, tile.width, tile.height);
  for (let i = 0; i < 950; i++) {
    const x = Math.random() * tile.width;
    const y = Math.random() * tile.height;
    const radius = 0.5 + Math.random() * (material === 'rock' ? 3.2 : 2.1);
    ctx.globalAlpha = 0.12 + Math.random() * 0.3;
    ctx.fillStyle = Math.random() > 0.48 ? light : dark;
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  return tile;
}

const terrainMaterialTiles: Record<TerrainPaintMaterial, HTMLCanvasElement> = {
  grass: createMaterialTile('grass'),
  dirt: createMaterialTile('dirt'),
  rock: createMaterialTile('rock'),
  snow: createMaterialTile('snow')
};

function createTerrainPaintCanvas(base: TerrainPaintMaterial = 'grass', source?: CanvasImageSource): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = terrainTextureSize;
  canvas.height = terrainTextureSize;
  const ctx = canvas.getContext('2d')!;
  if (source) {
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  } else {
    const pattern = ctx.createPattern(terrainMaterialTiles[base], 'repeat')!;
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  return canvas;
}

function createTerrainPaintMap(mesh: THREE.Mesh, source?: CanvasImageSource) {
  const canvas = createTerrainPaintCanvas('grass', source);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = renderer.capabilities.getMaxAnisotropy();
  const material = mesh.material as THREE.MeshStandardMaterial;
  material.map?.dispose();
  material.map = texture;
  material.color.set(0xffffff);
  material.needsUpdate = true;
  terrainPaintCanvases.set(mesh, canvas);
}

function paintTerrainAt(mesh: THREE.Mesh, uv: THREE.Vector2) {
  let canvas = terrainPaintCanvases.get(mesh);
  const material = mesh.material as THREE.MeshStandardMaterial;
  if (!canvas) {
    const source = material.map?.image as CanvasImageSource | undefined;
    createTerrainPaintMap(mesh, source);
    canvas = terrainPaintCanvases.get(mesh)!;
  }
  const width = (mesh.geometry as THREE.PlaneGeometry).parameters.width;
  const depth = (mesh.geometry as THREE.PlaneGeometry).parameters.height;
  const radiusX = Math.max(3, brushRadius / width * canvas.width);
  const radiusY = Math.max(3, brushRadius / depth * canvas.height);
  const stamp = document.createElement('canvas');
  stamp.width = Math.max(2, Math.ceil(radiusX * 2));
  stamp.height = Math.max(2, Math.ceil(radiusY * 2));
  const stampCtx = stamp.getContext('2d')!;
  const pattern = stampCtx.createPattern(terrainMaterialTiles[selectedPaintMaterial], 'repeat')!;
  stampCtx.fillStyle = pattern;
  stampCtx.fillRect(0, 0, stamp.width, stamp.height);
  stampCtx.globalCompositeOperation = 'destination-in';
  const gradient = stampCtx.createRadialGradient(stamp.width / 2, stamp.height / 2, 0, stamp.width / 2, stamp.height / 2, Math.min(stamp.width, stamp.height) / 2);
  gradient.addColorStop(0, `rgba(255,255,255,${paintOpacity})`);
  gradient.addColorStop(0.72, `rgba(255,255,255,${paintOpacity * 0.7})`);
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  stampCtx.fillStyle = gradient;
  stampCtx.fillRect(0, 0, stamp.width, stamp.height);
  const ctx = canvas.getContext('2d')!;
  const x = uv.x * canvas.width - radiusX;
  const y = (1 - uv.y) * canvas.height - radiusY;
  ctx.drawImage(stamp, x, y);
  if (material.map instanceof THREE.CanvasTexture) material.map.needsUpdate = true;
}

const brushCursor = new THREE.Mesh(new THREE.RingGeometry(0.94, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffd36e, side: THREE.DoubleSide, depthTest: false }));
brushCursor.rotation.x = -Math.PI / 2;
brushCursor.visible = false;
brushCursor.renderOrder = 20;
scene.add(brushCursor);

const defaultSunEntity: Entity = {
  id: 'world-sun',
  object: sunlight,
  kind: 'directionalLight',
  name: 'World Sun',
  shadowLayer: 1
};

function getShadowLights(): Entity[] {
  return [
    defaultSunEntity,
    ...entities.filter(entity => entity.shadowLayer !== undefined)
  ];
}

function applyMeshShadowLayers(entity: Entity) {
  if (entity.kind !== 'mesh') return;

  for (const light of getShadowLights()) {
    if (light.shadowLayer === undefined) continue;

    const excluded =
      entity.lightTransmissionEnabled &&
      entity.shadowExcludedLights?.has(light);

    if (excluded) {
      entity.object.layers.disable(light.shadowLayer);
    } else {
      entity.object.layers.enable(light.shadowLayer);
    }
  }
}
let objectNumber = 0;
let previewCamera: THREE.PerspectiveCamera | null = null;
let isPointerLocked = false;
let isDraggingTransform = false;

const keys = new Set<string>();
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();

function resize() {
  const width = viewport.clientWidth;
  const height = viewport.clientHeight;
  if (!width || !height) return;

  editorCamera.aspect = width / height;
  editorCamera.updateProjectionMatrix();

  for (const entity of entities) {
    if (entity.kind === 'camera') {
      const cam = entity.object as THREE.PerspectiveCamera;
      cam.aspect = width / height;
      cam.updateProjectionMatrix();
      entity.helper?.updateMatrixWorld(true);
    }
  }

  renderer.setSize(width, height);
}
new ResizeObserver(resize).observe(viewport);
resize();

function registerEntity(object: THREE.Object3D, kind: EntityKind, helper?: THREE.Object3D, selectAfter = true) {
  const entity: Entity = {
    id: crypto.randomUUID(),
    object,
    kind,
    helper,
    name: object.name
  };

  entities.push(entity);

  if (kind === 'mesh') {
    entity.shadowExcludedLights = new Set();
    entity.lightTransmissionEnabled = false;

    object.layers.enable(defaultSunEntity.shadowLayer!);

    for (const existing of entities) {
      if (existing.shadowLayer !== undefined) {
        object.layers.enable(existing.shadowLayer);
      }
    }
  } else if (
    kind === 'pointLight' ||
    kind === 'directionalLight' ||
    kind === 'spotLight'
  ) {
    const usedLayers = new Set(
      [defaultSunEntity, ...entities]
        .map(item => item.shadowLayer)
        .filter((layer): layer is number => layer !== undefined)
    );

    let layer = 2;
    while (layer <= 31 && usedLayers.has(layer)) layer++;

    if (layer > 31) {
      (object as THREE.Light).castShadow = false;
      console.warn('Maximum number of independently filtered lights reached.');
    } else {
      entity.shadowLayer = layer;

      const light = object as
        | THREE.PointLight
        | THREE.DirectionalLight
        | THREE.SpotLight;

      light.shadow.camera.layers.set(layer);

      for (const existing of entities) {
        if (existing.kind === 'mesh') {
          existing.object.layers.enable(layer);
        }
      }
    }
  }

  scene.add(object);
  if (helper) scene.add(helper);

  if (selectAfter) selectEntity(entity);
}

function addObject(type: string) {
  const position = new THREE.Vector3();
  const direction = new THREE.Vector3();
  editorCamera.getWorldDirection(direction);
  position.copy(editorCamera.position).add(direction.multiplyScalar(5));
  position.y = Math.max(position.y, 1);

  if (type === 'box' || type === 'sphere' || type === 'cylinder' || type === 'plane') {
    let geometry: THREE.BufferGeometry;

    if (type === 'sphere') geometry = new THREE.SphereGeometry(1, 32, 20);
    else if (type === 'cylinder') geometry = new THREE.CylinderGeometry(0.8, 0.8, 1.8, 32);
    else if (type === 'plane') geometry = new THREE.PlaneGeometry(3, 3);
    else geometry = new THREE.BoxGeometry(1.8, 1.8, 1.8);

    const material = new THREE.MeshStandardMaterial({
      color: type === 'plane' ? 0x6e9876 : 0xb9c5d5,
      roughness: 0.72,
      metalness: 0.05
    });

    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = `${type.charAt(0).toUpperCase() + type.slice(1)} ${++objectNumber}`;
    mesh.position.copy(position);
    if (type === 'plane') {
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.y = 0.03;
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    registerEntity(mesh, 'mesh');
    entities[entities.length - 1].primitiveType = type;
    return;
  }

  if (type === 'terrain') {
    const geometry = createTerrainGeometry(60, 60, 80);
    const material = new THREE.MeshStandardMaterial({ color: 0x687b55, roughness: 0.96 });
    const terrain = new THREE.Mesh(geometry, material);
    createTerrainPaintMap(terrain);
    terrain.name = `Terrain ${++objectNumber}`;
    terrain.rotation.x = -Math.PI / 2;
    terrain.position.set(0, 0.015, 0);
    terrain.receiveShadow = true;
    terrain.castShadow = true;
    registerEntity(terrain, 'mesh');
    entities[entities.length - 1].primitiveType = 'terrain';
    return;
  }

  if (type === 'pointLight') {
    const light = new THREE.PointLight(0xffd6a0, 35, 30);
    light.name = `Point Light ${++objectNumber}`;
    light.position.copy(position);
    light.castShadow = true;
    const helper = new THREE.PointLightHelper(light, 0.35);
    registerEntity(light, 'pointLight', helper);
    return;
  }

  if (type === 'directionalLight') {
    const light = new THREE.DirectionalLight(0xffedcf, 3);
    light.name = `Sun Light ${++objectNumber}`;
    light.position.copy(position);
    light.castShadow = true;
    const helper = new THREE.DirectionalLightHelper(light, 1);
    registerEntity(light, 'directionalLight', helper);
    return;
  }

  if (type === 'spotLight') {
    const light = new THREE.SpotLight(0xffffff, 50, 40, Math.PI / 7, 0.3, 1);
    light.name = `Spotlight ${++objectNumber}`;
    light.position.copy(position);
    light.target.position.copy(position).add(new THREE.Vector3(0, -1, -4));
    scene.add(light.target);
    light.castShadow = true;
    const helper = new THREE.SpotLightHelper(light);
    registerEntity(light, 'spotLight', helper);
    return;
  }

  if (type === 'camera') {
    const camera = new THREE.PerspectiveCamera(60, viewport.clientWidth / viewport.clientHeight, 0.1, 500);
    camera.name = `Camera ${++objectNumber}`;
    camera.position.copy(position);
    camera.lookAt(position.clone().add(direction));
    const helper = new THREE.CameraHelper(camera);
    registerEntity(camera, 'camera', helper);
  }
}


function createNatureAssetMesh(type: NatureAssetType) {
  const definition = NATURE_ASSETS.find(asset => asset.type === type);
  if (!definition) return null;
  const geometry = createNatureAsset(type);
  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.92, metalness: 0 });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = `${definition.name} ${++objectNumber}`;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function addNatureAsset(type: NatureAssetType) {
  const mesh = createNatureAssetMesh(type);
  if (!mesh) return;
  const direction = new THREE.Vector3();
  editorCamera.getWorldDirection(direction);
  mesh.position.copy(editorCamera.position).add(direction.multiplyScalar(7));
  mesh.position.y = 0;
  registerEntity(mesh, 'mesh');
  entities[entities.length - 1].primitiveType = type;
}

function clearSelectionTransform() {
  transform.detach();
  if (selectionTransformGroup) {
    for (const child of [...selectionTransformGroup.children]) scene.attach(child);
    scene.remove(selectionTransformGroup);
    selectionTransformGroup = null;
  }
}

function attachSelectionTransform() {
  clearSelectionTransform();
  if (!selectedEntities.size) return;
  if (selectedEntities.size === 1) {
    transform.attach([...selectedEntities][0].object);
    return;
  }
  const group = new THREE.Group();
  group.name = 'Multi-selection Pivot';
  const center = new THREE.Vector3();
  for (const entity of selectedEntities) center.add(entity.object.getWorldPosition(new THREE.Vector3()));
  center.divideScalar(selectedEntities.size);
  group.position.copy(center);
  scene.add(group);
  for (const entity of selectedEntities) group.attach(entity.object);
  selectionTransformGroup = group;
  transform.attach(group);
}

function applySelection(next: Entity[], anchor: Entity | null = next[next.length - 1] ?? null) {
  clearSelectionTransform();
  selectedEntities = new Set(next);
  selected = anchor && selectedEntities.has(anchor) ? anchor : (next[next.length - 1] ?? null);
  selectionAnchor = anchor;
  attachSelectionTransform();
  selectionStatus.textContent = selectedEntities.size
    ? selectedEntities.size === 1 ? `SELECTED: ${selected!.name.toUpperCase()}` : `SELECTED: ${selectedEntities.size} OBJECTS`
    : 'NO OBJECT SELECTED';
  refreshOutliner();
  refreshProperties();
}

function selectEntity(entity: Entity | null, additive = false, range = false) {
  if (terrainSculptActive && !(entity?.kind === 'mesh' && entity.primitiveType === 'terrain')) setTerrainSculptMode(false);
  if (!entity) { applySelection([]); return; }
  if (range && selectionAnchor) {
    const visible = entities.filter(item => !item.folderId || !collapsedFolders.has(item.folderId));
    const a = visible.indexOf(selectionAnchor), b = visible.indexOf(entity);
    if (a >= 0 && b >= 0) applySelection(visible.slice(Math.min(a,b), Math.max(a,b)+1), entity);
    else applySelection([entity], entity);
  } else if (additive) {
    const next = new Set(selectedEntities);
    if (next.has(entity)) next.delete(entity); else next.add(entity);
    applySelection([...next], entity);
  } else applySelection([entity], entity);
}

function deleteSelected() {
  const targets = [...selectedEntities];
  if (!targets.length && selected) targets.push(selected);
  if (!targets.length) return;
  clearSelectionTransform();
  for (const target of targets) {
    scene.remove(target.object);
    const index = entities.indexOf(target);
    if (index !== -1) entities.splice(index, 1);
    if (target.shadowLayer !== undefined) {
      for (const entity of entities) if (entity.kind === 'mesh') { entity.shadowExcludedLights?.delete(target); applyMeshShadowLayers(entity); }
    }
    if (target.object instanceof THREE.Mesh) {
      target.object.geometry.dispose();
      const material = target.object.material;
      (Array.isArray(material) ? material : [material]).forEach(item => item.dispose());
    }
    if (target.helper) {
      scene.remove(target.helper);
      target.helper.traverse(child => {
        const visual = child as THREE.Mesh;
        visual.geometry?.dispose();
        const material = visual.material;
        if (material) (Array.isArray(material) ? material : [material]).forEach(item => item.dispose());
      });
    }
    if (target.kind === 'spotLight') scene.remove((target.object as THREE.SpotLight).target);
  }
  applySelection([]);
}
document.querySelector<HTMLButtonElement>('#delete-button')!
  .addEventListener('click', deleteSelected);

document.addEventListener('keydown', event => {
  if (capturingKeybinding) {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.code === 'Escape') {
      capturingKeybinding = null;
    } else {
      const duplicate = Object.entries(preferences.keybindings)
        .find(([action, code]) => action !== capturingKeybinding && code === event.code);
      if (duplicate) {
        alert(`That key is already assigned to ${duplicate[0]}. Choose another key.`);
      } else {
        preferences.keybindings[capturingKeybinding] = event.code;
        capturingKeybinding = null;
        savePreferences();
      }
    }
    applyPreferences();
    return;
  }

  const target = event.target as HTMLElement | null;
  const typing = !!target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
  if (typing || isPointerLocked || projectManager.classList.contains('visible') || document.querySelector('#settings-panel')?.classList.contains('visible')) return;

  if (event.code === preferences.keybindings.delete) {
    event.preventDefault();
    deleteSelected();
  } else if (event.code === preferences.keybindings.move) {
    transform.setMode('translate');
    setActiveTool('translate');
  } else if (event.code === preferences.keybindings.rotate) {
    transform.setMode('rotate');
    setActiveTool('rotate');
  } else if (event.code === preferences.keybindings.scale) {
    transform.setMode('scale');
    setActiveTool('scale');
  }
});

function refreshOutliner() {
  objectList.innerHTML = '';
  const folderBar = document.createElement('div');
  folderBar.className = 'outliner-folder-actions';
  const addFolder = document.createElement('button');
  addFolder.textContent = '+ Folder';
  addFolder.addEventListener('click', createFolder);
  const renameFolder = document.createElement('button');
  renameFolder.textContent = 'Rename';
  renameFolder.addEventListener('click', renameSelectedFolder);
  const deleteFolder = document.createElement('button');
  deleteFolder.textContent = 'Delete';
  deleteFolder.addEventListener('click', deleteSelectedFolder);
  folderBar.append(addFolder, renameFolder, deleteFolder);
  objectList.appendChild(folderBar);

  const renderFolder = (folder: ProjectFolder, depth: number) => {
    const row = document.createElement('div');
    row.className = 'outliner-folder-row';
    row.style.paddingLeft = `${8 + depth * 14}px`;
    const toggle = document.createElement('button');
    toggle.className = 'outliner-folder-toggle';
    toggle.textContent = collapsedFolders.has(folder.id) ? '▸' : '▾';
    toggle.addEventListener('click', () => { collapsedFolders.has(folder.id) ? collapsedFolders.delete(folder.id) : collapsedFolders.add(folder.id); refreshOutliner(); });
    const label = document.createElement('button');
    label.className = 'outliner-folder-label';
    label.textContent = `📁  ${folder.name}`;
    label.addEventListener('click', () => { selectedFolderId = folder.id; refreshOutliner(); });
    label.classList.toggle('active', selectedFolderId === folder.id);
    row.addEventListener('dragover', event => event.preventDefault());
    row.addEventListener('drop', event => {
      event.preventDefault();
      const id = (event as DragEvent).dataTransfer?.getData('application/x-ces-entity');
      const moving = entities.find(item => item.id === id);
      if (moving) { moving.folderId = folder.id; refreshOutliner(); }
    });
    row.append(toggle, label);
    objectList.appendChild(row);
    if (!collapsedFolders.has(folder.id)) {
      entities.filter(entity => entity.folderId === folder.id).forEach(entity => renderEntityRow(entity, depth + 1));
      folders.filter(child => child.parentId === folder.id).forEach(child => renderFolder(child, depth + 1));
    }
  };
  folders.filter(folder => !folder.parentId).forEach(folder => renderFolder(folder, 0));
  entities.filter(entity => !entity.folderId).forEach(entity => renderEntityRow(entity, 0));
}
function renderEntityRow(entity: Entity, depth: number) {
  const entry = document.createElement('button');
  entry.className = `object-entry${selectedEntities.has(entity) ? ' selected' : ''}`;
  entry.style.paddingLeft = `${10 + depth * 14}px`;
  const icon = entity.kind === 'mesh' ? '◇' : entity.kind === 'camera' ? '▣' : '☼';
  entry.textContent = `${icon}  ${entity.name}`;
  entry.addEventListener('click', event => selectEntity(entity, (event as MouseEvent).ctrlKey || (event as MouseEvent).metaKey, (event as MouseEvent).shiftKey));
  entry.draggable = true;
  entry.addEventListener('dragstart', event => { event.dataTransfer?.setData('application/x-ces-entity', entity.id); });
  entry.addEventListener('dragover', event => { if ((event as DragEvent).dataTransfer?.types.includes('application/x-ces-entity')) event.preventDefault(); });
  entry.addEventListener('drop', event => {
    event.preventDefault();
    const id = (event as DragEvent).dataTransfer?.getData('application/x-ces-entity');
    const moving = entities.find(item => item.id === id);
    if (moving) { moving.folderId = entity.folderId; refreshOutliner(); }
  });
  objectList.appendChild(entry);
}
let selectedFolderId: string | null = null;
function createFolder() {
  const name = prompt('Folder name:', `New Folder ${folders.length + 1}`);
  if (!name?.trim()) return;
  const folder: ProjectFolder = { id: crypto.randomUUID(), name: name.trim(), parentId: selectedFolderId ?? undefined };
  folders.push(folder);
  selectedFolderId = folder.id;
  refreshOutliner();
}
function renameSelectedFolder() {
  const folder = folders.find(item => item.id === selectedFolderId);
  if (!folder) { alert('Select a folder first.'); return; }
  const name = prompt('Rename folder:', folder.name);
  if (name?.trim()) { folder.name = name.trim(); refreshOutliner(); }
}
function deleteSelectedFolder() {
  const folder = folders.find(item => item.id === selectedFolderId);
  if (!folder) { alert('Select a folder first.'); return; }
  const deleteContents = confirm(`Delete folder "${folder.name}" and all its contents? Choose Cancel to move its contents out instead.`);
  const descendants = new Set<string>([folder.id]);
  let changed = true;
  while (changed) { changed = false; for (const item of folders) if (item.parentId && descendants.has(item.parentId) && !descendants.has(item.id)) { descendants.add(item.id); changed = true; } }
  if (deleteContents) {
    const doomed = entities.filter(entity => entity.folderId && descendants.has(entity.folderId));
    applySelection(doomed);
    deleteSelected();
  } else {
    for (const entity of entities) if (entity.folderId && descendants.has(entity.folderId)) entity.folderId = folder.parentId;
    for (const item of folders) if (item.parentId && descendants.has(item.parentId)) item.parentId = folder.parentId;
  }
  folders = folders.filter(item => !descendants.has(item.id));
  selectedFolderId = null;
  refreshOutliner();
}

function vectorFields(label: string, property: 'position' | 'rotation' | 'scale', object: THREE.Object3D) {
  const vector = property === 'rotation' ? object.rotation : object[property];
  const axes = ['x', 'y', 'z'] as const;

  return `
    <div class="property-group">
      <h3>${label}</h3>
      ${axes.map(axis => {
        const value = property === 'rotation'
          ? THREE.MathUtils.radToDeg((vector as THREE.Euler)[axis])
          : (vector as THREE.Vector3)[axis];

        return `<div class="property-row">
          <label>${axis.toUpperCase()}</label>
          <input type="number" step="0.1" data-property="${property}.${axis}" value="${value.toFixed(2)}">
        </div>`;
      }).join('')}
    </div>`;
}


function updateFog() {
  if (fogSettings.enabled) {
    scene.fog = new THREE.Fog(
      fogSettings.color,
      fogSettings.near,
      Math.max(fogSettings.near + 0.1, fogSettings.far)
    );
  } else {
    scene.fog = null;
  }
}

function refreshWorldSettings() {
  const background = scene.background instanceof THREE.Color
    ? `#${scene.background.getHexString()}`
    : '#8295a8';

  properties.innerHTML = `
    <div class="property-group">
      <h3>BACKGROUND</h3>
      <div class="property-row material-row">
        <label>Color</label>
        <input id="world-background" type="color" value="${background}">
      </div>
      <p class="muted">Set this to black for a dark void.</p>
    </div>

    <div class="property-group">
      <h3>ATMOSPHERE / FOG</h3>
      <label class="property-row setting-toggle">
        <span>Enable Fog</span>
        <input id="fog-enabled" type="checkbox" ${fogSettings.enabled ? 'checked' : ''}>
      </label>
      <div class="property-row material-row">
        <label>Fog Color</label>
        <input id="fog-color" type="color" value="${fogSettings.color}">
      </div>
      <div class="property-row material-row">
        <label>Near Distance</label>
        <input id="fog-near" type="number" min="0" step="1" value="${fogSettings.near}">
      </div>
      <div class="property-row material-row">
        <label>Far Distance</label>
        <input id="fog-far" type="number" min="0.1" step="1" value="${fogSettings.far}">
      </div>
    </div>

    <div class="property-group">
      <h3>WORLD SUN</h3>
      <label class="property-row setting-toggle">
        <span>Enable Sun</span>
        <input id="sun-enabled" type="checkbox" ${sunlight.visible ? 'checked' : ''}>
      </label>
      <div class="property-row material-row">
        <label>Color</label>
        <input id="sun-color" type="color" value="#${sunlight.color.getHexString()}">
      </div>
      <div class="property-row material-row">
        <label>Intensity</label>
        <input id="sun-intensity" type="number" min="0" step="0.1" value="${sunlight.intensity}">
      </div>
    </div>

    <div class="property-group">
      <h3>AMBIENT / SKY LIGHT</h3>
      <div class="property-row material-row">
        <label>Sky Color</label>
        <input id="ambient-sky-color" type="color" value="#${ambientLight.color.getHexString()}">
      </div>
      <div class="property-row material-row">
        <label>Ground Color</label>
        <input id="ambient-ground-color" type="color" value="#${ambientLight.groundColor.getHexString()}">
      </div>
      <div class="property-row material-row">
        <label>Intensity</label>
        <input id="ambient-intensity" type="number" min="0" step="0.1" value="${ambientLight.intensity}">
      </div>
    </div>
  `;

  properties.querySelector<HTMLInputElement>('#world-background')?.addEventListener('input', event => {
    scene.background = new THREE.Color((event.target as HTMLInputElement).value);
  });

  properties.querySelector<HTMLInputElement>('#fog-enabled')?.addEventListener('change', event => {
    fogSettings.enabled = (event.target as HTMLInputElement).checked;
    updateFog();
  });

  properties.querySelector<HTMLInputElement>('#fog-color')?.addEventListener('input', event => {
    fogSettings.color = (event.target as HTMLInputElement).value;
    updateFog();
  });

  properties.querySelector<HTMLInputElement>('#fog-near')?.addEventListener('change', event => {
    fogSettings.near = Math.max(0, Number((event.target as HTMLInputElement).value));
    fogSettings.far = Math.max(fogSettings.near + 0.1, fogSettings.far);
    updateFog();
    refreshWorldSettings();
  });

  properties.querySelector<HTMLInputElement>('#fog-far')?.addEventListener('change', event => {
    fogSettings.far = Math.max(fogSettings.near + 0.1, Number((event.target as HTMLInputElement).value));
    updateFog();
    refreshWorldSettings();
  });

  properties.querySelector<HTMLInputElement>('#sun-enabled')?.addEventListener('change', event => {
    sunlight.visible = (event.target as HTMLInputElement).checked;
  });

  properties.querySelector<HTMLInputElement>('#sun-color')?.addEventListener('input', event => {
    sunlight.color.set((event.target as HTMLInputElement).value);
  });

  properties.querySelector<HTMLInputElement>('#sun-intensity')?.addEventListener('change', event => {
    sunlight.intensity = Math.max(0, Number((event.target as HTMLInputElement).value));
  });

  properties.querySelector<HTMLInputElement>('#ambient-sky-color')?.addEventListener('input', event => {
    ambientLight.color.set((event.target as HTMLInputElement).value);
  });

  properties.querySelector<HTMLInputElement>('#ambient-ground-color')?.addEventListener('input', event => {
    ambientLight.groundColor.set((event.target as HTMLInputElement).value);
  });

  properties.querySelector<HTMLInputElement>('#ambient-intensity')?.addEventListener('change', event => {
    ambientLight.intensity = Math.max(0, Number((event.target as HTMLInputElement).value));
  });
}

document.querySelector<HTMLButtonElement>('#world-settings-button')!
  .addEventListener('click', () => {
    showingWorldSettings = !showingWorldSettings;

    if (showingWorldSettings) {
      inspectorHeading.textContent = 'WORLD SETTINGS';
      refreshWorldSettings();
    } else {
      inspectorHeading.textContent = 'PROPERTIES';
      refreshProperties();
    }
  });

function refreshProperties() {
  if (showingWorldSettings) return;
  if (!selected) {
    properties.innerHTML = '<p class="muted">Select an object to edit its properties.</p>';
    return;
  }

  const entity = selected;
  const object = entity.object;

  let extra = '';
  const availableShadowLights = getShadowLights();

  if (entity.kind === 'mesh') {
    const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial;
    extra = `
      <div class="property-group">
        <h3>MATERIAL</h3>
        <div class="property-row material-row">
          <label>Color</label>
          <input id="material-color" type="color" value="#${material.color.getHexString()}">
        </div>
        <div class="property-row material-row">
          <label>Roughness</label>
          <input id="material-roughness" type="range" min="0" max="1" step="0.01" value="${material.roughness}">
        </div>
        <div class="property-row material-row">
          <label>Metalness</label>
          <input id="material-metalness" type="range" min="0" max="1" step="0.01" value="${material.metalness}">
        </div>
        <p class="muted">Use the Texture button below to apply an image.</p>
      </div>

      <div class="property-group">
        <h3>LIGHT TRANSMISSION</h3>
        <label class="property-row">
          <span>Allow Light Through</span>
          <input
            id="light-transmission-enabled"
            type="checkbox"
            ${entity.lightTransmissionEnabled ? 'checked' : ''}
          >
        </label>

        <div id="transmission-light-list"
          style="display: ${entity.lightTransmissionEnabled ? 'block' : 'none'}">
          <p class="muted">Choose which lights can pass through this object:</p>
          ${availableShadowLights.map((light, index) => `
            <label class="property-row">
              <span>${light.name}</span>
              <input
                type="checkbox"
                data-transmission-light="${index}"
                ${entity.shadowExcludedLights?.has(light) ? 'checked' : ''}
              >
            </label>
          `).join('')}
        </div>
      </div>`;
  }

  if (entity.kind.includes('Light')) {
    const light = object as THREE.Light;
    extra = `
      <div class="property-group">
        <h3>LIGHT SETTINGS</h3>
        <div class="property-row material-row">
          <label>Color</label>
          <input id="light-color" type="color" value="#${light.color.getHexString()}">
        </div>
        <div class="property-row material-row">
          <label>Intensity</label>
          <input id="light-intensity" type="number" min="0" step="0.5" value="${light.intensity}">
        </div>
      </div>`;
  }

  if (entity.kind === 'camera') {
    const camera = object as THREE.PerspectiveCamera;
    extra = `
      <div class="property-group">
        <h3>CAMERA SETTINGS</h3>
        <div class="property-row material-row">
          <label>Field of View</label>
          <input id="camera-fov" type="number" min="10" max="120" value="${camera.fov}">
        </div>
        <button id="use-this-camera" class="wide-button">Preview This Camera</button>
      </div>`;
  }

  properties.innerHTML = `
    <div class="property-title">${entity.name}</div>
    ${vectorFields('LOCATION', 'position', object)}
    ${vectorFields('ROTATION (DEGREES)', 'rotation', object)}
    ${vectorFields('SCALE', 'scale', object)}
    ${extra}
  `;

  properties.querySelectorAll<HTMLInputElement>('input[data-property]').forEach(input => {
    input.addEventListener('change', () => {
      const [property, axis] = input.dataset.property!.split('.');
      const value = Number(input.value);
      if (!Number.isFinite(value)) return;

      if (property === 'rotation') {
        (object.rotation as any)[axis] = THREE.MathUtils.degToRad(value);
      } else {
        (object[property as 'position' | 'scale'] as any)[axis] = value;
      }
      updateHelpers();
    });
  });

  const transmissionEnabled = document.querySelector<HTMLInputElement>(
    '#light-transmission-enabled'
  );

  transmissionEnabled?.addEventListener('change', () => {
    if (entity.kind !== 'mesh') return;

    entity.lightTransmissionEnabled = transmissionEnabled.checked;
    applyMeshShadowLayers(entity);
    refreshProperties();
  });

  properties.querySelectorAll<HTMLInputElement>(
    'input[data-transmission-light]'
  ).forEach(input => {
    input.addEventListener('change', () => {
      if (entity.kind !== 'mesh') return;

      const index = Number(input.dataset.transmissionLight);
      const light = availableShadowLights[index];
      if (!light || light.shadowLayer === undefined) return;

      if (input.checked) {
        entity.shadowExcludedLights?.add(light);
      } else {
        entity.shadowExcludedLights?.delete(light);
      }

      applyMeshShadowLayers(entity);
    });
  });

  const colorInput = document.querySelector<HTMLInputElement>('#material-color');
  if (colorInput && entity.kind === 'mesh') {
    colorInput.addEventListener('input', () => {
      ((object as THREE.Mesh).material as THREE.MeshStandardMaterial).color.set(colorInput.value);
    });
  }

  const roughness = document.querySelector<HTMLInputElement>('#material-roughness');
  roughness?.addEventListener('input', () => {
    ((object as THREE.Mesh).material as THREE.MeshStandardMaterial).roughness = Number(roughness.value);
  });

  const metalness = document.querySelector<HTMLInputElement>('#material-metalness');
  metalness?.addEventListener('input', () => {
    ((object as THREE.Mesh).material as THREE.MeshStandardMaterial).metalness = Number(metalness.value);
  });

  const lightColor = document.querySelector<HTMLInputElement>('#light-color');
  lightColor?.addEventListener('input', () => (object as THREE.Light).color.set(lightColor.value));

  const intensity = document.querySelector<HTMLInputElement>('#light-intensity');
  intensity?.addEventListener('change', () => {
    (object as THREE.Light).intensity = Math.max(0, Number(intensity.value));
  });

  const fov = document.querySelector<HTMLInputElement>('#camera-fov');
  fov?.addEventListener('change', () => {
    const camera = object as THREE.PerspectiveCamera;
    camera.fov = THREE.MathUtils.clamp(Number(fov.value), 10, 120);
    camera.updateProjectionMatrix();
    updateHelpers();
  });

  document.querySelector<HTMLButtonElement>('#use-this-camera')?.addEventListener('click', () => {
    previewCamera = object as THREE.PerspectiveCamera;
    cameraStatus.textContent = `PREVIEW: ${entity.name.toUpperCase()}`;
    document.querySelector('#preview-camera')?.classList.add('active');
  });
}

function updateHelpers() {
  for (const entity of entities) {
    if (entity.helper instanceof THREE.CameraHelper) {
      entity.helper.update();
    } else if (entity.helper instanceof THREE.PointLightHelper) {
      entity.helper.update();
    } else if (entity.helper instanceof THREE.DirectionalLightHelper) {
      entity.helper.update();
    } else if (entity.helper instanceof THREE.SpotLightHelper) {
      entity.helper.update();
    }
  }
}


const assetItems = document.querySelector<HTMLDivElement>('#asset-library-items')!;
const assetSearch = document.querySelector<HTMLInputElement>('#asset-search')!;
let activeAssetCategory = 'All';
function renderAssetLibrary() {
  const query = assetSearch.value.trim().toLowerCase();
  const matches = NATURE_ASSETS.filter(asset =>
    (activeAssetCategory === 'All' || asset.category === activeAssetCategory) &&
    (asset.name.toLowerCase().includes(query) || asset.description.toLowerCase().includes(query))
  );
  assetItems.innerHTML = matches.map(asset => `
    <button class="asset-card" data-asset="${asset.type}" title="${asset.description}">
      <span class="asset-card-icon">${asset.icon}</span>
      <span class="asset-card-name">${asset.name}</span>
      <span class="asset-card-add">＋</span>
    </button>`).join('') || '<p class="muted asset-no-results">No assets match your search.</p>';
  assetItems.querySelectorAll<HTMLButtonElement>('[data-asset]').forEach(button =>
    button.addEventListener('click', () => addNatureAsset(button.dataset.asset as NatureAssetType))
  );
}
assetSearch.addEventListener('input', renderAssetLibrary);
document.querySelectorAll<HTMLButtonElement>('[data-asset-category]').forEach(button => {
  button.addEventListener('click', () => {
    activeAssetCategory = button.dataset.assetCategory!;
    document.querySelectorAll('[data-asset-category]').forEach(item => item.classList.toggle('active', item === button));
    renderAssetLibrary();
  });
});
renderAssetLibrary();

const addMenu = document.querySelector<HTMLDivElement>('#add-menu')!;
const addMenuToggle = document.querySelector<HTMLButtonElement>('#add-menu-toggle')!;
function setAddMenuOpen(open: boolean) {
  addMenu.classList.toggle('hidden', !open);
  addMenuToggle.setAttribute('aria-expanded', String(open));
}
addMenuToggle.addEventListener('click', () => setAddMenuOpen(addMenu.classList.contains('hidden')));
document.addEventListener('click', event => {
  if (!(event.target as HTMLElement).closest('.add-menu-wrap')) setAddMenuOpen(false);
});
document.querySelectorAll<HTMLButtonElement>('[data-add]').forEach(button => {
  button.addEventListener('click', () => {
    addObject(button.dataset.add!);
    setAddMenuOpen(false);
  });
});


// Asset painting: scatter procedural nature assets across the ground or terrain.
let assetPaintActive = false;
let assetBrushRadius = 8;
let assetBrushDensity = 5;
let assetPaintType: NatureAssetType = 'oakTree';
let activePaintFolderId: string | null = null;
let lastAssetStrokePoint: THREE.Vector3 | null = null;
const assetPaintRaycaster = new THREE.Raycaster();
const assetPaintPointer = new THREE.Vector2();
const assetBrushCursor = new THREE.Mesh(
  new THREE.RingGeometry(0.94, 1, 48),
  new THREE.MeshBasicMaterial({ color: 0x9bd18b, side: THREE.DoubleSide, depthTest: false })
);
assetBrushCursor.rotation.x = -Math.PI / 2;
assetBrushCursor.visible = false;
assetBrushCursor.renderOrder = 21;
scene.add(assetBrushCursor);

function setAssetPaintMode(active: boolean) {
  assetPaintActive = active;
  lastAssetStrokePoint = null;
  if (active) { const name = NATURE_ASSETS.find(asset => asset.type === assetPaintType)?.name ?? 'Assets'; const folder: ProjectFolder = { id: crypto.randomUUID(), name: `${name} Painted ${folders.filter(item => item.name.startsWith(name + ' Painted')).length + 1}` }; folders.push(folder); activePaintFolderId = folder.id; refreshOutliner(); } else activePaintFolderId = null;
  assetBrushCursor.visible = false;
  transform.enabled = !active && !terrainSculptActive;
  document.querySelector('#asset-paint-toolbar')?.classList.toggle('hidden', !active);
  document.querySelector('#asset-paint-toggle')?.classList.toggle('active', active);
  document.querySelector('#viewport')?.classList.toggle('asset-painting', active);
  if (active && terrainSculptActive) setTerrainSculptMode(false);
}

function getAssetPaintSurfaces(): THREE.Object3D[] {
  return [
    ground,
    ...entities.filter(entity => entity.kind === 'mesh' && entity.primitiveType === 'terrain').map(entity => entity.object)
  ];
}

function getAssetPaintHit(event: PointerEvent): THREE.Intersection<THREE.Object3D> | null {
  const bounds = renderer.domElement.getBoundingClientRect();
  assetPaintPointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  assetPaintPointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;
  assetPaintRaycaster.setFromCamera(assetPaintPointer, editorCamera);
  return assetPaintRaycaster.intersectObjects(getAssetPaintSurfaces(), false)[0] ?? null;
}

function assetWouldOverlap(position: THREE.Vector3, scale: number, type: NatureAssetType) {
  const baseSpacing: Record<NatureAssetType, number> = {
    oakTree: 2.2, pineTree: 1.65, boulder: 1.15, bush: 0.95, grassClump: 0.38
  };
  const minimumSpacing = baseSpacing[type] * scale;
  return entities.some(entity => {
    if (!entity.primitiveType || !['oakTree','pineTree','boulder','bush','grassClump'].includes(entity.primitiveType)) return false;
    const other = entity.object.position;
    return Math.hypot(other.x - position.x, other.z - position.z) < minimumSpacing;
  });
}

function placePaintedAsset(type: NatureAssetType, surfacePoint: THREE.Vector3) {
  const mesh = createNatureAssetMesh(type);
  if (!mesh) return false;
  const randomScale = document.querySelector<HTMLInputElement>('#asset-random-scale')?.checked ?? true;
  const scale = randomScale ? 0.72 + Math.random() * 0.62 : 1;
  mesh.scale.setScalar(scale);
  mesh.rotation.y = Math.random() * Math.PI * 2;
  const bounds = new THREE.Box3().setFromObject(mesh);
  mesh.position.set(surfacePoint.x, surfacePoint.y - bounds.min.y, surfacePoint.z);
  if (assetWouldOverlap(mesh.position, scale, type)) {
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
    return false;
  }
  registerEntity(mesh, 'mesh', undefined, false);
  entities[entities.length - 1].primitiveType = type;
  entities[entities.length - 1].folderId = activePaintFolderId ?? undefined;
  return true;
}

function paintAssetStamp(center: THREE.Vector3) {
  let placed = 0;
  const surfaces = getAssetPaintSurfaces();
  for (let i = 0; i < assetBrushDensity; i++) {
    const angle = Math.random() * Math.PI * 2;
    const distance = Math.sqrt(Math.random()) * assetBrushRadius;
    const x = center.x + Math.cos(angle) * distance;
    const z = center.z + Math.sin(angle) * distance;
    assetPaintRaycaster.set(new THREE.Vector3(x, center.y + 100, z), new THREE.Vector3(0, -1, 0));
    const hit = assetPaintRaycaster.intersectObjects(surfaces, false)[0];
    if (hit && placePaintedAsset(assetPaintType, hit.point)) placed++;
  }
  if (placed) refreshOutliner();
}

document.querySelector<HTMLButtonElement>('#asset-paint-toggle')?.addEventListener('click', () => {
  if (!assetPaintActive && terrainSculptActive) setTerrainSculptMode(false);
  setAssetPaintMode(!assetPaintActive);
});
document.querySelector<HTMLButtonElement>('#asset-paint-done')?.addEventListener('click', () => setAssetPaintMode(false));
document.querySelector<HTMLSelectElement>('#asset-paint-type')?.addEventListener('change', event => {
  assetPaintType = (event.target as HTMLSelectElement).value as NatureAssetType;
  if (assetPaintActive) {
    const name = NATURE_ASSETS.find(asset => asset.type === assetPaintType)?.name ?? 'Assets';
    const folder: ProjectFolder = { id: crypto.randomUUID(), name: `${name} Painted ${folders.filter(item => item.name.startsWith(name + ' Painted')).length + 1}` };
    folders.push(folder);
    activePaintFolderId = folder.id;
    refreshOutliner();
  }
});
document.querySelector<HTMLInputElement>('#asset-brush-size')?.addEventListener('input', event => {
  assetBrushRadius = Number((event.target as HTMLInputElement).value);
  document.querySelector('#asset-brush-size-value')!.textContent = String(assetBrushRadius);
  assetBrushCursor.scale.setScalar(assetBrushRadius);
});
document.querySelector<HTMLInputElement>('#asset-brush-density')?.addEventListener('input', event => {
  assetBrushDensity = Number((event.target as HTMLInputElement).value);
  document.querySelector('#asset-brush-density-value')!.textContent = String(assetBrushDensity);
});

renderer.domElement.addEventListener('pointerdown', event => {
  if (!assetPaintActive || event.button !== 0 || isPointerLocked) return;
  const hit = getAssetPaintHit(event);
  if (!hit) return;
  event.preventDefault();
  lastAssetStrokePoint = hit.point.clone();
  paintAssetStamp(hit.point);
  renderer.domElement.setPointerCapture(event.pointerId);
});
renderer.domElement.addEventListener('pointermove', event => {
  if (!assetPaintActive) return;
  const hit = getAssetPaintHit(event);
  if (!hit) {
    assetBrushCursor.visible = false;
    return;
  }
  assetBrushCursor.position.copy(hit.point);
  assetBrushCursor.position.y += 0.05;
  assetBrushCursor.scale.setScalar(assetBrushRadius);
  assetBrushCursor.visible = true;
  if (event.buttons === 1 && (!lastAssetStrokePoint || lastAssetStrokePoint.distanceTo(hit.point) > assetBrushRadius * 0.32)) {
    paintAssetStamp(hit.point);
    lastAssetStrokePoint = hit.point.clone();
  }
});
const stopAssetPaintStroke = () => { lastAssetStrokePoint = null; };
renderer.domElement.addEventListener('pointerup', stopAssetPaintStroke);
renderer.domElement.addEventListener('pointercancel', stopAssetPaintStroke);
window.addEventListener('pointerup', stopAssetPaintStroke);

function setTerrainSculptMode(active: boolean) {
  if (active && assetPaintActive) setAssetPaintMode(false);
  terrainSculptActive = active; isSculptingTerrain = false; brushCursor.visible = false; transform.enabled = !active && !assetPaintActive;
  document.querySelector('#terrain-toolbar')?.classList.toggle('hidden', !active);
  document.querySelector('#terrain-sculpt-toggle')?.classList.toggle('active', active);
  document.querySelector('#viewport')?.classList.toggle('sculpting', active);
  if (active && !(selected?.kind === 'mesh' && selected.primitiveType === 'terrain')) { alert('Select a terrain object in the Outliner before sculpting.'); setTerrainSculptMode(false); }
}
document.querySelector<HTMLButtonElement>('#terrain-sculpt-toggle')?.addEventListener('click', () => setTerrainSculptMode(!terrainSculptActive));
document.querySelector<HTMLButtonElement>('#terrain-sculpt-done')?.addEventListener('click', () => setTerrainSculptMode(false));
document.querySelectorAll<HTMLButtonElement>('[data-sculpt-mode]').forEach(button => button.addEventListener('click', () => { sculptMode=button.dataset.sculptMode as SculptMode; document.querySelectorAll<HTMLButtonElement>('[data-sculpt-mode]').forEach(item=>item.classList.toggle('active',item===button)); }));
document.querySelectorAll<HTMLButtonElement>('[data-terrain-tool]').forEach(button => button.addEventListener('click', () => {
  terrainToolMode = button.dataset.terrainTool as TerrainToolMode;
  document.querySelectorAll<HTMLButtonElement>('[data-terrain-tool]').forEach(item => item.classList.toggle('active', item === button));
  document.querySelector('#terrain-sculpt-controls')?.classList.toggle('hidden', terrainToolMode !== 'sculpt');
  document.querySelector('#terrain-paint-controls')?.classList.toggle('hidden', terrainToolMode !== 'paint');
  document.querySelector('.terrain-toolbar-title span')!.textContent = terrainToolMode === 'paint'
    ? 'Choose a material, then click and drag to paint'
    : 'Click and drag on the selected terrain';
}));
document.querySelector<HTMLSelectElement>('#terrain-paint-material')?.addEventListener('change', event => {
  selectedPaintMaterial = (event.target as HTMLSelectElement).value as TerrainPaintMaterial;
});
document.querySelector<HTMLInputElement>('#terrain-paint-opacity')?.addEventListener('input', event => {
  paintOpacity = Number((event.target as HTMLInputElement).value);
  document.querySelector('#terrain-paint-opacity-value')!.textContent = `${Math.round(paintOpacity * 100)}%`;
});
document.querySelector<HTMLInputElement>('#terrain-brush-size')?.addEventListener('input',event=>{ brushRadius=Number((event.target as HTMLInputElement).value); document.querySelector('#terrain-brush-size-value')!.textContent=brushRadius.toFixed(1); brushCursor.scale.setScalar(brushRadius); });
document.querySelector<HTMLInputElement>('#terrain-brush-strength')?.addEventListener('input',event=>{ brushStrength=Number((event.target as HTMLInputElement).value); document.querySelector('#terrain-brush-strength-value')!.textContent=`${Math.round(brushStrength*100)}%`; });
function getTerrainHit(event: PointerEvent): THREE.Intersection<THREE.Object3D> | null {
  if(!selected||selected.kind!=='mesh'||selected.primitiveType!=='terrain')return null;
  const bounds=renderer.domElement.getBoundingClientRect(); brushPointer.x=((event.clientX-bounds.left)/bounds.width)*2-1; brushPointer.y=-((event.clientY-bounds.top)/bounds.height)*2+1; brushRaycaster.setFromCamera(brushPointer,editorCamera); return brushRaycaster.intersectObject(selected.object,false)[0]??null;
}
renderer.domElement.addEventListener('pointerdown',event=>{ if(!terrainSculptActive||event.button!==0||isPointerLocked)return; const hit=getTerrainHit(event); if(!hit||!selected)return; event.preventDefault(); isSculptingTerrain=true; flattenHeight=selected.object.worldToLocal(hit.point.clone()).z; if(terrainToolMode==='paint'&&hit.uv) paintTerrainAt(selected.object as THREE.Mesh,hit.uv); else if(terrainToolMode==='sculpt') sculptTerrain(selected.object as THREE.Mesh,hit.point,sculptMode,brushRadius,brushStrength,flattenHeight); renderer.domElement.setPointerCapture(event.pointerId); });
renderer.domElement.addEventListener('pointermove',event=>{ if(!terrainSculptActive)return; const hit=getTerrainHit(event); if(hit){ brushCursor.position.copy(hit.point); brushCursor.position.y+=0.04; brushCursor.scale.setScalar(brushRadius); brushCursor.visible=true; } else brushCursor.visible=false; if(isSculptingTerrain&&hit&&selected){ if(terrainToolMode==='paint'&&hit.uv)paintTerrainAt(selected.object as THREE.Mesh,hit.uv); else if(terrainToolMode==='sculpt')sculptTerrain(selected.object as THREE.Mesh,hit.point,sculptMode,brushRadius,brushStrength,flattenHeight); } });
const stopTerrainSculpt=()=>{isSculptingTerrain=false;}; renderer.domElement.addEventListener('pointerup',stopTerrainSculpt); renderer.domElement.addEventListener('pointercancel',stopTerrainSculpt); window.addEventListener('pointerup',stopTerrainSculpt);

document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => {
  button.addEventListener('click', () => {
    transform.setMode(button.dataset.tool as 'translate' | 'rotate' | 'scale');
    setActiveTool(button.dataset.tool as 'translate' | 'rotate' | 'scale');
  });
});

document.querySelector<HTMLButtonElement>('#preview-camera')!.addEventListener('click', () => {
  previewCamera = null;
  cameraStatus.textContent = isPointerLocked ? 'CAMERA: FLY MODE' : 'CAMERA: FREE';
  document.querySelector('#preview-camera')?.classList.remove('active');
});

document.querySelector<HTMLInputElement>('#texture-file')!.addEventListener('change', event => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file || !selected || selected.kind !== 'mesh') {
    alert('Select a mesh before applying a texture.');
    return;
  }

  const url = URL.createObjectURL(file);
  new THREE.TextureLoader().load(url, texture => {
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = renderer.capabilities.getMaxAnisotropy();

    const material = (selected!.object as THREE.Mesh).material as THREE.MeshStandardMaterial;
    if (material.map) material.map.dispose();
    material.map = texture;
    material.color.set(0xffffff);
    material.needsUpdate = true;
    refreshProperties();
  });
});

transform.addEventListener('dragging-changed', event => {
  isDraggingTransform = Boolean(event.value);
});
transform.addEventListener('objectChange', () => {
  updateHelpers();
  refreshProperties();
});

renderer.domElement.addEventListener('contextmenu', event => event.preventDefault());
renderer.domElement.addEventListener('mousedown', event => {
  if (event.button === 2 && !isPointerLocked) renderer.domElement.requestPointerLock();
});

document.addEventListener('pointerlockchange', () => {
  isPointerLocked = document.pointerLockElement === renderer.domElement;
  if (isPointerLocked) previewCamera = null;
  cameraStatus.textContent = isPointerLocked ? 'CAMERA: FLY MODE' : 'CAMERA: FREE';
});

document.addEventListener('mousemove', event => {
  if (!isPointerLocked || isDraggingTransform) return;

  const euler = new THREE.Euler().setFromQuaternion(editorCamera.quaternion, 'YXZ');
  euler.y -= event.movementX * 0.002;
  euler.x -= event.movementY * 0.002;
  euler.x = THREE.MathUtils.clamp(euler.x, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
  editorCamera.quaternion.setFromEuler(euler);
});

document.addEventListener('keydown', event => {
  keys.add(event.code);
  if (['Space', 'ArrowUp', 'ArrowDown'].includes(event.code)) event.preventDefault();
});
document.addEventListener('keyup', event => keys.delete(event.code));
window.addEventListener('blur', () => keys.clear());

renderer.domElement.addEventListener('click', event => {
  if (terrainSculptActive || assetPaintActive || isPointerLocked || isDraggingTransform) return;

  const bounds = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;

  raycaster.setFromCamera(pointer, editorCamera);
  const meshes = entities.filter(e => e.kind === 'mesh').map(e => e.object);
  const hits = raycaster.intersectObjects(meshes, false);
  const entity = hits.length ? entities.find(e => e.object === hits[0].object) ?? null : null;
  selectEntity(entity, event.ctrlKey || event.metaKey, event.shiftKey);
});

async function textureToDataUrl(texture: THREE.Texture): Promise<string | undefined> {
  const image = texture.image as CanvasImageSource & { width?: number; height?: number };
  if (!image) return undefined;
  const width = image.width ?? 0;
  const height = image.height ?? 0;
  if (!width || !height) return undefined;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return undefined;

  try {
    context.drawImage(image, 0, 0);
    return canvas.toDataURL('image/png');
  } catch (error) {
    console.warn('Could not embed a texture in this project:', error);
    return undefined;
  }
}

async function serializeWorld(): Promise<WorldDocument> {
  const objects: ProjectObject[] = await Promise.all(entities.map(async entity => {
    const object = entity.object;
    const data: ProjectObject = {
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      position: object.position.toArray() as [number, number, number],
      rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
      scale: object.scale.toArray() as [number, number, number],
      folderId: entity.folderId
    };

    if (entity.kind === 'mesh') {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.MeshStandardMaterial;
      data.geometry = { type: entity.primitiveType ?? 'custom', parameters: entity.primitiveType === 'terrain' ? [(mesh.geometry as THREE.PlaneGeometry).parameters.width, (mesh.geometry as THREE.PlaneGeometry).parameters.height, (mesh.geometry as THREE.PlaneGeometry).parameters.widthSegments] : [] };
      if (entity.primitiveType === 'terrain') {
        const geometry = mesh.geometry as THREE.PlaneGeometry;
        data.terrainData = { width: geometry.parameters.width, depth: geometry.parameters.height, segments: geometry.parameters.widthSegments, heights: getTerrainHeights(geometry) };
      }
      data.material = {
        color: `#${material.color.getHexString()}`,
        roughness: material.roughness,
        metalness: material.metalness,
        vertexColors: material.vertexColors,
        textureDataUrl: material.map ? await textureToDataUrl(material.map) : undefined
      };
      data.lightTransmissionEnabled = Boolean(entity.lightTransmissionEnabled);
      data.shadowExcludedLightIds = [...(entity.shadowExcludedLights ?? [])].map(light => light.id);
    }

    if (entity.kind === 'pointLight') {
      const light = object as THREE.PointLight;
      data.light = {
        color: `#${light.color.getHexString()}`,
        intensity: light.intensity,
        distance: light.distance,
        decay: light.decay,
        castShadow: light.castShadow
      };
    } else if (entity.kind === 'directionalLight') {
      const light = object as THREE.DirectionalLight;
      data.light = {
        color: `#${light.color.getHexString()}`,
        intensity: light.intensity,
        castShadow: light.castShadow
      };
      data.targetPosition = light.target.position.toArray() as [number, number, number];
    } else if (entity.kind === 'spotLight') {
      const light = object as THREE.SpotLight;
      data.light = {
        color: `#${light.color.getHexString()}`,
        intensity: light.intensity,
        distance: light.distance,
        decay: light.decay,
        angle: light.angle,
        penumbra: light.penumbra,
        castShadow: light.castShadow
      };
      data.targetPosition = light.target.position.toArray() as [number, number, number];
    }

    if (entity.kind === 'camera') {
      const camera = object as THREE.PerspectiveCamera;
      data.camera = { fov: camera.fov, near: camera.near, far: camera.far };
    }
    return data;
  }));

  return {
    schemaVersion: 1,
    settings: {
      backgroundColor: scene.background instanceof THREE.Color
        ? `#${scene.background.getHexString()}`
        : '#8295a8',
      fog: { ...fogSettings },
      sun: {
        enabled: sunlight.visible,
        color: `#${sunlight.color.getHexString()}`,
        intensity: sunlight.intensity,
        position: sunlight.position.toArray() as [number, number, number]
      },
      ambient: {
        skyColor: `#${ambientLight.color.getHexString()}`,
        groundColor: `#${ambientLight.groundColor.getHexString()}`,
        intensity: ambientLight.intensity
      },
      ground: {
        enabled: ground.visible,
        color: `#${((ground.material as THREE.MeshStandardMaterial).color).getHexString()}`,
        size: (ground.geometry as THREE.PlaneGeometry).parameters.width
      }
    },
    objects,
    folders: folders.map(folder => ({ ...folder })),
    editorCamera: {
      position: editorCamera.position.toArray() as [number, number, number],
      rotation: [editorCamera.rotation.x, editorCamera.rotation.y, editorCamera.rotation.z]
    }
  };
}

function disposeEntity(entity: Entity) {
  scene.remove(entity.object);
  if (entity.kind === 'spotLight') {
    scene.remove((entity.object as THREE.SpotLight).target);
  }
  if (entity.object instanceof THREE.Mesh) {
    entity.object.geometry.dispose();
    const material = entity.object.material;
    (Array.isArray(material) ? material : [material]).forEach(item => {
      const standard = item as THREE.MeshStandardMaterial;
      standard.map?.dispose();
      item.dispose();
    });
  }
  if (entity.helper) {
    scene.remove(entity.helper);
    entity.helper.traverse(child => {
      const visual = child as THREE.Mesh;
      visual.geometry?.dispose();
      const material = visual.material;
      if (material) (Array.isArray(material) ? material : [material]).forEach(item => item.dispose());
    });
  }
}

async function loadWorld(world: WorldDocument) {
  clearSelectionTransform();
  transform.detach();
  for (const entity of [...entities]) disposeEntity(entity);
  entities.length = 0;
  selected = null;
  selectedEntities.clear();
  folders = (world.folders ?? []).map(folder => ({ ...folder }));
  collapsedFolders.clear();
  selectedFolderId = null;
  previewCamera = null;
  objectNumber = 0;

  scene.background = new THREE.Color(world.settings.backgroundColor);
  Object.assign(fogSettings, world.settings.fog);
  updateFog();

  sunlight.visible = world.settings.sun.enabled;
  sunlight.color.set(world.settings.sun.color);
  sunlight.intensity = world.settings.sun.intensity;
  sunlight.position.fromArray(world.settings.sun.position);
  ambientLight.color.set(world.settings.ambient.skyColor);
  ambientLight.groundColor.set(world.settings.ambient.groundColor);
  ambientLight.intensity = world.settings.ambient.intensity;

  ground.visible = world.settings.ground.enabled;
  (ground.material as THREE.MeshStandardMaterial).color.set(world.settings.ground.color);
  const groundSize = Math.max(1, world.settings.ground.size);
  ground.geometry.dispose();
  ground.geometry = new THREE.PlaneGeometry(groundSize, groundSize);

  editorCamera.position.fromArray(world.editorCamera.position);
  editorCamera.rotation.set(...world.editorCamera.rotation);

  const loadedById = new Map<string, Entity>();
  for (const data of world.objects) {
    let object: THREE.Object3D;
    let helper: THREE.Object3D | undefined;

    if (data.kind === 'mesh') {
      const type = data.geometry?.type ?? 'box';
      let geometry: THREE.BufferGeometry;
      if (type === 'terrain') {
        const terrain = data.terrainData;
        geometry = createTerrainGeometry(terrain?.width ?? 60, terrain?.depth ?? 60, terrain?.segments ?? 80, terrain?.heights);
      } else if (type === 'sphere') geometry = new THREE.SphereGeometry(1, 32, 20);
      else if (type === 'oakTree' || type === 'pineTree' || type === 'boulder' || type === 'bush' || type === 'grassClump') geometry = createNatureAsset(type);
      else if (type === 'cylinder') geometry = new THREE.CylinderGeometry(0.8, 0.8, 1.8, 32);
      else if (type === 'plane') geometry = new THREE.PlaneGeometry(3, 3);
      else geometry = new THREE.BoxGeometry(1.8, 1.8, 1.8);

      const material = new THREE.MeshStandardMaterial({
        color: data.material?.color ?? '#b9c5d5',
        roughness: data.material?.roughness ?? 0.72,
        metalness: data.material?.metalness ?? 0.05,
        vertexColors: data.material?.vertexColors ?? false
      });
      if (data.material?.textureDataUrl) {
        const texture = await new Promise<THREE.Texture | null>(resolve => {
          new THREE.TextureLoader().load(data.material!.textureDataUrl!, resolve, undefined, () => resolve(null));
        });
        if (texture) {
          texture.colorSpace = THREE.SRGBColorSpace;
          texture.wrapS = THREE.RepeatWrapping;
          texture.wrapT = THREE.RepeatWrapping;
          material.map = texture;
          material.color.set(0xffffff);
        }
      }
      object = new THREE.Mesh(geometry, material);
      if (type === 'terrain') { object.rotation.x = -Math.PI / 2; object.position.y = 0.015; }
      if (type === 'terrain' && (object as THREE.Mesh).material instanceof THREE.MeshStandardMaterial) {
        const restoredMaterial = (object as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (restoredMaterial.map) {
          const restoredImage = restoredMaterial.map.image as CanvasImageSource;
          createTerrainPaintMap(object as THREE.Mesh, restoredImage);
        } else {
          createTerrainPaintMap(object as THREE.Mesh);
        }
      }
      (object as THREE.Mesh).castShadow = true;
      (object as THREE.Mesh).receiveShadow = true;
    } else if (data.kind === 'pointLight') {
      const settings = data.light!;
      const light = new THREE.PointLight(settings.color, settings.intensity, settings.distance, settings.decay);
      light.castShadow = settings.castShadow;
      object = light;
      helper = new THREE.PointLightHelper(light, 0.35);
    } else if (data.kind === 'directionalLight') {
      const settings = data.light!;
      const light = new THREE.DirectionalLight(settings.color, settings.intensity);
      light.castShadow = settings.castShadow;
      object = light;
      helper = new THREE.DirectionalLightHelper(light, 1);
    } else if (data.kind === 'spotLight') {
      const settings = data.light!;
      const light = new THREE.SpotLight(
        settings.color, settings.intensity, settings.distance, settings.angle, settings.penumbra, settings.decay
      );
      light.castShadow = settings.castShadow;
      object = light;
      light.target.position.fromArray(data.targetPosition ?? [0, -1, -4]);
      scene.add(light.target);
      helper = new THREE.SpotLightHelper(light);
    } else {
      const settings = data.camera!;
      object = new THREE.PerspectiveCamera(settings.fov, 1, settings.near, settings.far);
      helper = new THREE.CameraHelper(object as THREE.PerspectiveCamera);
    }

    object.name = data.name;
    object.position.fromArray(data.position);
    object.rotation.set(...data.rotation);
    object.scale.fromArray(data.scale);
    registerEntity(object, data.kind, helper);
    const entity = entities[entities.length - 1];
    entity.id = data.id;
    entity.folderId = data.folderId;
    if (data.kind === 'mesh') {
      entity.primitiveType = data.geometry?.type === 'custom' ? 'box' : (data.geometry?.type ?? 'box') as Entity['primitiveType'];
      entity.lightTransmissionEnabled = Boolean(data.lightTransmissionEnabled);
    }
    loadedById.set(data.id, entity);
    if (data.kind === 'directionalLight' || data.kind === 'spotLight') {
      const light = object as THREE.DirectionalLight | THREE.SpotLight;
      if (data.targetPosition) light.target.position.fromArray(data.targetPosition);
    }
  }

  for (const data of world.objects) {
    const entity = loadedById.get(data.id);
    if (!entity || entity.kind !== 'mesh') continue;
    for (const lightId of data.shadowExcludedLightIds ?? []) {
      const light = loadedById.get(lightId);
      if (light) entity.shadowExcludedLights?.add(light);
    }
    applyMeshShadowLayers(entity);
  }

  selectEntity(null);
  refreshOutliner();
  refreshProperties();
  resize();
}

function makeEmptyWorld(): WorldDocument {
  return {
    schemaVersion: 1,
    settings: {
      backgroundColor: '#8295a8',
      fog: { enabled: true, color: '#8295a8', near: 45, far: 150 },
      sun: { enabled: true, color: '#ffedcf', intensity: 3, position: [12, 20, 8] },
      ambient: { skyColor: '#dceaff', groundColor: '#46505b', intensity: 2 },
      ground: { enabled: true, color: '#59635c', size: 200 }
    },
    objects: [],
    editorCamera: { position: [10, 8, 12], rotation: [0, 0, 0] }
  };
}


function setActiveTool(mode: 'translate' | 'rotate' | 'scale') {
  document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => {
    button.classList.toggle('active', button.dataset.tool === mode);
  });
}

document.querySelector<HTMLButtonElement>('#settings-button')?.addEventListener('click', openSettings);
document.querySelector<HTMLButtonElement>('#dashboard-settings-button')?.addEventListener('click', openSettings);
document.querySelector<HTMLButtonElement>('#close-settings')?.addEventListener('click', closeSettings);
document.querySelector<HTMLButtonElement>('#settings-done')?.addEventListener('click', closeSettings);
document.querySelector<HTMLSelectElement>('#theme-select')?.addEventListener('change', event => {
  preferences.theme = (event.target as HTMLSelectElement).value as AppPreferences['theme'];
  savePreferences();
  applyPreferences();
});
document.querySelector<HTMLSelectElement>('#density-select')?.addEventListener('change', event => {
  preferences.density = (event.target as HTMLSelectElement).value as AppPreferences['density'];
  savePreferences();
  applyPreferences();
});
document.querySelector<HTMLInputElement>('#accent-color')?.addEventListener('input', event => {
  preferences.accent = (event.target as HTMLInputElement).value;
  savePreferences();
  applyPreferences();
});
document.querySelector<HTMLInputElement>('#accent-hex')?.addEventListener('change', event => {
  const value = (event.target as HTMLInputElement).value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(value)) {
    preferences.accent = value;
    savePreferences();
    applyPreferences();
  } else {
    alert('Enter a valid six-digit hex color, such as #D2B16D.');
    applyPreferences();
  }
});
document.querySelectorAll<HTMLButtonElement>('[data-accent-preset]').forEach(button => {
  button.addEventListener('click', () => {
    preferences.accent = button.dataset.accentPreset!;
    savePreferences();
    applyPreferences();
  });
});
document.querySelectorAll<HTMLButtonElement>('[data-keybinding]').forEach(button => {
  button.addEventListener('click', () => {
    capturingKeybinding = button.dataset.keybinding as keyof AppPreferences['keybindings'];
    applyPreferences();
  });
});
document.querySelector<HTMLButtonElement>('#reset-preferences')?.addEventListener('click', () => {
  preferences = structuredClone(defaultPreferences);
  capturingKeybinding = null;
  savePreferences();
  applyPreferences();
});
applyPreferences();


const githubTokenKey = 'ces-github-token-session';
const githubTokenInput = document.querySelector<HTMLInputElement>('#github-token')!;
const githubStatus = document.querySelector<HTMLSpanElement>('#github-status')!;
const githubProjectList = document.querySelector<HTMLDivElement>('#github-project-list')!;
function getGitHubToken(): string | null {
  try { return sessionStorage.getItem(githubTokenKey); } catch { return null; }
}
function setGitHubStatus(message: string, connected = false) {
  githubStatus.textContent = message;
  githubStatus.classList.toggle('connected', connected);
}
async function refreshGitHubProjects() {
  const token = getGitHubToken();
  githubProjectList.innerHTML = '';
  if (!token) {
    githubProjectList.innerHTML = '<p class="muted">Connect to view projects in GitHub.</p>';
    return;
  }
  githubProjectList.innerHTML = '<p class="muted">Loading cloud projects…</p>';
  try {
    const projects = await listRemoteProjects(token);
    githubProjectList.innerHTML = '';
    if (!projects.length) {
      githubProjectList.innerHTML = '<p class="muted">No cloud projects yet. Open a local project and choose “Save to GitHub”.</p>';
      return;
    }
    for (const project of projects) {
      const card = document.createElement('div');
      card.className = 'project-card';
      const details = document.createElement('div');
      details.className = 'project-card-details';
      const title = document.createElement('strong');
      title.textContent = project.name;
      const updated = document.createElement('span');
      updated.textContent = `Cloud save · ${new Date(project.updatedAt).toLocaleString()}`;
      details.append(title, updated);
      const actions = document.createElement('div');
      actions.className = 'project-card-actions';
      const openButton = document.createElement('button');
      openButton.textContent = 'Download & Open';
      openButton.addEventListener('click', async () => {
        try {
          const latest = await loadRemoteProject(token, project.id);
          await saveProject(latest);
          currentProject = latest;
          await loadWorld(latest.world);
          currentProjectName.textContent = latest.name;
          projectManager.classList.remove('visible');
          document.querySelector('#editor-screen')?.classList.remove('hidden');
          saveStatus.textContent = 'LOADED FROM GITHUB';
        } catch (error) {
          alert(error instanceof Error ? error.message : 'Could not load this GitHub project.');
        }
      });
      actions.append(openButton);
      card.append(details, actions);
      githubProjectList.appendChild(card);
    }
  } catch (error) {
    githubProjectList.innerHTML = '<p class="muted">Could not load cloud projects.</p>';
    setGitHubStatus(error instanceof Error ? error.message : 'GitHub connection failed.');
  }
}
document.querySelector<HTMLButtonElement>('#github-connect-button')!.addEventListener('click', async () => {
  const token = githubTokenInput.value.trim();
  if (!token) { setGitHubStatus('Paste your token first.'); return; }
  const button = document.querySelector<HTMLButtonElement>('#github-connect-button')!;
  button.disabled = true;
  setGitHubStatus('Connecting…');
  try {
    await connectGitHub(token);
    sessionStorage.setItem(githubTokenKey, token);
    githubTokenInput.value = '';
    setGitHubStatus('Connected to private repository', true);
    await refreshGitHubProjects();
  } catch (error) {
    setGitHubStatus(error instanceof Error ? error.message : 'Could not connect.');
  } finally { button.disabled = false; }
});
document.querySelector<HTMLButtonElement>('#github-disconnect-button')!.addEventListener('click', () => {
  sessionStorage.removeItem(githubTokenKey);
  githubTokenInput.value = '';
  setGitHubStatus('Disconnected');
  githubProjectList.innerHTML = '<p class="muted">Connect to view projects in GitHub.</p>';
});
document.querySelector<HTMLButtonElement>('#github-refresh-button')!.addEventListener('click', () => void refreshGitHubProjects());
const existingGitHubToken = getGitHubToken();
if (existingGitHubToken) {
  void connectGitHub(existingGitHubToken).then(() => {
    setGitHubStatus('Connected to private repository', true);
    return refreshGitHubProjects();
  }).catch(() => {
    sessionStorage.removeItem(githubTokenKey);
    setGitHubStatus('Token rejected or access revoked. Reconnect to continue.');
  });
}

async function refreshProjectList() {
  const projects = await listProjects();
  projectListElement.innerHTML = '';
  if (!projects.length) {
    projectListElement.innerHTML = '<p class="muted project-empty">No projects yet. Create your first environment above.</p>';
    return;
  }

  for (const project of projects) {
    const card = document.createElement('div');
    card.className = 'project-card';
    const details = document.createElement('div');
    details.className = 'project-card-details';
    const title = document.createElement('strong');
    title.textContent = project.name;
    const updated = document.createElement('span');
    updated.textContent = `Last saved ${new Date(project.updatedAt).toLocaleString()}`;
    details.append(title, updated);

    const actions = document.createElement('div');
    actions.className = 'project-card-actions';
    const openButton = document.createElement('button');
    openButton.textContent = 'Open';
    openButton.addEventListener('click', async () => {
      currentProject = project;
      await loadWorld(project.world);
      currentProjectName.textContent = project.name;
      projectManager.classList.remove('visible');
      saveStatus.textContent = 'PROJECT OPENED';
      document.querySelector('#editor-screen')?.classList.remove('hidden');
    });
    const renameButton = document.createElement('button');
    renameButton.textContent = 'Rename';
    renameButton.addEventListener('click', async () => {
      const nextName = prompt('Enter a new project name:', project.name)?.trim();
      if (!nextName) return;
      project.name = nextName;
      project.updatedAt = Date.now();
      await saveProject(project);
      if (currentProject?.id === project.id) {
        currentProject = project;
        currentProjectName.textContent = nextName;
      }
      await refreshProjectList();
    });
    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'Delete';
    deleteButton.className = 'project-delete';
    deleteButton.addEventListener('click', async () => {
      if (!confirm(`Delete "${project.name}" permanently from this browser?`)) return;
      await deleteProject(project.id);
      if (currentProject?.id === project.id) currentProject = null;
      await refreshProjectList();
    });
    actions.append(openButton, renameButton, deleteButton);
    card.append(details, actions);
    projectListElement.appendChild(card);
  }
}

async function showProjectManager() {
  if (isPointerLocked) document.exitPointerLock();
  if (currentProject) {
    currentProject.world = await serializeWorld();
    currentProject.updatedAt = Date.now();
    await saveProject(currentProject);
    saveStatus.textContent = 'SAVED LOCALLY';
  }
  projectManager.classList.add('visible');
  document.querySelector('#editor-screen')?.classList.add('hidden');
  await refreshProjectList();
  if (getGitHubToken()) await refreshGitHubProjects();
}

document.querySelector<HTMLButtonElement>('#project-manager-button')!
  .addEventListener('click', () => void showProjectManager());

document.querySelector<HTMLButtonElement>('#create-project-button')!
  .addEventListener('click', async () => {
    const name = projectNameInput.value.trim() || 'Untitled Project';
    await loadWorld(makeEmptyWorld());
    const project = createProjectRecord(name, await serializeWorld());
    await saveProject(project);
    currentProject = project;
    currentProjectName.textContent = project.name;
    projectNameInput.value = '';
    projectManager.classList.remove('visible');
    document.querySelector('#editor-screen')?.classList.remove('hidden');
    saveStatus.textContent = 'PROJECT CREATED';
  });

document.querySelector<HTMLButtonElement>('#save-button')!
  .addEventListener('click', async () => {
    if (!currentProject) {
      await showProjectManager();
      return;
    }
    currentProject.world = await serializeWorld();
    currentProject.updatedAt = Date.now();
    await saveProject(currentProject);
    saveStatus.textContent = 'SAVED LOCALLY';
  });






document.querySelector<HTMLButtonElement>('#save-github-button')!.addEventListener('click', async () => {
  const token = getGitHubToken();
  if (!token) { alert('Connect GitHub in Settings first.'); return; }
  if (!currentProject) { alert('Open or create a project before saving it to GitHub.'); return; }
  const button = document.querySelector<HTMLButtonElement>('#save-github-button')!;
  button.disabled = true;
  saveStatus.textContent = 'SAVING TO GITHUB…';
  try {
    currentProject.world = await serializeWorld();
    currentProject.updatedAt = Date.now();
    await saveProject(currentProject);
    await saveRemoteProject(token, currentProject);
    saveStatus.textContent = 'SAVED LOCALLY + GITHUB';
  } catch (error) {
    saveStatus.textContent = 'GITHUB SAVE FAILED';
    alert(error instanceof Error ? error.message : 'Could not save this project to GitHub.');
  } finally { button.disabled = false; }
});

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);

  if (isPointerLocked) {
    const direction = new THREE.Vector3();
    editorCamera.getWorldDirection(direction);
    direction.y = 0;
    direction.normalize();

    const right = new THREE.Vector3().crossVectors(direction, editorCamera.up).normalize();
    const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 18 : 6) * delta;

    if (keys.has('KeyW')) editorCamera.position.addScaledVector(direction, speed);
    if (keys.has('KeyS')) editorCamera.position.addScaledVector(direction, -speed);
    if (keys.has('KeyD')) editorCamera.position.addScaledVector(right, speed);
    if (keys.has('KeyA')) editorCamera.position.addScaledVector(right, -speed);
    if (keys.has('KeyE') || keys.has('Space')) editorCamera.position.y += speed;
    if (keys.has('KeyQ') || keys.has('ControlLeft')) editorCamera.position.y -= speed;
  }

  renderer.render(scene, previewCamera ?? editorCamera);
}

animate();
refreshOutliner();
refreshProperties();
void showProjectManager();
