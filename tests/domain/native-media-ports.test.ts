import {describe,it,expect,vi} from 'vitest';
import {generateKeyPairSync,randomUUID} from 'node:crypto';
import sharp from 'sharp';
import type {Database,Transaction} from '../../packages/storage/src/database.js';
import type {ObjectStore} from '../../packages/storage/src/objects.js';
import type {ProjectManifest} from '../../packages/contracts/src/manifest.generated.js';
import {digest,sha256} from '../../packages/contracts/src/intent.js';
import {Assets,type AssetRow} from '../../packages/domain/src/assets.js';
import type {ResultRow} from '../../packages/domain/src/model.js';
import {WorkspaceService} from '../../packages/domain/src/workspace.js';
import {FileService} from '../../packages/domain/src/files.js';
import {ExportBuildService} from '../../packages/domain/src/export-build.js';
import {ResultRaster} from '../../packages/domain/src/raster.js';
import {LibraryService} from '../../packages/domain/src/library.js';
import {FontCatalog} from '../../packages/media/src/fonts.js';
import {ProjectSigner,assessProject,encodeProject} from '../../packages/media/src/project-file.js';
import {decodeImage} from '../../packages/media/src/images.js';
import {canonicalRendererVersion} from '../../packages/media/src/render.js';
import {readZip,writeZip} from '../../packages/media/src/zip.js';
import {syntheticProfile} from '../../packages/media/src/profile.js';
import {NativeFacade} from '../../packages/native/src/facade.js';
import {NativeJobError,type NativeGateway} from '../../packages/native/src/gateway.js';

function port(){
  const native=Object.create(NativeFacade.prototype) as NativeFacade;
  native.writeZip=vi.fn(writeZip);native.readZip=vi.fn(readZip);native.decodeImage=vi.fn(decodeImage);
  return native;
}
function unknown(){return new NativeJobError('NATIVE_TERMINATION_UNCONFIRMED',409,'WAIT',{jobId:randomUUID(),inputDigest:sha256('owned-input'),profileDigest:sha256('owned-profile'),goAttempted:true,startedComputation:true,directChildClosed:true,subtreeTerminationConfirmed:false,operationJoined:false,kind:'DIRECT_CHILD_ONLY'});}
async function fixture(){
  const keys=generateKeyPairSync('ed25519');const query=vi.fn(async()=>({rows:[{issuer:'owned-native-media',algorithm:'Ed25519',state:'ISSUING',public_key:keys.publicKey.export({format:'der',type:'spki'}).subarray(-32)}]}));
  const signer=new ProjectSigner({pool:{query}} as unknown as Database,'owned-native-media','owned-native-key',keys.privateKey);
  const image=await sharp({create:{width:8,height:6,channels:4,background:'white'}}).png().toBuffer();const ids=[randomUUID(),randomUUID(),randomUUID()];
  const assets=new Map(ids.map(id=>[id,image]));const purposes=['ORIGINAL','CLEANED','RENDER'] as const;
  const manifest:ProjectManifest={format:'trio.manga-project',schemaVersion:1,issuer:signer.issuer,keyId:signer.keyId,algorithm:'Ed25519',exportId:randomUUID(),createdAt:'2026-10-03T00:00:00.000Z',creatorAccountId:randomUUID(),projectLineageId:randomUUID(),snapshotRevision:'4',projectStatus:'IN_PROGRESS',settings:null,pages:[{pageLineageId:randomUUID(),originalAssetId:ids[0],widthPx:8,heightPx:6,skip:false,resultRevision:'2',cleanedAssetId:ids[1],renderAssetId:ids[2],blocks:[],paidCumulativeBaselineCredit:'0',paidCumulativeBaselineState:'CONFIRMED',baselineContributionIds:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',renderSpecification:null,cleanupQa:'NOT_RUN',displayName:'owned.png'}],assets:ids.map((assetId,index)=>({assetId,entry:`assets/${assetId}.bin`,purpose:purposes[index],mediaType:'image/png',bytesLength:String(image.length),sha256:sha256(image),requiredFor:'EDIT'})),unsettledReferences:[],optionalCheckpoints:[],fonts:[]};
  const fonts={catalog:{version:'owned-no-text'},font:vi.fn(()=>{throw new Error('This specimen declares no fonts.');})} as unknown as FontCatalog;
  return {signer,query,manifest,assets,fonts,image};
}
async function lookupFixture(options:{resultAsset?:boolean;snapshot?:boolean;wrongSignature?:boolean;asset?:Partial<AssetRow>}={}){
  const image=await sharp({create:{width:8,height:6,channels:4,background:'red'}}).png().toBuffer(),accountId=randomUUID(),resultId=randomUUID(),assetId=randomUUID();
  const result={account_id:accountId,result_id:resultId,original_asset_id:randomUUID(),cleaned_asset_id:null,render_asset_id:options.resultAsset?assetId:null,edit_data:{blocks:[],geometryContract:'source-pixels-v1',renderContract:'pango-canonical-v1',cleanupQa:'NOT_RUN'}} as unknown as ResultRow;
  const fonts={catalog:{version:'owned-render-catalog'}} as FontCatalog,signature=digest({original:result.original_asset_id,cleaned:result.cleaned_asset_id,data:result.edit_data,fontCatalogVersion:fonts.catalog.version,renderer:canonicalRendererVersion(result.edit_data),profile:syntheticProfile.id}),asset:AssetRow={account_id:accountId,asset_id:assetId,purpose:'LIVE',object_key:`${accountId}/${assetId}`,sha256:sha256(image),bytes_length:String(image.length),media_type:'image/png',access_deadline:null,deletion_state:'NOT_DUE',object_created_at:new Date('2026-10-03T00:00:00Z'),...options.asset};
  const queries:string[]=[];const db={accountTransaction:async(id:string,run:(tx:Transaction)=>Promise<unknown>)=>{expect(id).toBe(accountId);return run({account:{account_id:accountId},now:new Date('2026-10-03T00:00:01Z'),client:{query:async(sql:string)=>{queries.push(sql);if(sql.startsWith('SELECT * FROM results '))return {rows:[result]};if(sql.startsWith('SELECT render_asset_id,render_digest FROM result_render_snapshots '))return {rows:options.snapshot?[{render_asset_id:assetId,render_digest:options.wrongSignature?sha256('different immutable render'):signature}]:[]};if(sql.startsWith('SELECT * FROM assets '))return {rows:[asset]};throw new Error('Owned lookup attempted a mutation or an unexpected query.');}}} as unknown as Transaction);}} as unknown as Database;
  const read=vi.fn(async()=>image),store={read} as unknown as ObjectStore,native={forTarget:vi.fn(()=>{throw new Error('Lookup must not start native computation.');}),stopClaims:vi.fn(),idle:async()=>{}} as NativeGateway,render=vi.fn(async()=>{throw new Error('Lookup must not render.');}),raster=new ResultRaster(db,new Assets(db,store),fonts,syntheticProfile,{render},native);
  return {raster,accountId,resultId,assetId,image,queries,read,native,render};
}

describe('parent media contracts with a bound native port',()=>{
  it.each(['UPLOAD','EXPORT','RASTER','LIBRARY'] as const)('requires a native gateway for a measured %s service before touching dependencies',kind=>{
    const measured={...syntheticProfile,kind:'MEASURED' as const};const db={} as Database,assets={} as Assets,fonts={} as FontCatalog,signer={} as ProjectSigner,workspace={extensions:[]} as unknown as WorkspaceService;
    const construct=()=>kind==='UPLOAD'?new FileService(db,workspace,assets,fonts,signer,measured):kind==='EXPORT'?new ExportBuildService(db,assets,fonts,signer,measured):kind==='RASTER'?new ResultRaster(db,assets,fonts,measured):new LibraryService(db,assets,fonts,measured);
    expect(construct).toThrow(expect.objectContaining({code:'NATIVE_GATEWAY_REQUIRED',nextAction:'WAIT'}));expect(workspace.extensions).toEqual([]);
  });
  it('signs and verifies in the parent while delegating ZIP bytes and every original/derived image decode',async()=>{
    const f=await fixture(),native=port();const encoded=await encodeProject(f.manifest,f.assets,f.signer,syntheticProfile,native);
    expect(native.writeZip).toHaveBeenCalledOnce();const entries=await readZip(encoded,syntheticProfile);await f.signer.check(entries.get('manifest.json')!,JSON.parse(entries.get('signature.json')!.toString('utf8')));
    const checked=await assessProject(encoded,f.manifest.creatorAccountId,f.signer,f.fonts,syntheticProfile,native);
    expect(checked.manifest).toEqual(f.manifest);expect(native.readZip).toHaveBeenCalledOnce();expect(native.decodeImage).toHaveBeenCalledTimes(3);expect([...checked.assets.values()].every(bytes=>bytes.equals(f.image))).toBe(true);expect(f.fonts.font).not.toHaveBeenCalled();
  });
  it('rejects a different creator before allowing any image decode',async()=>{
    const f=await fixture(),encoded=await encodeProject(f.manifest,f.assets,f.signer,syntheticProfile),native=port();
    await expect(assessProject(encoded,randomUUID(),f.signer,f.fonts,syntheticProfile,native)).rejects.toMatchObject({code:'FILE_ACCESS_UNCONFIRMED',status:403});expect(native.decodeImage).not.toHaveBeenCalled();
  });
  it('keeps signature and asset integrity checks in the parent before decode',async()=>{
    const f=await fixture(),encoded=await encodeProject(f.manifest,f.assets,f.signer,syntheticProfile),entries=await readZip(encoded,syntheticProfile),native=port();
    entries.set(f.manifest.assets[0].entry,Buffer.from('owned altered asset'));const altered=await writeZip(entries,syntheticProfile);
    await expect(assessProject(altered,f.manifest.creatorAccountId,f.signer,f.fonts,syntheticProfile,native)).rejects.toMatchObject({code:'FILE_INVALID'});expect(native.decodeImage).not.toHaveBeenCalled();
    const signature=JSON.parse(entries.get('signature.json')!.toString('utf8')) as {signatureBase64:string};signature.signatureBase64=Buffer.alloc(64).toString('base64');entries.set('signature.json',Buffer.from(JSON.stringify(signature)));
    await expect(assessProject(await writeZip(entries,syntheticProfile),f.manifest.creatorAccountId,f.signer,f.fonts,syntheticProfile,native)).rejects.toMatchObject({code:'FILE_INVALID'});expect(native.decodeImage).not.toHaveBeenCalled();
  });
  it('propagates native ZIP failure unchanged without a parent ZIP fallback',async()=>{
    const f=await fixture(),native=port(),error=unknown();native.readZip=vi.fn(async()=>{throw error;});
    await expect(assessProject(Buffer.from('owned undecoded ZIP'),f.manifest.creatorAccountId,f.signer,f.fonts,syntheticProfile,native)).rejects.toBe(error);expect(f.query).not.toHaveBeenCalled();expect(native.decodeImage).not.toHaveBeenCalled();
  });
  it('propagates native image failure unchanged and preserves the signed source',async()=>{
    const f=await fixture(),encoded=await encodeProject(f.manifest,f.assets,f.signer,syntheticProfile),before=sha256(encoded),native=port(),error=unknown();native.decodeImage=vi.fn(async()=>{throw error;});
    await expect(assessProject(encoded,f.manifest.creatorAccountId,f.signer,f.fonts,syntheticProfile,native)).rejects.toBe(error);expect(native.decodeImage).toHaveBeenCalledOnce();expect(sha256(encoded)).toBe(before);expect([...f.assets.values()].every(bytes=>bytes.equals(f.image))).toBe(true);
  });
  it('refuses measured project ZIP helpers without a port before signing or parsing',async()=>{
    const f=await fixture(),measured={...syntheticProfile,kind:'MEASURED' as const};
    await expect(encodeProject(f.manifest,f.assets,f.signer,measured)).rejects.toMatchObject({code:'NATIVE_GATEWAY_REQUIRED'});await expect(assessProject(Buffer.from('owned'),f.manifest.creatorAccountId,f.signer,f.fonts,measured)).rejects.toMatchObject({code:'NATIVE_GATEWAY_REQUIRED'});expect(f.query).not.toHaveBeenCalled();
  });
  it('reads an imported render asset before snapshots without allocating a native job or render claim',async()=>{
    const f=await lookupFixture({resultAsset:true,snapshot:true,wrongSignature:true});expect(await f.raster.readExisting(f.accountId,f.resultId)).toEqual({bytes:f.image,assetId:f.assetId});expect(f.queries.some(sql=>sql.includes('result_render_snapshots'))).toBe(false);expect(f.queries.every(sql=>sql.startsWith('SELECT '))).toBe(true);expect(f.native.forTarget).not.toHaveBeenCalled();expect(f.render).not.toHaveBeenCalled();
  });
  it('reads only the signature-matching confirmed snapshot and preserves its exact encoded bytes',async()=>{
    const f=await lookupFixture({snapshot:true});expect(await f.raster.readExisting(f.accountId,f.resultId)).toEqual({bytes:f.image,assetId:f.assetId});expect(f.read).toHaveBeenCalledOnce();expect(f.queries.every(sql=>sql.startsWith('SELECT '))).toBe(true);expect(f.native.forTarget).not.toHaveBeenCalled();expect(f.render).not.toHaveBeenCalled();
  });
  it('returns absence without computing when no result render or snapshot exists',async()=>{
    const f=await lookupFixture();expect(await f.raster.readExisting(f.accountId,f.resultId)).toBeNull();expect(f.read).not.toHaveBeenCalled();expect(f.native.forTarget).not.toHaveBeenCalled();expect(f.queries.every(sql=>sql.startsWith('SELECT '))).toBe(true);
  });
  it('rejects a snapshot for a different immutable render before reading or computing',async()=>{
    const f=await lookupFixture({snapshot:true,wrongSignature:true});await expect(f.raster.readExisting(f.accountId,f.resultId)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});expect(f.read).not.toHaveBeenCalled();expect(f.native.forTarget).not.toHaveBeenCalled();
  });
  it.each([{sha256:sha256('owned altered bytes')},{bytes_length:'1'}])('rejects inconsistent actual render bytes against asset metadata %j',async asset=>{
    const f=await lookupFixture({resultAsset:true,asset});await expect(f.raster.readExisting(f.accountId,f.resultId)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});expect(f.read).toHaveBeenCalledOnce();expect(f.native.forTarget).not.toHaveBeenCalled();
  });
  it('rejects a render asset with a non-PNG media type before reading or computing',async()=>{
    const f=await lookupFixture({resultAsset:true,asset:{media_type:'application/octet-stream'}});await expect(f.raster.readExisting(f.accountId,f.resultId)).rejects.toMatchObject({code:'DEPENDENCY_UNAVAILABLE'});expect(f.read).not.toHaveBeenCalled();expect(f.native.forTarget).not.toHaveBeenCalled();
  });
});
