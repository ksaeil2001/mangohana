import type {RenderSpecification} from '../../contracts/src/wire.generated.js';
export type RendererVersion=NonNullable<RenderSpecification['blocks'][number]['rendererVersion']>;
export const overflowRendererVersion='pango-overflow-v2' as const;
export const balloonRendererVersion='pango-balloon-v3' as const;
export const isOverflowRenderer=(version:unknown)=>version===overflowRendererVersion||version===balloonRendererVersion;
// The existing stored renderer version keeps automatic layout replayable without
// turning an inferred area into a user typesetBox. Older policies stay explicit.
export const proposalRendererVersion=(captured:RendererVersion|undefined):RendererVersion=>captured===balloonRendererVersion?balloonRendererVersion:overflowRendererVersion;
export const manualRendererVersion=(captured:RendererVersion|undefined,returnToSource=false):RendererVersion=>!returnToSource&&captured===balloonRendererVersion?balloonRendererVersion:overflowRendererVersion;
export const pageRendererVersion=(versions:(RendererVersion|undefined)[])=>versions.includes(balloonRendererVersion)?'pango-mixed-v3':versions.includes(overflowRendererVersion)?'pango-mixed-v2':'pango-canonical-v1';
