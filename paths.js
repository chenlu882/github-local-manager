import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=fileURLToPath(new URL('.',import.meta.url));
export const APP_ROOT=path.basename(path.resolve(here))==='dist'?path.resolve(here,'..'):here;
// Never write into a host-managed plugin cache. Each user owns their settings.
export const ROOT=process.env.GITHUB_MANAGER_HOME || (fs.existsSync('E:/')?'E:/项目/GitHub本地管理器数据':path.join(os.homedir(),'.github-local-manager'));
export const SETTINGS_PATH=process.env.GITHUB_MANAGER_SETTINGS || path.join(ROOT,'settings.json');
export function defaults(){
  const existing=values=>values.filter(p=>fs.existsSync(p));
  return {gitRoots:existing(['E:/项目',path.join(os.homedir(),'Desktop')]),downloadRoots:existing([path.join(os.homedir(),'Downloads')]),npmRoots:existing([path.join(process.env.APPDATA||path.join(os.homedir(),'AppData/Roaming'),'npm')]),gitExecutable:'',dshProfile:path.join(os.homedir(),'.dsh','profiles','desktop')};
}
