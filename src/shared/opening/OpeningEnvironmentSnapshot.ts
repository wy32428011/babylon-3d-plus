export type OpeningEnvironmentPart = {
  sourceMeshId: string;
  name: string;
  positions: Float32Array;
  indices: Uint32Array | null;
  worldMatrix: number[];
};

/** 同源实例共享独立 CPU 副本数组，不持有业务材质或 GPU 资源。 */
export type OpeningEnvironmentSnapshot = {
  parts: OpeningEnvironmentPart[];
  bounds: {
    minimum: { x: number; y: number; z: number };
    maximum: { x: number; y: number; z: number };
  };
};
