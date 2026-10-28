import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { ROOT, SETTINGS_PATH, defaults } from './paths.js';
export {ROOT} from './paths.js';

const settingsPath = SETTINGS_PATH;
export const settings = fs.existsSync(settingsPath)?JSON.parse(fs.readFileSync(settingsPath,'utf8').replace(/^\uFEFF/,'')):{gitRoots:[],downloadRoots:[],npmRoots:[],gitExecutable:'',dshProfile:''};
function applyEnvironment(){
for (const [key, env] of [['gitRoots','DSH_GITHUB_GIT_ROOTS'],['downloadRoots','DSH_GITHUB_DOWNLOAD_ROOTS'],['npmRoots','GITHUB_MANAGER_NPM_ROOTS']]) {
  if (!Array.isArray(settings[key]) || settings[key].some(v => typeof v !== 'string' || !path.isAbsolute(v))) throw new Error(`settings.json 的 ${key} 必须是绝对路径数组`);
  process.env[env] = settings[key].length ? settings[key].join(path.delimiter) : path.join(ROOT, 'data', 'empty-scan');
}
process.env.GITHUB_MANAGER_GIT = settings.gitExecutable || '';
}
applyEnvironment();
export const core = await import('./core/index.js');
const plans = new Map();
let lastSettingsText=fs.existsSync(settingsPath)?fs.readFileSync(settingsPath,'utf8'):'';
function syncSettings(){
  const text=fs.existsSync(settingsPath)?fs.readFileSync(settingsPath,'utf8'):'';
  if(text===lastSettingsText)return;
  const next=text?JSON.parse(text.replace(/^\uFEFF/,'')):{gitRoots:[],downloadRoots:[],npmRoots:[],gitExecutable:'',dshProfile:''};
  Object.assign(settings,next);applyEnvironment();core.invalidate();plans.clear();lastSettingsText=text;
}
export function getSetup(){syncSettings();return {configured:fs.existsSync(settingsPath),settings:fs.existsSync(settingsPath)?settings:defaults(),environment:{node:process.version,platform:process.platform,...core.environmentStatus()},dataRoot:ROOT};}
export function saveSetup(value){
  for(const key of ['gitRoots','downloadRoots','npmRoots'])if(!Array.isArray(value[key])||value[key].length>30||value[key].some(p=>typeof p!=='string'||!path.isAbsolute(p)||!fs.existsSync(p)||!fs.statSync(p).isDirectory()))throw new Error('请填写存在的绝对目录：'+key);
  if(typeof value.gitExecutable!=='string'||(value.gitExecutable&&(!path.isAbsolute(value.gitExecutable)||!fs.existsSync(value.gitExecutable))))throw new Error('Git 路径无效，可留空自动检测');
  if(typeof value.dshProfile!=='string'||(value.dshProfile&&!path.isAbsolute(value.dshProfile)))throw new Error('DSH 配置目录需要绝对路径');
  const next={gitRoots:[...new Set(value.gitRoots)],downloadRoots:[...new Set(value.downloadRoots)],npmRoots:[...new Set(value.npmRoots)],gitExecutable:value.gitExecutable,dshProfile:value.dshProfile};
  fs.mkdirSync(path.dirname(settingsPath),{recursive:true});
  if(fs.existsSync(settingsPath)){const dir=path.join(ROOT,'backups');fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(settingsPath,path.join(dir,'settings-'+Date.now()+'.json'));}
  const temporary=settingsPath+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(next,null,2),{mode:0o600});fs.renameSync(temporary,settingsPath);
  Object.assign(settings,next);applyEnvironment();plans.clear();core.invalidate();lastSettingsText=fs.readFileSync(settingsPath,'utf8');return getSetup();
}

function readJson(p) { try { return JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')); } catch { return null; } }
function dshInventory() {
  const profile = settings.dshProfile || path.join(os.homedir(),'.dsh','profiles','desktop');
  const manifest = readJson(path.join(profile,'package.json'));
  if (!manifest) return [];
  return Object.entries(manifest.dependencies || {}).map(([name,source]) => {
    const dir = path.join(profile,'node_modules',...name.split('/'));
    const pkg = readJson(path.join(dir,'package.json'));
    if (!pkg?.dsh?.bundle) return null;
    return { kind:'dsh', id:name, name, source, version:pkg.version || '', path:dir,
      enabled:(manifest.dsh?.profile?.bundles || []).includes(name), readOnly:true,
      note:'DSH profile 安装记录，含本地来源；更新和卸载请使用 DSH。' };
  }).filter(Boolean);
}

export async function inventory({ category = 'all', query = '', offset = 0, limit = 50, refresh = false } = {}) {
  syncSettings();
  if(!fs.existsSync(settingsPath))return {counts:{dsh:0,tool:0,codex:0,git:0,download:0},total:0,items:[],nextOffset:null,errors:{},needsSetup:true,scanRoots:{git:[],downloads:[]}};
  const state = await core.state(refresh);
  const groups = {dsh:dshInventory(),tool:state.tools,codex:state.codex.map(item=>({...item,readOnly:true,note:'缓存记录，不保证是当前运行版本'})),git:state.git,download:state.downloads};
  if (category !== 'all' && !Object.hasOwn(groups,category)) throw new Error('不支持的分类');
  let items = category === 'all' ? Object.values(groups).flat() : groups[category];
  const needle=query.toLowerCase();
  items=items.filter(item=>[item.name,item.path,item.repo].some(v=>String(v||'').toLowerCase().includes(needle)));
  return { counts:Object.fromEntries(Object.entries(groups).map(([k,v])=>[k,v.length])),total:items.length,
    items:items.slice(offset,offset+limit),nextOffset:offset+limit<items.length?offset+limit:null,
    errors:state.errors,capabilities:state.capabilities,scanRoots:state.scanRoots };
}

export async function operationLock(key, task) {
  const dir = path.join(ROOT,'data','locks'); fs.mkdirSync(dir,{recursive:true});
  const lock = path.join(dir,createHash('sha256').update(key).digest('hex')+'.json');
  let fd;
  for(let attempt=0;attempt<2;attempt++) {
    try { fd=fs.openSync(lock,'wx'); break; }
    catch(error) {
      if(error.code!=='EEXIST')throw error;
      const old=readJson(lock); let alive=true;
      if(Number.isInteger(old?.pid)) { try { process.kill(old.pid,0); } catch(e) { if(e.code==='ESRCH') alive=false; } }
      if(alive)throw new Error('该项目或安装目录正在被另一个管理器操作，请稍后重试');
      fs.unlinkSync(lock);
    }
  }
  if(fd===undefined)throw new Error('无法获取操作锁');
  try { fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));return await task(); }
  finally { fs.closeSync(fd);fs.unlinkSync(lock); }
}

async function resolveItem(type,id,refresh=false) {
  syncSettings();
  if(!['tool','git'].includes(type))throw new Error('首版仅允许检查/更新 npm 工具与 Git 项目');
  const state=await core.state(refresh);
  const item=(type==='tool'?state.tools:state.git).find(v=>v.id===id);
  if(!item)throw new Error('清单中没有这个条目，请先刷新清单');
  return item;
}
export async function checkUpdate(type,id) {
  const item=await resolveItem(type,id);
  const result=await operationLock(type==='tool'?'npm:'+item.root:'git:'+item.path,()=>core.withLock(type+':'+id,()=>core.check({type,id})));
  const {ticket,...publicResult}=result;
  return {item:{type,id,name:item.name,path:item.path},...publicResult,
    note:type==='git'?'检查会 fetch 远端引用，不修改工作区文件。':'查询 npm 注册表，不安装软件。'};
}
export async function prepareUpdate(type,id) {
  const item=await resolveItem(type,id,true);
  const result=await operationLock(type==='tool'?'npm:'+item.root:'git:'+item.path,()=>core.withLock(type+':'+id,()=>core.check({type,id})));
  if(!result.hasUpdate)return {hasUpdate:false,name:item.name,current:result.current,ahead:result.ahead||0};
  for(const [id,plan]of plans)if(Date.now()>plan.expiresAt)plans.delete(id);
  const planId=randomUUID(),expiresAt=Date.now()+600000;
  const plan={planId,type,id,ticket:result.ticket,name:item.name,path:item.path,current:result.current,target:result.latest,expiresAt,lockKey:type==='tool'?'npm:'+item.root:'git:'+item.path};
  plans.set(planId,plan);
  return {hasUpdate:true,planId,name:plan.name,path:plan.path,current:plan.current,target:plan.target,
    expiresAt:new Date(expiresAt).toISOString(),confirmationText:`更新 ${plan.name} 至 ${plan.target}`,
    effects:type==='tool'?'安装指定 npm 版本，可能执行该包的安装脚本。':'重新检查分支和提交，只允许快进到确认的提交。',
    nextStep:'向用户展示此计划并取得明确确认后，才能调用 apply_local_update。'};
}
export async function applyUpdate(planId,confirmationText) {
  syncSettings();
  const plan=plans.get(planId);
  if(!plan || Date.now()>plan.expiresAt) { plans.delete(planId);throw new Error('计划已过期或管理器已重启，请重新准备更新'); }
  if(confirmationText!==`更新 ${plan.name} 至 ${plan.target}`)throw new Error('确认文字与更新计划不符');
  plans.delete(planId);
  return operationLock(plan.lockKey,()=>core.withLock(plan.type+':'+plan.id,async()=>{
    await resolveItem(plan.type,plan.id,true);
    const output=await core.action({type:plan.type,id:plan.id,action:'update',ticket:plan.ticket});
    return {name:plan.name,target:plan.target,output:output.slice(-12000),updated:true};
  }));
}
