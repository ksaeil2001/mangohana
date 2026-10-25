import {lstatSync,readFileSync} from 'node:fs';
import {digest,sha256} from '../../contracts/src/intent.js';
import {DomainError,requireCondition} from '../../contracts/src/errors.js';

export const nativeKernelIdentityVersion='native-kernel-source-v1' as const;
// Closed runtime source closure of bootstrap/frame/kernel and their local pure
// dependencies. Inputs, project paths, output paths and secrets cannot extend
// this list. Native dependencies are version-pinned by the lockfile, rather than
// imported in the parent to establish this identity.
const files=Object.freeze([
  'packages/native/src/identity.ts',
  'packages/native/src/bootstrap.mjs',
  'packages/native/src/kernel.ts',
  'packages/native/src/jobs.ts',
  'packages/native/src/dto.ts',
  'packages/native/src/frame.ts',
  'packages/media/src/images.ts',
  'packages/media/src/fonts.ts',
  'packages/media/src/mask.ts',
  'packages/media/src/render.ts',
  'packages/media/src/render-policy.ts',
  'packages/media/src/balloon-area.ts',
  'packages/media/src/render-contract.ts',
  'packages/media/src/legacy-render.ts',
  'packages/media/src/profile.ts',
  'packages/media/src/zip.ts',
  'packages/domain/src/image-pipeline.ts',
  'packages/domain/src/provider.ts',
  'packages/domain/src/scope.ts',
  'packages/domain/src/render-hold.ts',
  'packages/providers/src/lama.ts',
  'packages/providers/src/gemini-material.ts',
  'packages/contracts/src/intent.ts',
  'packages/contracts/src/errors.ts',
  'packages/contracts/src/validation.ts',
  'packages/contracts/src/json.ts',
  'packages/contracts/schemas/wire-v1.schema.json',
  'packages/contracts/schemas/manifest-v1.schema.json',
  'packages/contracts/schemas/signature-v1.schema.json',
  'assets/fonts/catalog.json',
  'package-lock.json',
]);

// Snapshot once on each parent-controller construction. A stored digest/version
// mismatch has no compatibility fallback; it stays HOLD until an explicit old
// implementation policy exists. This source/runtime fingerprint is not proof
// of host permissions, installed native binaries, cgroup isolation or capacity.
export function nativeKernelImplementationDigest():string {
  try {
    const modules=files.map(file=>{
      const location=new URL('../../../'+file,import.meta.url),stat=lstatSync(location);
      requireCondition(stat.isFile()&&!stat.isSymbolicLink(),'NATIVE_IMPLEMENTATION_UNCONFIRMED',409,'WAIT');
      const bytes=readFileSync(location);return {file,byteLength:bytes.length,sha256:sha256(bytes)};
    });
    return digest({version:nativeKernelIdentityVersion,node:process.versions.node,platform:process.platform,arch:process.arch,modules});
  }catch{throw new DomainError('NATIVE_IMPLEMENTATION_UNCONFIRMED',409,'WAIT');}
}
