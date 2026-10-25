import {DomainError} from '../../contracts/src/errors.js';
import type {RendererVersion} from './render.js';

type Bounds={left:number;top:number;width:number;height:number};
export type BlockLayout={regionId:string;rendererVersion:RendererVersion;fontSizePx:number;minimumFontSizePx:number;fallbackAtMinimum:boolean;angleDegrees:number;glyphBounds:Bounds|null;glyphPixels:number;glyphPixelsOutsidePolygon:number;glyphPixelsOutsidePage:number;glyphPixelsInsideOtherPolygons:{regionId:string;pixels:number}[]};
export type RenderLayout={rendererVersion:string;qa:'NOT_RUN'|'REVIEW_REQUIRED'|'HOLD';holdReasons:string[];blocks:BlockLayout[]};
export type RenderedPage={bytes:Buffer|null;layout:RenderLayout;overlays:{regionId:string;bytes:Buffer;bounds:Bounds}[]};
// A shared pure error preserves HOLD identity without loading Sharp in the supervising process.
export class RenderLayoutHold extends DomainError{constructor(readonly result:RenderedPage){super('RENDER_QA_HOLD',409,'WAIT');}}
