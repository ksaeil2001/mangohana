import {isOverflowRenderer} from './render-policy.js';
import { createPublicKey,sign,verify,type KeyObject } from 'node:crypto';
import type { Database } from '../../storage/src/database.js';
import type { ProjectManifest } from '../../contracts/src/manifest.generated.js';
import type { SignatureEnvelope } from '../../contracts/src/signature.generated.js';
import { assertManifest,assertSignature,counter,money } from '../../contracts/src/validation.js';
import { parseStrictJson } from '../../contracts/src/json.js';
import { sha256 } from '../../contracts/src/intent.js';
import { requireCondition } from '../../contracts/src/errors.js';
import type { FontCatalog } from './fonts.js';
import type { MediaProfile } from './profile.js';
import { readZip,writeZip } from './zip.js';
import { decodeImage } from './images.js';
import type {NativeFacade} from '../../native/src/facade.js';

export const signaturePrefix=Buffer.from('trio.manga-project.v1\0','utf8');
type Verifier={issuer:string;state:string;algorithm:string;public_key:Buffer};
export class ProjectSigner {
  constructor(readonly db:Database,readonly issuer:string,readonly keyId:string,private readonly privateKey:KeyObject|null) {}
  async key(id:string):Promise<Verifier> {const row=(await this.db.pool.query<Verifier>('SELECT issuer,state,algorithm,public_key FROM manga_web.signing_verifiers WHERE key_id=$1',[id])).rows[0];requireCondition(row&&row.issuer===this.issuer&&row.algorithm==='Ed25519'&&['ISSUING','VERIFY_ONLY'].includes(row.state),'FILE_ACCESS_UNCONFIRMED',409,'WAIT');return row;}
  async envelope(manifest:Buffer):Promise<SignatureEnvelope> {
    const key=await this.key(this.keyId);requireCondition(key.state==='ISSUING'&&this.privateKey,'FILE_ACCESS_UNCONFIRMED');
    return {schemaVersion:1,algorithm:'Ed25519',keyId:this.keyId,signatureBase64:sign(null,Buffer.concat([signaturePrefix,manifest]),this.privateKey).toString('base64')};
  }
  async check(raw:Buffer,envelope:SignatureEnvelope):Promise<void> {
    const key=await this.key(envelope.keyId);const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key.public_key]),format:'der',type:'spki'});
    const signature=Buffer.from(envelope.signatureBase64,'base64');requireCondition(signature.length===64&&signature.toString('base64')===envelope.signatureBase64&&verify(null,Buffer.concat([signaturePrefix,raw]),publicKey,signature),'FILE_INVALID',422);
  }
}
export type RestoreAssessment={manifest:ProjectManifest;assets:Map<string,Buffer>;checkpointReuseAvailable:boolean;fileSha256:string};
const strictUtf8=(bytes:Buffer)=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
export async function encodeProject(manifest:ProjectManifest,assets:Map<string,Buffer>,signer:ProjectSigner,profile:MediaProfile,native?:NativeFacade):Promise<Buffer> {
  requireCondition(profile.kind==='SYNTHETIC'||native,'NATIVE_GATEWAY_REQUIRED',409,'WAIT');
  assertManifest(manifest);const raw=Buffer.from(JSON.stringify(manifest),'utf8');requireCondition(raw.length<=profile.maxManifestBytes,'FILE_INVALID',422);const envelope=await signer.envelope(raw);assertSignature(envelope);
  const entries=new Map<string,Buffer>([['manifest.json',raw],['signature.json',Buffer.from(JSON.stringify(envelope),'utf8')]]);
  for(const asset of manifest.assets){const bytes=assets.get(asset.assetId);requireCondition(bytes&&BigInt(bytes.length)===counter(asset.bytesLength)&&sha256(bytes)===asset.sha256,'FILE_INVALID',422);entries.set(asset.entry,bytes);}
  return native?native.writeZip(entries,profile):writeZip(entries,profile);
}
export async function assessProject(bytes:Buffer,accountId:string,signer:ProjectSigner,fonts:FontCatalog,profile:MediaProfile,native?:NativeFacade):Promise<RestoreAssessment> {
  requireCondition(profile.kind==='SYNTHETIC'||native,'NATIVE_GATEWAY_REQUIRED',409,'WAIT');
  const entries=native?await native.readZip(bytes,profile):await readZip(bytes,profile);const raw=entries.get('manifest.json');const signature=entries.get('signature.json');requireCondition(raw&&signature&&raw.length<=profile.maxManifestBytes&&signature.length<=4096,'FILE_INVALID',422);
  const envelope=parseStrictJson(strictUtf8(signature));assertSignature<SignatureEnvelope>(envelope);await signer.check(raw,envelope);
  const manifest=parseStrictJson(strictUtf8(raw),profile.maxManifestBytes);assertManifest<ProjectManifest>(manifest);requireCondition(manifest.issuer===signer.issuer&&manifest.keyId===envelope.keyId&&manifest.algorithm===envelope.algorithm&&manifest.creatorAccountId===accountId,'FILE_ACCESS_UNCONFIRMED',403);
  requireCondition(manifest.pages.length<=profile.maxProjectPages&&new Set(manifest.pages.map(p=>p.pageLineageId)).size===manifest.pages.length,'FILE_INVALID',422);
  const ids=new Set<string>();const paths=new Set<string>(['manifest.json','signature.json']);const assets=new Map<string,Buffer>();let checkpointReuseAvailable=true;
  for(const asset of manifest.assets){requireCondition(!ids.has(asset.assetId)&&!paths.has(asset.entry),'FILE_INVALID',422);ids.add(asset.assetId);paths.add(asset.entry);const data=entries.get(asset.entry);
    const valid=!!data&&BigInt(data.length)===counter(asset.bytesLength)&&sha256(data)===asset.sha256;
    if(asset.requiredFor==='EDIT')requireCondition(valid,'FILE_INVALID',422);else if(!valid)checkpointReuseAvailable=false;
    if(valid)assets.set(asset.assetId,data!);
  }
  requireCondition([...entries.keys()].every(name=>paths.has(name)),'FILE_INVALID',422);
  const spec=(id:string,purpose:string)=>{const asset=manifest.assets.find(a=>a.assetId===id);requireCondition(asset&&asset.purpose===purpose&&asset.requiredFor==='EDIT'&&assets.has(id),'FILE_INVALID',422);return asset;};
  for(const font of manifest.fonts){const official=fonts.font(font.fontAssetId);const asset=spec(font.fontAssetId,'FONT');const license=spec(font.licenseAssetId,'LICENSE');requireCondition(font.family===official.family&&font.fontVersion===official.version&&font.fontCatalogVersion===official.catalogVersion&&font.licenseAssetId===official.licenseId&&asset.sha256===official.sha256&&license.sha256===fonts.catalog.license.sha256,'FILE_INVALID',422);}
  const declaredFonts=new Set(manifest.fonts.map(f=>f.fontAssetId));if(manifest.settings)requireCondition(declaredFonts.has(manifest.settings.fontAssetId),'FILE_INVALID',422);
  let sourceBytes=0;for(const page of manifest.pages){spec(page.originalAssetId,'ORIGINAL');sourceBytes+=assets.get(page.originalAssetId)!.length;const decoded=native?await native.decodeImage(assets.get(page.originalAssetId)!,profile):await decodeImage(assets.get(page.originalAssetId)!,profile);requireCondition(decoded.width===page.widthPx&&decoded.height===page.heightPx&&page.blocks.length<=profile.maxBlocks,'FILE_INVALID',422);money(page.paidCumulativeBaselineCredit);
    for(const [id,purpose] of [[page.cleanedAssetId,'CLEANED'],[page.renderAssetId,'RENDER']] as const){if(id){spec(id,purpose);const derived=native?await native.decodeImage(assets.get(id)!,profile):await decodeImage(assets.get(id)!,profile);requireCondition(derived.mediaType==='image/png'&&derived.width===page.widthPx&&derived.height===page.heightPx,'FILE_INVALID',422);}}
    requireCondition(['source-pixels-v1','synthetic-v1'].includes(page.geometryContract)&&['pango-canonical-v1','synthetic-v1'].includes(page.renderContract)&&new Set(page.blocks.map(b=>b.regionId)).size===page.blocks.length,'FILE_INVALID',422);
    if(page.renderSpecification){
      const rendering=page.renderSpecification;const blockIds=new Set(page.blocks.map(block=>block.regionId));
      requireCondition(rendering.version===1&&rendering.fontCatalogVersion===fonts.catalog.version&&rendering.blocks.length===page.blocks.length&&new Set(rendering.blocks.map(block=>block.regionId)).size===rendering.blocks.length,'FILE_INVALID',422);
      for(const specification of rendering.blocks){
        const block=page.blocks.find(block=>block.regionId===specification.regionId);
        requireCondition(blockIds.has(specification.regionId)&&block&&Number.isFinite(specification.minimumFontSizePx)&&specification.minimumFontSizePx>0&&specification.minimumFontSizePx<=profile.maxFontSize&&['AUTO_FIT','EXACT'].includes(specification.sizing),'FILE_INVALID',422);
        requireCondition(specification.sizing==='EXACT'||specification.minimumFontSizePx<=block.fontSizePx,'FILE_INVALID',422);
        if(specification.targetOrientation!==undefined)requireCondition(isOverflowRenderer(specification.rendererVersion)&&(specification.targetOrientation==='HORIZONTAL'||specification.targetOrientation==='VERTICAL'),'FILE_INVALID',422);
        if(specification.typesetBox!==undefined){
          const {left,top,width,height}=specification.typesetBox,right=left+width,bottom=top+height;
          requireCondition(isOverflowRenderer(specification.rendererVersion)&&Number.isFinite(right)&&Number.isFinite(bottom)&&right>left&&bottom>top&&right<=page.widthPx&&bottom<=page.heightPx&&[Math.floor(left),Math.floor(top),Math.ceil(right),Math.ceil(bottom)].every(Number.isSafeInteger)&&Math.ceil(right)>Math.floor(left)&&Math.ceil(bottom)>Math.floor(top),'FILE_INVALID',422);
        }
      }
    }
    for(const block of page.blocks){requireCondition(declaredFonts.has(block.fontAssetId)&&block.fontSizePx>0&&block.fontSizePx<=profile.maxFontSize&&block.sourceText.value.length<=profile.maxTextLength&&block.translatedText.value.length<=profile.maxTextLength&&fonts.covers(block.fontAssetId,block.sourceText.value+block.translatedText.value),'FILE_INVALID',422);for(const p of block.geometry.polygon)requireCondition(p.x>=0&&p.y>=0&&p.x<=page.widthPx&&p.y<=page.heightPx,'FILE_INVALID',422);}
  }
  requireCondition(sourceBytes<=profile.maxProjectSourceBytes,'FILE_INVALID',422);
  for(const checkpoint of manifest.optionalCheckpoints){if(checkpoint.stageContract!=='synthetic-v1'||checkpoint.assetIds.some(id=>!assets.has(id)))checkpointReuseAvailable=false;}
  return {manifest,assets,checkpointReuseAvailable,fileSha256:sha256(bytes)};
}
