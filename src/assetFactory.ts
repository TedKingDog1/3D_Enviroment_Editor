import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export type NatureAssetType = 'oakTree' | 'pineTree' | 'boulder' | 'bush' | 'grassClump';

function colorize(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation) {
  const count = geometry.getAttribute('position').count;
  const c = new THREE.Color(color);
  const values: number[] = [];
  for (let i = 0; i < count; i++) values.push(c.r, c.g, c.b);
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(values, 3));
  return geometry;
}

function part(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, position = new THREE.Vector3(), rotation = new THREE.Euler(), scale = new THREE.Vector3(1, 1, 1)) {
  geometry.applyMatrix4(new THREE.Matrix4().compose(position, new THREE.Quaternion().setFromEuler(rotation), scale));
  geometry.computeVertexNormals();
  return colorize(geometry, color);
}

function combine(parts: THREE.BufferGeometry[]) {
  // Normalize indexed and non-indexed primitives before merging.
  // Cylinder/Cone geometries are indexed, while Polyhedron geometries
  // such as IcosahedronGeometry may be non-indexed.
  const normalized = parts.map(g => {
    if (!g.index) return g;
    const converted = g.toNonIndexed();
    g.dispose();
    return converted;
  });
  const merged = mergeGeometries(normalized, false);
  normalized.forEach(g => g.dispose());
  if (!merged) throw new Error('Could not combine procedural asset geometry.');
  merged.computeBoundingSphere();
  return merged;
}

export function createNatureAsset(type: NatureAssetType): THREE.BufferGeometry {
  const pieces: THREE.BufferGeometry[] = [];
  if (type === 'oakTree') {
    pieces.push(part(new THREE.CylinderGeometry(0.22, 0.34, 3.2, 7), '#765037', new THREE.Vector3(0, 1.6, 0)));
    const crowns = [
      [0, 3.45, 0, 1.25], [-0.72, 3.05, 0.12, 0.82], [0.68, 3.12, -0.1, 0.88],
      [0.1, 4.05, 0.1, 0.78], [-0.2, 2.85, -0.58, 0.7]
    ];
    crowns.forEach(([x,y,z,s], i) => pieces.push(part(
      new THREE.IcosahedronGeometry(1, 1), ['#466b3c','#527b42','#608849'][i % 3],
      new THREE.Vector3(x,y,z), new THREE.Euler(0,i*0.7,0), new THREE.Vector3(s,s*0.88,s)
    )));
  } else if (type === 'pineTree') {
    pieces.push(part(new THREE.CylinderGeometry(0.16, 0.25, 4.1, 7), '#67452f', new THREE.Vector3(0,2.05,0)));
    for (let i=0;i<4;i++) {
      const radius = 1.35 - i*0.22;
      const height = 1.8 - i*0.12;
      pieces.push(part(new THREE.ConeGeometry(radius,height,8,1), i%2 ? '#315b43' : '#3d704d',
        new THREE.Vector3(0,1.45+i*0.78,0), new THREE.Euler(0,(i%2)*0.25,0)));
    }
  } else if (type === 'boulder') {
    const rock = new THREE.IcosahedronGeometry(1, 1);
    const p = rock.getAttribute('position') as THREE.BufferAttribute;
    for(let i=0;i<p.count;i++){
      const n=0.78+Math.random()*0.42;
      p.setXYZ(i,p.getX(i)*n,p.getY(i)*n*0.72,p.getZ(i)*n);
    }
    rock.computeVertexNormals();
    pieces.push(part(rock,'#777b78',new THREE.Vector3(0,0.62,0),new THREE.Euler(0.08,0.3,0.12),new THREE.Vector3(1.2,0.9,1)));
    pieces.push(part(new THREE.IcosahedronGeometry(0.42,0),'#92958e',new THREE.Vector3(-0.28,0.9,0.08),new THREE.Euler(0.2,0.4,0),new THREE.Vector3(1,0.65,0.9)));
  } else if (type === 'bush') {
    const clumps = [[0,0.55,0,0.72],[-0.48,0.42,0.1,0.52],[0.46,0.43,0.08,0.55],[0.05,0.42,-0.45,0.5]];
    clumps.forEach(([x,y,z,s],i)=>pieces.push(part(new THREE.IcosahedronGeometry(1,1),
      i%2 ? '#527b43' : '#638b4d',new THREE.Vector3(x,y,z),new THREE.Euler(0,i,0),new THREE.Vector3(s,s*0.8,s))));
  } else {
    for(let i=0;i<9;i++){
      const angle=i*2.399;
      const height=0.55+Math.random()*0.55;
      const lean=0.18+Math.random()*0.22;
      const blade=new THREE.ConeGeometry(0.12,height,4,1);
      pieces.push(part(blade,i%3===0?'#8a9b4d':i%3===1?'#637f3e':'#78934a',
        new THREE.Vector3(Math.cos(angle)*0.22,height*0.5,Math.sin(angle)*0.22),
        new THREE.Euler(lean*Math.cos(angle),0,-lean*Math.sin(angle))));
    }
  }
  return combine(pieces);
}

export const NATURE_ASSETS: { type: NatureAssetType; name: string; category: 'Trees' | 'Ground'; icon: string; description: string }[] = [
  { type: 'oakTree', name: 'Oak Tree', category: 'Trees', icon: '♣', description: 'Broad-canopy deciduous tree' },
  { type: 'pineTree', name: 'Pine Tree', category: 'Trees', icon: '♠', description: 'Layered evergreen conifer' },
  { type: 'boulder', name: 'Boulder', category: 'Ground', icon: '◆', description: 'Angular low-poly rock' },
  { type: 'bush', name: 'Bush', category: 'Ground', icon: '✿', description: 'Compact leafy shrub' },
  { type: 'grassClump', name: 'Grass Clump', category: 'Ground', icon: '〽', description: 'Small tuft of meadow grass' }
];
