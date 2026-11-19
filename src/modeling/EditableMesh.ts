import * as THREE from 'three';

export type VertexId = string;
export type EdgeId = string;
export type FaceId = string;
export type Vec2Tuple = [number, number];
export type Vec3Tuple = [number, number, number];

export interface EditableVertex {
  id: VertexId;
  position: Vec3Tuple;
}

export interface EditableEdge {
  id: EdgeId;
  vertices: [VertexId, VertexId];
  faces: FaceId[];
}

export interface EditableFace {
  id: FaceId;
  vertices: VertexId[];
  /** One UV coordinate per face corner, in the same order as vertices. */
  uvs?: Vec2Tuple[];
  materialIndex?: number;
}

export interface EditableMeshData {
  version: 1;
  vertices: EditableVertex[];
  edges: EditableEdge[];
  faces: EditableFace[];
}

export interface EditableMeshStats {
  vertices: number;
  edges: number;
  faces: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
}

const makeId = (prefix: string) => `${prefix}_${crypto.randomUUID()}`;
const edgeKey = (a: string, b: string) => a < b ? `${a}| ${b}` : `${b}| ${a}`;

export function rebuildEditableEdges(mesh: EditableMeshData): EditableEdge[] {
  const byKey = new Map<string, EditableEdge>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.vertices.length; i++) {
      const a = face.vertices[i];
      const b = face.vertices[(i + 1) % face.vertices.length];
      if (a === b) continue;
      const key = edgeKey(a, b);
      let edge = byKey.get(key);
      if (!edge) {
        edge = { id: makeId('e'), vertices: [a, b], faces: [] };
        byKey.set(key, edge);
      }
      if (!edge.faces.includes(face.id)) edge.faces.push(face.id);
    }
  }
  return [...byKey.values()];
}

export function validateEditableMesh(mesh: EditableMeshData): string[] {
  const errors: string[] = [];
  const vertexIds = new Set(mesh.vertices.map(vertex => vertex.id));
  const faceIds = new Set(mesh.faces.map(face => face.id));
  if (vertexIds.size !== mesh.vertices.length) errors.push('Vertex IDs must be unique.');
  if (faceIds.size !== mesh.faces.length) errors.push('Face IDs must be unique.');
  for (const vertex of mesh.vertices) {
    if (!vertex.position.every(Number.isFinite)) errors.push(`Vertex ${vertex.id} has a non-finite position.`);
  }
  for (const face of mesh.faces) {
    if (face.vertices.length < 3) errors.push(`Face ${face.id} has fewer than three corners.`);
    if (new Set(face.vertices).size !== face.vertices.length) errors.push(`Face ${face.id} repeats a vertex.`);
    if (face.vertices.some(id => !vertexIds.has(id))) errors.push(`Face ${face.id} references a missing vertex.`);
    if (face.uvs && face.uvs.length !== face.vertices.length) errors.push(`Face ${face.id} has an invalid UV corner count.`);
    if (face.uvs?.some(uv => !uv.every(Number.isFinite))) errors.push(`Face ${face.id} has a non-finite UV.`);
  }
  for (const edge of mesh.edges) {
    if (edge.vertices[0] === edge.vertices[1]) errors.push(`Edge ${edge.id} has identical endpoints.`);
    if (edge.vertices.some(id => !vertexIds.has(id))) errors.push(`Edge ${edge.id} references a missing vertex.`);
    if (edge.faces.some(id => !faceIds.has(id))) errors.push(`Edge ${edge.id} references a missing face.`);
  }
  return [...new Set(errors)];
}

export function getEditableMeshStats(mesh: EditableMeshData): EditableMeshStats {
  return {
    vertices: mesh.vertices.length,
    edges: mesh.edges.length,
    faces: mesh.faces.length,
    boundaryEdges: mesh.edges.filter(edge => edge.faces.length === 1).length,
    nonManifoldEdges: mesh.edges.filter(edge => edge.faces.length > 2).length
  };
}

export function createBoxEditableMesh(width = 1.8, height = 1.8, depth = 1.8): EditableMeshData {
  const x = width / 2, y = height / 2, z = depth / 2;
  const points: Vec3Tuple[] = [
    [-x, -y, -z], [x, -y, -z], [x, y, -z], [-x, y, -z],
    [-x, -y, z], [x, -y, z], [x, y, z], [-x, y, z]
  ];
  const vertices = points.map(position => ({ id: makeId('v'), position }));
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3],
    [1, 2, 6, 5], [3, 7, 6, 2], [0, 1, 5, 4]
  ];
  const faces = quads.map((corners, index) => ({
    id: makeId('f'),
    vertices: corners.map(corner => vertices[corner].id),
    uvs: [[0, 0], [1, 0], [1, 1], [0, 1]] as Vec2Tuple[],
    materialIndex: 0
  }));
  const mesh: EditableMeshData = { version: 1, vertices, edges: [], faces };
  mesh.edges = rebuildEditableEdges(mesh);
  return mesh;
}

/** Converts indexed or non-indexed Three.js triangles into editable triangle topology. */
export function editableMeshFromBufferGeometry(geometry: THREE.BufferGeometry, tolerance = 1e-6): EditableMeshData {
  const position = geometry.getAttribute('position');
  if (!position) throw new Error('Cannot convert geometry without a position attribute.');
  const uv = geometry.getAttribute('uv');
  const index = geometry.getIndex();
  const vertexMap = new Map<string, EditableVertex>();
  const vertices: EditableVertex[] = [];
  const sourceToEditable = new Map<number, VertexId>();
  const quantize = (value: number) => Math.round(value / tolerance);
  const getVertex = (sourceIndex: number): VertexId => {
    const existing = sourceToEditable.get(sourceIndex);
    if (existing) return existing;
    const p = new THREE.Vector3().fromBufferAttribute(position, sourceIndex);
    const key = `${quantize(p.x)},${quantize(p.y)},${quantize(p.z)}`;
    let vertex = vertexMap.get(key);
    if (!vertex) {
      vertex = { id: makeId('v'), position: [p.x, p.y, p.z] };
      vertexMap.set(key, vertex);
      vertices.push(vertex);
    }
    sourceToEditable.set(sourceIndex, vertex.id);
    return vertex.id;
  };
  const indices = index ? Array.from(index.array) : Array.from({ length: position.count }, (_, i) => i);
  if (indices.length % 3 !== 0) throw new Error('Geometry index count must describe complete triangles.');
  const faces: EditableFace[] = [];
  for (let i = 0; i < indices.length; i += 3) {
    const sourceIndices = indices.slice(i, i + 3);
    const ids = sourceIndices.map(getVertex);
    if (new Set(ids).size !== 3) continue;
    faces.push({
      id: makeId('f'),
      vertices: ids,
      uvs: uv ? sourceIndices.map(sourceIndex => [uv.getX(sourceIndex), uv.getY(sourceIndex)] as Vec2Tuple) : undefined,
      materialIndex: geometry.groups.find(group => i >= group.start && i < group.start + group.count)?.materialIndex ?? 0
    });
  }
  const mesh: EditableMeshData = { version: 1, vertices, edges: [], faces };
  mesh.edges = rebuildEditableEdges(mesh);
  const errors = validateEditableMesh(mesh);
  if (errors.length) throw new Error(`Generated invalid editable mesh: ${errors[0]}`);
  return mesh;
}

/** Builds a flat-shaded render buffer from polygon faces, triangulating n-gons as a fan. */
export function editableMeshToBufferGeometry(mesh: EditableMeshData): THREE.BufferGeometry {
  const errors = validateEditableMesh(mesh);
  if (errors.length) throw new Error(`Invalid editable mesh: ${errors[0]}`);
  const vertexById = new Map(mesh.vertices.map(vertex => [vertex.id, vertex]));
  const positions: number[] = [];
  const uvs: number[] = [];
  const groups: { start: number; count: number; materialIndex: number }[] = [];
  for (const face of mesh.faces) {
    const start = positions.length / 3;
    const corners = face.vertices.map(id => vertexById.get(id)!);
    for (let i = 1; i < corners.length - 1; i++) {
      const triangleCorners = [0, i, i + 1];
      for (const cornerIndex of triangleCorners) {
        const corner = corners[cornerIndex];
        positions.push(...corner.position);
        const faceUv = face.uvs?.[cornerIndex] ?? [0, 0];
        uvs.push(faceUv[0], faceUv[1]);
      }
    }
    const count = positions.length / 3 - start;
    if (count) {
      const previous = groups[groups.length - 1];
      if (previous && previous.materialIndex === (face.materialIndex ?? 0)) previous.count += count;
      else groups.push({ start, count, materialIndex: face.materialIndex ?? 0 });
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  groups.forEach(group => geometry.addGroup(group.start, group.count, group.materialIndex));
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return geometry;
}

export function cloneEditableMesh(mesh: EditableMeshData): EditableMeshData {
  return structuredClone(mesh);
}
