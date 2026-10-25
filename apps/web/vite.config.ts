import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('.',import.meta.url)),plugins:[react()],build:{outDir:fileURLToPath(new URL('../../dist/web',import.meta.url)),emptyOutDir:false},server:{strictPort:true,port:5173,proxy:{'/api':{target:'https://127.0.0.1:4310',secure:false}}}});
