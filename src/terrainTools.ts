import * as THREE from 'three';

export type SculptMode = 'raise' | 'lower' | 'smooth' | 'flatten';

export function createTerrainGeometry(width=60, depth=60, segments=80, heights?: number[]): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(width, depth, segments, segments);
  const position = geometry.getAttribute('position') as THREE.BufferAttribute;
  if (heights && heights.length === position.count) {
    for (let i=0;i<position.count;i++) position.setZ(i,heights[i]);
  }
  position.needsUpdate=true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

export function getTerrainHeights(geometry: THREE.BufferGeometry): number[] {
  const position=geometry.getAttribute('position') as THREE.BufferAttribute;
  return Array.from({length:position.count},(_,i)=>position.getZ(i));
}

export function sculptTerrain(mesh: THREE.Mesh, worldPoint: THREE.Vector3, mode: SculptMode, radius: number, strength: number, flattenHeight: number): void {
  const geometry=mesh.geometry as THREE.BufferGeometry;
  const position=geometry.getAttribute('position') as THREE.BufferAttribute;
  const localPoint=mesh.worldToLocal(worldPoint.clone());
  const parameters=(geometry as THREE.PlaneGeometry).parameters;
  const segmentsX=Math.max(1,Math.round(parameters.widthSegments));
  const segmentsY=Math.max(1,Math.round(parameters.heightSegments));
  const rowLength=segmentsX+1;
  const before=mode==='smooth'?getTerrainHeights(geometry):[];
  for(let index=0;index<position.count;index++){
    const distance=Math.hypot(position.getX(index)-localPoint.x,position.getY(index)-localPoint.y);
    if(distance>radius)continue;
    const t=1-distance/radius;
    const falloff=t*t*(3-2*t);
    const current=position.getZ(index);
    if(mode==='raise') position.setZ(index,current+strength*0.09*falloff);
    else if(mode==='lower') position.setZ(index,current-strength*0.09*falloff);
    else if(mode==='flatten') position.setZ(index,THREE.MathUtils.lerp(current,flattenHeight,Math.min(1,strength*0.32*falloff)));
    else {
      const gx=index%rowLength, gy=Math.floor(index/rowLength);
      let total=0,count=0;
      for(let oy=-1;oy<=1;oy++)for(let ox=-1;ox<=1;ox++){
        const nx=gx+ox,ny=gy+oy;
        if(nx<0||nx>segmentsX||ny<0||ny>segmentsY)continue;
        total+=before[ny*rowLength+nx];count++;
      }
      position.setZ(index,THREE.MathUtils.lerp(current,count?total/count:current,Math.min(1,strength*0.22*falloff)));
    }
  }
  position.needsUpdate=true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}
