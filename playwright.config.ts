import {defineConfig} from '@playwright/test';
import {tmpdir} from 'node:os';
import path from 'node:path';
const artifacts=process.env.TRIO_BROWSER_ARTIFACTS??path.join(tmpdir(),'trio-manga-web-browser-artifacts');
export default defineConfig({testDir:'tests/browser',timeout:90000,expect:{timeout:15000},workers:1,fullyParallel:false,retries:0,outputDir:path.join(artifacts,'test-results'),reporter:[['list'],['json',{outputFile:path.join(artifacts,'results.json')}]],use:{ignoreHTTPSErrors:true,trace:'retain-on-failure',screenshot:'only-on-failure',video:'off',actionTimeout:15000},projects:[
  {name:'windows-chrome',use:{browserName:'chromium',channel:'chrome',viewport:{width:1440,height:960}}},
  {name:'windows-edge',use:{browserName:'chromium',channel:'msedge',viewport:{width:1366,height:900}}},
  {name:'android-tablet-emulation-chrome',use:{browserName:'chromium',channel:'chrome',viewport:{width:800,height:1280},isMobile:true,hasTouch:true,deviceScaleFactor:1}},
  {name:'ipad-layout-emulation-chrome',use:{browserName:'chromium',channel:'chrome',viewport:{width:1024,height:1366},isMobile:true,hasTouch:true,deviceScaleFactor:1}},
]});
