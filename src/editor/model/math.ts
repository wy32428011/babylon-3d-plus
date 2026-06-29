export type Vector3Data = {
  x: number;
  y: number;
  z: number;
};

export function vector3(x = 0, y = 0, z = 0): Vector3Data {
  return { x, y, z };
}
