import * as THREE from 'three';
import type { EditableMeshData } from './EditableMesh';

export type ComponentMode = 'vertex' | 'edge' | 'face';

/** Viewport picking and visualization for editable mesh components. */
export class MeshComponentEditor {
  readonly group = new THREE.Group();
  readonly selected = new Set<string>();
  mode: ComponentMode = 'vertex';
  private vertexPoints: THREE.Points | null = null;
  private edgeLines: THREE.LineSegments | null = null;
  private faceMeshes: THREE.Mesh[] = [];

  constructor(private readonly mesh: THREE.Mesh, private readonly data: EditableMeshData) {
    this.group.name = 'Mesh Component Overlay';
    this.mesh.add(this.group);
    this.rebuild();
  }

  setMode(mode: ComponentMode) {
    this.mode = mode;
    this.selected.clear();
    this.rebuild();
  }

  toggle(id: string, additive: boolean) {
    if (!additive) this.selected.clear();
    if (additive && this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    this.updateColors();
  }

  clear() {
    this.mesh.remove(this.group);
    this.disposeOverlay();
  }

  pick(raycaster: THREE.Raycaster): string | null {
    if (this.mode === 'vertex' && this.vertexPoints) {
      const hit = raycaster.intersectObject(this.vertexPoints, false)[0];
      return hit?.index === undefined ? null : this.data.vertices[hit.index]?.id ?? null;
    }
    if (this.mode === 'edge' && this.edgeLines) {
      const hit = raycaster.intersectObject(this.edgeLines, false)[0];
      return hit?.index === undefined ? null : this.data.edges[Math.floor(hit.index / 2)]?.id ?? null;
    }
    if (this.mode === 'face') {
      const hits = raycaster.intersectObjects(this.faceMeshes, false);
      return (hits[0]?.object.userData.faceId as string | undefined) ?? null;
    }
    return null;
  }

  private disposeOverlay() {
    this.group.traverse(child => {
      const visual = child as THREE.Mesh | THREE.Points | THREE.LineSegments;
      if (visual.geometry) visual.geometry.dispose();
      const material = visual.material;
      if (material) (Array.isArray(material) ? material : [material]).forEach(item => item.dispose());
    });
    this.group.clear();
    this.vertexPoints = null;
    this.edgeLines = null;
    this.faceMeshes = [];
  }

  private rebuild() {
    this.disposeOverlay();
    if (this.mode === 'vertex') {
      const positions = this.data.vertices.flatMap(vertex => vertex.position);
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const colors = new Float32Array(this.data.vertices.length * 3);
      this.vertexPoints = new THREE.Points(geometry, new THREE.PointsMaterial({
        size: 12, sizeAttenuation: false, vertexColors: true, depthTest: false
      }));
      this.vertexPoints.renderOrder = 20;
      this.group.add(this.vertexPoints);
      this.updateColors();
      return;
    }
    if (this.mode === 'edge') {
      const byId = new Map(this.data.vertices.map(vertex => [vertex.id, vertex]));
      const positions: number[] = [];
      for (const edge of this.data.edges) {
        const a = byId.get(edge.vertices[0]), b = byId.get(edge.vertices[1]);
        if (a && b) positions.push(...a.position, ...b.position);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      const colors = new Float32Array(this.data.edges.length * 6);
      this.edgeLines = new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({
        vertexColors: true, depthTest: false, transparent: true, opacity: 1
      }));
      this.edgeLines.renderOrder = 19;
      this.group.add(this.edgeLines);
      this.updateColors();
      return;
    }
    const byId = new Map(this.data.vertices.map(vertex => [vertex.id, vertex]));
    for (const face of this.data.faces) {
      const corners = face.vertices.map(id => byId.get(id)).filter((v): v is NonNullable<typeof v> => Boolean(v));
      if (corners.length < 3) continue;
      const positions: number[] = [];
      for (let i = 1; i < corners.length - 1; i++) {
        positions.push(...corners[0].position, ...corners[i].position, ...corners[i + 1].position);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geometry.computeVertexNormals();
      const material = new THREE.MeshBasicMaterial({
        color: 0x4e9dff, side: THREE.DoubleSide, transparent: true,
        opacity: 0.045, depthWrite: false
      });
      const overlay = new THREE.Mesh(geometry, material);
      overlay.userData.faceId = face.id;
      overlay.renderOrder = 5;
      this.group.add(overlay);
      this.faceMeshes.push(overlay);
    }
    this.updateColors();
  }

  private updateColors() {
    if (this.vertexPoints) {
      const colors = new Float32Array(this.data.vertices.length * 3);
      this.data.vertices.forEach((vertex, i) => {
        const color = this.selected.has(vertex.id) ? new THREE.Color(0xffa52f) : new THREE.Color(0x39d7ff);
        colors.set([color.r, color.g, color.b], i * 3);
      });
      this.vertexPoints.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      this.vertexPoints.geometry.attributes.color.needsUpdate = true;
    }
    if (this.edgeLines) {
      const colors = new Float32Array(this.data.edges.length * 6);
      this.data.edges.forEach((edge, i) => {
        const color = new THREE.Color(this.selected.has(edge.id) ? 0xffa52f : 0x39d7ff);
        for (let j = 0; j < 2; j++) colors.set([color.r, color.g, color.b], i * 6 + j * 3);
      });
      this.edgeLines.geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      this.edgeLines.geometry.attributes.color.needsUpdate = true;
    }
    for (const face of this.faceMeshes) {
      const material = face.material as THREE.MeshBasicMaterial;
      const isSelected = this.selected.has(face.userData.faceId as string);
      material.color.set(isSelected ? 0xffa52f : 0x4e9dff);
      material.opacity = isSelected ? 0.42 : 0.045;
    }
  }
}
