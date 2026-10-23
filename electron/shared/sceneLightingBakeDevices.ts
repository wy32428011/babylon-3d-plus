export type LightingBakeDevicePreference = 'cpu' | 'auto' | 'gpu';
export type LightingBakeDevice = { id: string; name: string; backend: string; type: 'CPU' | 'GPU' };
export type LightingBakeDeviceSelection = { requested: LightingBakeDevicePreference; actual: 'CPU' | 'GPU'; name: string; backend: string; fallbackReason?: string };
