import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import {
  createProjectRecord,
  deleteProject,
  listProjects,
  saveProject,
  type EntityKind,
  type ProjectObject,
  type StoredProject,
  type WorldDocument
} from './projectStorage';
import './style.css';

interface Entity {
  id: string;
  object: THREE.Object3D;
  kind: EntityKind;
  primitiveType?: 'box' | 'sphere' | 'cylinder' | 'plane';
  helper?: THREE.Object3D;
  name: string;
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

function registerEntity(object: THREE.Object3D, kind: EntityKind, helper?: THREE.Object3D) {
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

  selectEntity(entity);
  refreshOutliner();
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

function selectEntity(entity: Entity | null) {
  selected = entity;
  transform.detach();

  if (entity) {
    transform.attach(entity.object);
    selectionStatus.textContent = `SELECTED: ${entity.name.toUpperCase()}`;
  } else {
    selectionStatus.textContent = 'NO OBJECT SELECTED';
  }

  refreshOutliner();
  refreshProperties();
}

function deleteSelected() {
  if (!selected) return;

  const target = selected;

  // Detach the transform gizmo before removing the entity.
  transform.detach();

  // Remove the entity from the scene and entity registry.
  scene.remove(target.object);

  const index = entities.indexOf(target);
  if (index !== -1) entities.splice(index, 1);

  if (target.shadowLayer !== undefined) {
    for (const entity of entities) {
      if (entity.kind === 'mesh') {
        entity.shadowExcludedLights?.delete(target);
        applyMeshShadowLayers(entity);
      }
    }
  }

  // Dispose mesh resources when the entity is a mesh.
  if (target.object instanceof THREE.Mesh) {
    target.object.geometry.dispose();

    const material = target.object.material;
    if (Array.isArray(material)) {
      material.forEach(item => item.dispose());
    } else {
      material.dispose();
    }
  }

  // Remove and dispose camera/light helper resources.
  if (target.helper) {
    scene.remove(target.helper);

    target.helper.traverse(child => {
      const visual = child as THREE.Mesh;
      if (visual.geometry) visual.geometry.dispose();

      const material = (child as THREE.Mesh).material;
      if (material) {
        if (Array.isArray(material)) {
          material.forEach(item => item.dispose());
        } else {
          material.dispose();
        }
      }
    });
  }

  selected = null;
  selectionStatus.textContent = 'NO OBJECT SELECTED';

  refreshOutliner();
  refreshProperties();
}

document.querySelector<HTMLButtonElement>('#delete-button')!
  .addEventListener('click', deleteSelected);

document.addEventListener('keydown', event => {
  if (
    (event.code === 'Delete' || event.code === 'Backspace') &&
    !['INPUT', 'TEXTAREA'].includes((event.target as HTMLElement)?.tagName ?? '') &&
    !isPointerLocked
  ) {
    event.preventDefault();
    deleteSelected();
  }
});

function refreshOutliner() {
  objectList.innerHTML = '';

  for (const entity of entities) {
    const entry = document.createElement('button');
    entry.className = `object-entry${entity === selected ? ' selected' : ''}`;

    const icon = entity.kind === 'mesh' ? '◇'
      : entity.kind === 'camera' ? '▣'
      : '☼';

    entry.textContent = `${icon}  ${entity.name}`;
    entry.addEventListener('click', () => selectEntity(entity));
    objectList.appendChild(entry);
  }
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

document.querySelectorAll<HTMLButtonElement>('[data-add]').forEach(button => {
  button.addEventListener('click', () => addObject(button.dataset.add!));
});

document.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach(button => {
  button.addEventListener('click', () => {
    transform.setMode(button.dataset.tool as 'translate' | 'rotate' | 'scale');
    document.querySelectorAll('[data-tool]').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
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
  if (isPointerLocked || isDraggingTransform) return;

  const bounds = renderer.domElement.getBoundingClientRect();
  pointer.x = ((event.clientX - bounds.left) / bounds.width) * 2 - 1;
  pointer.y = -((event.clientY - bounds.top) / bounds.height) * 2 + 1;

  raycaster.setFromCamera(pointer, editorCamera);
  const meshes = entities.filter(e => e.kind === 'mesh').map(e => e.object);
  const hits = raycaster.intersectObjects(meshes, false);
  const entity = hits.length ? entities.find(e => e.object === hits[0].object) ?? null : null;
  selectEntity(entity);
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
      scale: object.scale.toArray() as [number, number, number]
    };

    if (entity.kind === 'mesh') {
      const mesh = object as THREE.Mesh;
      const material = mesh.material as THREE.MeshStandardMaterial;
      data.geometry = { type: entity.primitiveType ?? 'custom', parameters: [] };
      data.material = {
        color: `#${material.color.getHexString()}`,
        roughness: material.roughness,
        metalness: material.metalness,
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
  transform.detach();
  for (const entity of [...entities]) disposeEntity(entity);
  entities.length = 0;
  selected = null;
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
      if (type === 'sphere') geometry = new THREE.SphereGeometry(1, 32, 20);
      else if (type === 'cylinder') geometry = new THREE.CylinderGeometry(0.8, 0.8, 1.8, 32);
      else if (type === 'plane') geometry = new THREE.PlaneGeometry(3, 3);
      else geometry = new THREE.BoxGeometry(1.8, 1.8, 1.8);

      const material = new THREE.MeshStandardMaterial({
        color: data.material?.color ?? '#b9c5d5',
        roughness: data.material?.roughness ?? 0.72,
        metalness: data.material?.metalness ?? 0.05
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
    if (data.kind === 'mesh') {
      entity.primitiveType = data.geometry?.type === 'custom' ? 'box' : (data.geometry?.type ?? 'box');
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

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]!);
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
  projectManager.classList.add('visible');
  await refreshProjectList();
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

document.querySelector<HTMLButtonElement>('#close-project-manager')!
  .addEventListener('click', () => {
    if (currentProject) projectManager.classList.remove('visible');
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
