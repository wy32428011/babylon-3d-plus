import type { ReferenceGlobeFrame,ReferenceImageMap,ReferencePainter,ReferencePainterConfiguration } from './referenceTypes';
export function globeState(referenceSeconds:number):ReferenceGlobeFrame;
export function createPainter(backCanvas:HTMLCanvasElement,effectsCanvas:HTMLCanvasElement,images:ReferenceImageMap,
  configuration:ReferencePainterConfiguration):ReferencePainter;
