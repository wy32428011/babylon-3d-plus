import type { OpeningRoute } from '../../../shared/opening/openingPackage';

export type ReferenceOpeningSize = {
  width:number;height:number;dpr:number;scale:number;ox:number;oy:number;viewW:number;viewH:number;
};
export type ReferenceGlobeFrame = {morph:number;yaw:number;pitch:number};
export type ReferenceImageMap = Readonly<Record<number,HTMLImageElement>>;
export type ReferenceRendererOptions = {images:ReferenceImageMap;atlas:HTMLImageElement;onLost?:()=>void};
export type ReferenceGlobeRenderer = {
  kind:string;
  resize(size:ReferenceOpeningSize):void;
  draw(frame:ReferenceGlobeFrame):void;
  dispose():void;
};
export type ReferencePainterConfiguration = {
  worldOrigin:readonly [number,number];
  chinaOrigin:readonly [number,number];
  worldDestinations:ReadonlyArray<readonly [string,number,number]>;
  chinaDestinations:ReadonlyArray<readonly [string,number,number]>;
  worldRoutesEnabled:boolean;
  chinaRoutesEnabled:boolean;
  worldRouteOverrides?:readonly OpeningRoute[];
  chinaRouteOverrides?:readonly OpeningRoute[];
  breathing:{enabled:boolean;intensity:number;periodSeconds:number};
};
export type ReferencePainter = {
  resize(size:ReferenceOpeningSize):void;
  draw(referenceSeconds:number,globeAvailable?:boolean,elapsedSeconds?:number):void;
  dispose():void;
};
