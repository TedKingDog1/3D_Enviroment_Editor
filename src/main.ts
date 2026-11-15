import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import './style.css';

type EntityKind = 'mesh' | 'pointLight' | 'directionalLight' | 'spotLight' | 'camera';

interface Entity {
  object: THREE.Object3D;
  kind: EntityKind;
  helper?: THREE.Object3D;
  name: string;
  shadowLayer?: number;
  shadowExcludedLights?: Set<Entity>;
  lightTransmissionEnabled?: boolean;
}

const viewport = document.querySelector<HTMLDivElement>('#viewport')!;
const objectList = document.querySelector<HTMLDivElement>('#object-list')!;
const properties = document.querySelector<HTMLDivElement>('#properties')!;
const cameraStatus = document.querySelector<HTMLSpanElement>('#camera-status')!;
const selectionStatus = document.querySelector<HTMLSpanElement>('#selection-status')!;

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

scene.add(new THREE.HemisphereLight(0xdceaff, 0x46505b, 2));

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

function refreshProperties() {
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

document.querySelector<HTMLButtonElement>('#save-button')!.addEventListener('click', () => {
  const world = {
    name: 'Untitled World',
    objects: entities.map(entity => {
      const object = entity.object;
      const data: any = {
        name: entity.name,
        kind: entity.kind,
        position: object.position.toArray(),
        rotation: [object.rotation.x, object.rotation.y, object.rotation.z],
        scale: object.scale.toArray()
      };

      if (entity.kind === 'mesh') {
        const material = (object as THREE.Mesh).material as THREE.MeshStandardMaterial;
        data.color = `#${material.color.getHexString()}`;
        data.roughness = material.roughness;
        data.metalness = material.metalness;
        data.textureApplied = Boolean(material.map);
      }

      if (entity.kind.includes('Light')) {
        const light = object as THREE.Light;
        data.color = `#${light.color.getHexString()}`;
        data.intensity = light.intensity;
      }

      if (entity.kind === 'camera') data.fov = (object as THREE.PerspectiveCamera).fov;
      return data;
    })
  };

  const blob = new Blob([JSON.stringify(world, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'untitled-world.json';
  link.click();
  URL.revokeObjectURL(url);
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
