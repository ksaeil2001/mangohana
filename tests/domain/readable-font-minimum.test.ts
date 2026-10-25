import {it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {captureReadableFontMinimum} from '../../packages/domain/src/requests.js';
import type {Settings} from '../../packages/contracts/src/wire.generated.js';
import type {RequestRow} from '../../packages/domain/src/model.js';

const settings=(min=12.5,base=20):Settings=>({settingsVersion:'1',contractVersion:'owned-v1',sourceLanguage:'ja',targetLanguage:'ko',modelId:'owned',reasoningLevel:'LOW',fontAssetId:randomUUID(),baseFontSizePx:base,minFontSizePx:min});
const retry=(floor?:number):Pick<RequestRow,'captured_input'>=>({captured_input:{originalAssetId:randomUUID(),data:{blocks:[],geometryContract:'owned-v1',renderContract:'owned-v1',cleanupQa:'NOT_RUN'},width:8,height:8,...(floor===undefined?{}:{minReadableFontSizePx:floor})}});
it('refuses missing or invalid operational floors and explicit settings below the measured floor',()=>{
  expect(()=>captureReadableFontMinimum(settings(),{synthetic:false})).toThrow('LIMIT_PROFILE_UNCONFIRMED');
  for(const minReadableFontSizePx of [0,-1,NaN,Infinity,Number.MAX_SAFE_INTEGER+1])expect(()=>captureReadableFontMinimum(settings(),{synthetic:false,minReadableFontSizePx})).toThrow('LIMIT_PROFILE_UNCONFIRMED');
  for(const value of [settings(12.49),settings(12.5,12.49)])expect(()=>captureReadableFontMinimum(value,{synthetic:false,minReadableFontSizePx:12.5})).toThrow('LIMIT_PROFILE_UNCONFIRMED');
});
it('captures the exact fractional floor without mutating settings or silently clamping a chosen size',()=>{
  const value=settings(),before=structuredClone(value);expect(captureReadableFontMinimum(value,{synthetic:false,minReadableFontSizePx:12.5})).toBe(12.5);expect(value).toEqual(before);
  expect(captureReadableFontMinimum(settings(12.5,12.5),{synthetic:true,minReadableFontSizePx:12.5})).toBe(12.5);
});
it('reuses the old captured floor on retry and leaves legacy and synthetic captures without a new floor',()=>{
  expect(captureReadableFontMinimum(settings(10),{synthetic:false,minReadableFontSizePx:24},retry(10))).toBe(10);
  const legacy=retry(),before=structuredClone(legacy);expect(captureReadableFontMinimum(settings(4.25),{synthetic:false,minReadableFontSizePx:24},legacy)).toBeUndefined();expect(legacy).toEqual(before);
  expect(captureReadableFontMinimum(settings(4.25),{synthetic:true})).toBeUndefined();
  expect(()=>captureReadableFontMinimum(settings(9),{synthetic:true},retry(10))).toThrow('LIMIT_PROFILE_UNCONFIRMED');
});
