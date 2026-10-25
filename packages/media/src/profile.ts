import { requireCondition } from '../../contracts/src/errors.js';

export type MediaProfile={id:string;kind:'SYNTHETIC'|'MEASURED';enabled:boolean;maxImageBytes:number;maxWidth:number;maxHeight:number;maxPixels:number;
  maxFilesPerUpload:number;maxProjectPages:number;maxProjectSourceBytes:number;maxZipBytes:number;maxEntries:number;maxExpandedBytes:number;maxRatio:number;maxManifestBytes:number;maxTextLength:number;maxFontSize:number;maxBlocks:number;minReadableFontSizePx?:number};
// Bounds for owned test specimens. These numbers do not activate an unmeasured production profile.
export const syntheticProfile:MediaProfile={id:'synthetic-fixtures-v1',kind:'SYNTHETIC',enabled:true,maxImageBytes:8*1024*1024,maxWidth:2048,maxHeight:2048,maxPixels:2048*2048,
  maxFilesPerUpload:20,maxProjectPages:20,maxProjectSourceBytes:32*1024*1024,maxZipBytes:64*1024*1024,maxEntries:200,maxExpandedBytes:128*1024*1024,maxRatio:300,maxManifestBytes:2*1024*1024,maxTextLength:8000,maxFontSize:256,maxBlocks:200};
export const requireProfile=(profile:MediaProfile)=>requireCondition(profile.enabled,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
