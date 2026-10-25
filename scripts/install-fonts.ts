import { mkdir,readFile,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from '../packages/contracts/src/intent.js';

const root=path.resolve('assets/fonts');await mkdir(root,{recursive:true});
const tagResponse=await fetch('https://api.github.com/repos/notofonts/noto-cjk/commits/Sans2.004',{headers:{'User-Agent':'Trio-local-font-catalog'}});
if(!tagResponse.ok) throw new Error('Official font version lookup failed');const {sha}=await tagResponse.json() as {sha:string};
if(!/^[0-9a-f]{40}$/.test(sha)) throw new Error('Invalid official font revision');
const entries=[{id:'f0000000-0000-4000-8000-000000000001',language:'ko',family:'Noto Sans CJK KR',file:'NotoSansCJKkr-Regular.otf',source:'Sans/OTF/Korean/NotoSansCJKkr-Regular.otf'},
  {id:'f0000000-0000-4000-8000-000000000002',language:'ja',family:'Noto Sans CJK JP',file:'NotoSansCJKjp-Regular.otf',source:'Sans/OTF/Japanese/NotoSansCJKjp-Regular.otf'},
  {id:'f0000000-0000-4000-8000-000000000003',language:'zh-Hans',family:'Noto Sans CJK SC',file:'NotoSansCJKsc-Regular.otf',source:'Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf'}];
async function get(file:string,source:string) {
  const url=`https://raw.githubusercontent.com/notofonts/noto-cjk/${sha}/${source}`;const response=await fetch(url);if(!response.ok) throw new Error('Official font download failed');
  const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>25*1024*1024) throw new Error('Unexpected font size');const target=path.join(root,file);
  try {const prior=await readFile(target);if(sha256(prior)!==sha256(bytes)) throw new Error('Existing font differs; preserve before upgrade');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') await writeFile(target,bytes,{flag:'wx'});else throw error;}
  return {sha256:sha256(bytes),bytesLength:bytes.length.toString(),sourceUrl:url};
}
const license=await get('OFL.txt','LICENSE');const fonts=[];
for(const font of entries) fonts.push({...font,...await get(font.file,font.source),version:'Sans2.004',catalogVersion:'noto-cjk-2.004-v1',licenseId:'f0000000-0000-4000-8000-000000000004'});
const catalog={version:'noto-cjk-2.004-v1',sourceRevision:sha,license:{id:'f0000000-0000-4000-8000-000000000004',file:'OFL.txt',...license},fonts};
try {const prior=JSON.parse(await readFile(path.join(root,'catalog.json'),'utf8'));if(JSON.stringify(prior)!==JSON.stringify(catalog)) throw new Error('Preserve existing font catalog before upgrade');}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT') await writeFile(path.join(root,'catalog.json'),JSON.stringify(catalog,null,2)+'\n',{flag:'wx'});else throw error;}
process.stdout.write(JSON.stringify({catalog:catalog.version,sourceRevision:sha,fontCount:fonts.length,license:'SIL Open Font License 1.1'})+'\n');
