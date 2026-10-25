import reference from '../../contracts/schemas/measurement-profile.json';
import {requireCondition} from '../../contracts/src/errors.js';
import type {MediaProfile} from '../../media/src/profile.js';

export type LimitName=keyof typeof reference.limits;
type CostLimit='maxRequestCostUsd'|'maxDailyOperatorSpendUsd';
export type Limits={ [K in LimitName]:K extends CostLimit?string|null:number|null };
export type MediaBounds={maxWidth:number;maxHeight:number;maxTextLength:number;maxFontSize:number;maxBlocks:number};
export type MeasurementProfile={version:string;state:'UNMEASURED'|'MEASURED';evidenceReferences:string[];limits:Limits;realProviderEnabled:boolean;paidExecutionEnabled:boolean;purchaseEnabled:boolean;fixedProtocolLimits:typeof reference.fixedProtocolLimits;mediaBounds?:MediaBounds};
const limitNames=Object.keys(reference.limits) as LimitName[];
const costNames:CostLimit[]=['maxRequestCostUsd','maxDailyOperatorSpendUsd'];
const fractionalNames:LimitName[]=['maxArchiveRatio','minReadableFontSizePx'];
const implemented=new Set<LimitName>(['maxFileBytes','maxPixelsPerPage','maxFilesPerUpload','maxWorkspacePages','maxWorkspaceBytes','maxArchiveCompressedBytes','maxArchiveExpandedBytes','maxArchiveEntries','maxArchiveRatio','maxManifestBytes','minReadableFontSizePx']);
const object=(input:unknown):Record<string,unknown>=>{requireCondition(!!input&&typeof input==='object'&&!Array.isArray(input),'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');return input as Record<string,unknown>;};
const positive=(value:unknown,integer=true):value is number=>typeof value==='number'&&Number.isFinite(value)&&value>0&&value<=Number.MAX_SAFE_INTEGER&&(!integer||Number.isSafeInteger(value));
const decimal=(value:unknown):value is string=>typeof value==='string'&&/^(?:0|[1-9]\d{0,11})(?:\.\d{1,12})?$/.test(value)&&/[1-9]/.test(value);
const exactKeys=(value:Record<string,unknown>,keys:string[])=>requireCondition(Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key)),'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');

// The existing frozen profile defines the sixteen names. NULL never means unlimited.
export function validateMeasurementProfile(input:unknown):MeasurementProfile{
  const value=object(input);const keys=Object.keys(reference);if(Object.hasOwn(value,'mediaBounds'))keys.push('mediaBounds');exactKeys(value,keys);
  requireCondition(typeof value.version==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value.version)&&['UNMEASURED','MEASURED'].includes(String(value.state)),'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
  requireCondition(Array.isArray(value.evidenceReferences)&&value.evidenceReferences.length<=64&&value.evidenceReferences.every(item=>typeof item==='string'&&item.trim().length>0&&item.length<=512)&&new Set(value.evidenceReferences).size===value.evidenceReferences.length,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
  for(const name of ['realProviderEnabled','paidExecutionEnabled','purchaseEnabled'])requireCondition(typeof value[name]==='boolean','LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
  const fixed=object(value.fixedProtocolLimits);exactKeys(fixed,Object.keys(reference.fixedProtocolLimits));for(const key of Object.keys(reference.fixedProtocolLimits) as (keyof typeof reference.fixedProtocolLimits)[])requireCondition(fixed[key]===reference.fixedProtocolLimits[key],'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
  const limits=object(value.limits);exactKeys(limits,limitNames);
  for(const name of limitNames){const item=limits[name];if(value.state==='UNMEASURED')requireCondition(item===null,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');else requireCondition(costNames.includes(name as CostLimit)?decimal(item):positive(item,!fractionalNames.includes(name)),'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');}
  if(value.state==='UNMEASURED')requireCondition(!value.realProviderEnabled&&!value.paidExecutionEnabled&&!value.purchaseEnabled&&!value.mediaBounds,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
  else{
    requireCondition(value.evidenceReferences.length>0,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
    const numeric=limits as Record<string,number>;requireCondition(numeric.maxWorkspaceBytes>=numeric.maxFileBytes&&numeric.maxArchiveExpandedBytes>=numeric.maxManifestBytes&&numeric.maxWorkspacePages>=numeric.maxFilesPerUpload&&numeric.maxArchiveRatio>=1&&numeric.maxDecodeMemoryBytes>=numeric.maxPixelsPerPage*4,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');
    if(value.mediaBounds){const bounds=object(value.mediaBounds);exactKeys(bounds,['maxWidth','maxHeight','maxTextLength','maxFontSize','maxBlocks']);for(const name of Object.keys(bounds))requireCondition(positive(bounds[name],name!=='maxFontSize'),'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');requireCondition(Number(bounds.maxFontSize)>=numeric.minReadableFontSizePx,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');}
  }
  return structuredClone(value) as MeasurementProfile;
}
export function inspectMeasurementProfile(input:unknown){
  const profile=validateMeasurementProfile(input);const missingGuards=limitNames.filter(name=>!implemented.has(name));
  return {contractVersion:reference.version,version:profile.version,state:profile.state,evidenceReferences:profile.evidenceReferences,
    unmeasuredLimits:limitNames.filter(name=>profile.limits[name]===null),implementedGuards:limitNames.filter(name=>implemented.has(name)),missingGuards,
    missingMediaBounds:profile.mediaBounds?[]:['maxWidth','maxHeight','maxTextLength','maxFontSize','maxBlocks'],
    limitsReady:profile.state==='MEASURED'&&!!profile.mediaBounds&&missingGuards.length===0,
    effectiveGates:{realProviderEnabled:false,paidExecutionEnabled:false,purchaseEnabled:false},externalVerification:'NOT RUN' as const};
}
export function measuredMediaProfile(input:unknown):MediaProfile{
  const profile=validateMeasurementProfile(input);requireCondition(profile.state==='MEASURED'&&profile.mediaBounds,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');const n=profile.limits as Record<Exclude<LimitName,CostLimit>,number>;
  return {id:profile.version,kind:'MEASURED',enabled:true,...profile.mediaBounds,maxImageBytes:n.maxFileBytes,maxPixels:n.maxPixelsPerPage,maxFilesPerUpload:n.maxFilesPerUpload,maxProjectPages:n.maxWorkspacePages,maxProjectSourceBytes:n.maxWorkspaceBytes,maxZipBytes:n.maxArchiveCompressedBytes,maxEntries:n.maxArchiveEntries,maxExpandedBytes:n.maxArchiveExpandedBytes,maxRatio:n.maxArchiveRatio,maxManifestBytes:n.maxManifestBytes,minReadableFontSizePx:n.minReadableFontSizePx};
}
export function requireOperationalLimits(input:unknown):void{requireCondition(inspectMeasurementProfile(input).limitsReady,'LIMIT_PROFILE_UNCONFIRMED',409,'WAIT');}
