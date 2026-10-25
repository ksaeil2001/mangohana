import {afterAll,describe,it,expect} from 'vitest';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {sha256} from '../../packages/contracts/src/intent.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeController} from '../../packages/native/src/controller.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {ownedNativePng,ownedNativePngSha256} from '../fixtures/native-images.js';
const controllers:NativeController[]=[];
afterAll(async()=>{for(const controller of controllers){controller.stopClaims();await controller.idle();}});
describe('actual owned image child with a fully decoded source specimen',()=>{
  it('preserves the exact RGBA pixel through native decode and canonical PNG output',async()=>{
    const source=Buffer.from(ownedNativePng,'base64');expect(sha256(source)).toBe(ownedNativePngSha256);
    const sourcePixels=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});expect(sourcePixels.info).toMatchObject({width:1,height:1,channels:4});expect(sourcePixels.data).toEqual(Buffer.from([40,120,240,255]));
    const directoryRoot=await mkdtemp(path.join(tmpdir(),'trio-native-image-')),controller=NativeController.owned({profile:syntheticProfile,directoryRoot,limits:{maxMetadataBytes:64*1024,maxInputBytes:1024*1024,maxOutputBytes:1024*1024,maxItems:10,childMemoryBytes:128*1024*1024,maxProcesses:16,timeoutMs:15000,terminationWaitMs:2000,parentInFlightBytes:8*1024*1024}});controllers.push(controller);
    const output=await new NativeFacade(controller).decodeImage(source,syntheticProfile);await controller.idle();expect(output).toMatchObject({width:1,height:1,mediaType:'image/png'});
    const decoded=await sharp(output.canonicalPng).ensureAlpha().raw().toBuffer({resolveWithObject:true});expect(decoded.info).toMatchObject({width:1,height:1,channels:4});expect(decoded.data).toEqual(sourcePixels.data);expect(sha256(source)).toBe(ownedNativePngSha256);
  });
});
