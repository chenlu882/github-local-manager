'use strict';
const $=id=>document.getElementById(id);
const token=location.hash.slice(1);
const categories=[['all','全部'],['tool','外部工具'],['git','Git 项目'],['dsh','DSH 插件'],['codex','Codex 缓存'],['download','源码包']];
const titles={all:'全部内容',tool:'外部工具',git:'Git 项目',dsh:'DSH 插件',codex:'Codex 插件缓存',download:'GitHub 源码包'};
const icons={tool:'⌘',git:'⑂',dsh:'◈',codex:'✳',download:'↓'};
const names={tool:'npm 工具',git:'Git 项目',dsh:'DSH 插件',codex:'缓存记录',download:'源码包'};
let category='all',query='',nextOffset=null,rows=[],counts={},sequence=0,pending=null,applying=false;
let configured=false;
const statuses=new Map(),busy=new Set();
function el(tag,cls,text){const node=document.createElement(tag);if(cls)node.className=cls;if(text!==undefined)node.textContent=text;return node;}
async function api(route,payload){
  const res=await fetch('/api/'+route,{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:JSON.stringify(payload)});
  const data=await res.json();if(!res.ok||!data.ok)throw Error(data.error||'操作失败');return data.value;
}
function notice(text,error=false){$('notice').hidden=!text;$('notice').textContent=text||'';$('notice').className=error?'error':'';}
function renderTabs(){
  $('tabs').replaceChildren();
  for(const [id,label]of categories){
    const button=el('button','tab'+(category===id?' active':''));button.type='button';button.setAttribute('aria-pressed',String(category===id));
    button.append(el('span','',label),el('span','count',id==='all'?Object.values(counts).reduce((a,b)=>a+b,0):counts[id]||0));
    button.onclick=()=>{if(category===id)return;category=id;load();};$('tabs').append(button);
  }
}
function setStatus(item,text,error=false){statuses.set(item.kind+':'+item.id,{text,error});renderRows();}
function renderRows(){
  $('items').replaceChildren();
  if(!rows.length){const empty=el('div','empty');empty.append(el('strong','',query?'没有找到匹配内容':'这里暂时没有内容'),el('span','',query?'试试其他名称，或切换分类。':'可以刷新清单，或在下方查看当前扫描范围。'));$('items').append(empty);}
  for(const item of rows){
    const key=item.kind+':'+item.id,card=el('article','card');
    card.append(el('div','item-icon '+item.kind,icons[item.kind]||'◇'));
    const info=el('div','item-info'),title=el('div','item-title');title.append(el('h4','',item.name),el('span','badge',names[item.kind]));
    if(item.protected&&item.kind==='tool')title.append(el('span','badge protected','被 Codex 使用'));
    info.append(title);
    const meta=[];if(item.version)meta.push('v'+item.version);if(item.kind==='dsh')meta.push(item.enabled?'已启用':'未启用');if(item.kind==='codex')meta.push(item.enabled===null?'启用状态未知':item.enabled?'配置启用':'配置停用');
    if(item.repo)meta.push(item.repo.replace(/^https?:\/\//,''));info.append(el('div','item-meta',meta.join(' · ')),el('div','path',item.path||item.source||''));
    const status=statuses.get(key);if(status)info.append(el('div','item-status'+(status.error?' error':''),status.text));
    card.append(info);
    const actions=el('div','item-actions');
    if(['tool','git'].includes(item.kind)){
      const check=el('button','primary',busy.has(key)?'检查中…':'检查更新');check.disabled=busy.has(key);check.onclick=()=>checkItem(item);actions.append(check);
    }
    const copy=el('button','secondary copy','复制路径');copy.onclick=async()=>{try{await navigator.clipboard.writeText(item.path||'');setStatus(item,'路径已复制');}catch{setStatus(item,'无法自动复制，请选中卡片中的路径复制。',true);}};actions.append(copy);card.append(actions);$('items').append(card);
  }
  $('more').hidden=nextOffset===null;
}
async function load({append=false,refresh=false}={}){
  if(!configured)return;
  const revision=++sequence;$('refresh').disabled=true;$('more').disabled=true;notice('');
  $('section-title').textContent=titles[category];
  if(!append){rows=[];$('items').replaceChildren(el('div','loading','正在读取本地清单…'));}
  try{
    const result=await api('list',{category,query,offset:append?(nextOffset||0):0,limit:40,refresh});
    if(revision!==sequence)return;
    counts=result.counts;rows=append?rows.concat(result.items):result.items;nextOffset=result.nextOffset;
    $('total').textContent=Object.values(counts).reduce((a,b)=>a+b,0);$('tool-count').textContent=counts.tool;$('project-count').textContent=counts.git;
    $('result-count').textContent=result.total+' 项';$('updated').textContent='更新于 '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
    $('roots').replaceChildren();for(const [type,paths]of Object.entries(result.scanRoots||{}))$('roots').append(el('div','root-line',(type==='git'?'Git 项目：':'源码包：')+(paths.join('；')||'未配置目录')));
    if(Object.keys(result.errors||{}).length)notice('部分分类未能读取：'+Object.entries(result.errors).map(([k,v])=>k+' '+v).join('；'),true);
    renderTabs();renderRows();
  }catch(error){if(revision!==sequence)return;notice(error.message,true);$('items').replaceChildren(el('div','empty','清单读取失败，请刷新重试。'));}
  finally{if(revision===sequence){$('refresh').disabled=false;$('more').disabled=false;}}
}
async function checkItem(item){
  const key=item.kind+':'+item.id;if(busy.has(key))return;busy.add(key);setStatus(item,'正在检查更新…');
  try{
    const plan=await api('prepare',{type:item.kind,id:item.id});
    if(!plan.hasUpdate){setStatus(item,plan.ahead?'本地领先上游 '+plan.ahead+' 个提交，无需更新。':'已是最新版本'+(plan.current?'（'+plan.current+'）':''));return;}
    setStatus(item,'发现更新：'+plan.current+' → '+plan.target);
    if($('update-dialog').open){notice('已有一项更新等待确认，请先处理。');return;}
    pending={...plan,item};$('plan-details').replaceChildren();
    for(const [label,value]of [['名称',plan.name],['当前',plan.current],['更新至',plan.target],['位置',plan.path]])$('plan-details').append(el('dt','',label),el('dd','',value));
    $('plan-effects').textContent=plan.effects;$('dialog-status').textContent='计划十分钟内有效，取消不会更新。';$('ack').checked=false;$('confirm-update').disabled=true;$('update-dialog').showModal();
  }catch(error){setStatus(item,error.message,true);}
  finally{busy.delete(key);renderRows();}
}
function closeDialog(){if(applying)return;$('update-dialog').close();pending=null;}
$('ack').onchange=()=>{$('confirm-update').disabled=!$('ack').checked||applying;};
$('close-dialog').onclick=closeDialog;$('cancel-update').onclick=closeDialog;
$('update-dialog').addEventListener('cancel',event=>{if(applying)event.preventDefault();else pending=null;});
$('confirm-update').onclick=async()=>{
  if(!pending||!$('ack').checked||applying)return;
  const plan=pending;applying=true;$('confirm-update').disabled=true;$('cancel-update').disabled=true;$('close-dialog').disabled=true;$('ack').disabled=true;$('confirm-update').textContent='更新中…';$('dialog-status').textContent='正在执行，请不要关闭面板。';
  try{
    await api('apply',{planId:plan.planId,confirmationText:plan.confirmationText});
    $('update-dialog').close();pending=null;await load({refresh:true});notice(plan.name+' 已更新至 '+plan.target+'。');
  }catch(error){$('dialog-status').textContent=error.message+'。请关闭后重新检查更新。';pending=null;}
  finally{applying=false;$('cancel-update').disabled=false;$('close-dialog').disabled=false;$('ack').disabled=false;$('confirm-update').textContent='确认更新';}
};
$('refresh').onclick=()=>load({refresh:true});$('more').onclick=()=>load({append:true});
let debounce;$('search').addEventListener('input',()=>{clearTimeout(debounce);debounce=setTimeout(()=>{query=$('search').value.trim();load();},250);});
document.addEventListener('keydown',event=>{if(event.key==='/'&&!['INPUT','TEXTAREA'].includes(document.activeElement.tagName)&&!$('update-dialog').open){event.preventDefault();$('search').focus();}});
async function setup(){
  const state=await api('setup',{});configured=state.configured;const value=state.settings;
  $('setup-git').value=value.gitRoots.join('\n');$('setup-download').value=value.downloadRoots.join('\n');$('setup-npm').value=value.npmRoots.join('\n');$('setup-git-exe').value=value.gitExecutable||'';$('setup-dsh').value=value.dshProfile||'';
  $('setup-environment').textContent=`Node.js ${state.environment.node} · Git ${state.environment.git?'可用':'未检测到，Git 更新不可用'} · npm ${state.environment.npm?'可用':'未检测到，工具更新不可用'}`;
  $('setup-data').textContent='个人配置与运行数据：'+state.dataRoot;$('setup-cancel').hidden=!configured;$('setup-status').textContent='';
  return state;
}
$('settings-button').onclick=async()=>{try{await setup();$('setup-dialog').showModal();}catch(error){notice(error.message,true);}};
$('setup-dialog').addEventListener('cancel',event=>{if(!configured)event.preventDefault();});
$('setup-cancel').onclick=()=>$('setup-dialog').close();
$('setup-save').onclick=async()=>{
  const lines=id=>$(id).value.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  $('setup-save').disabled=true;$('setup-status').textContent='正在保存…';
  try{await api('setup/save',{gitRoots:lines('setup-git'),downloadRoots:lines('setup-download'),npmRoots:lines('setup-npm'),gitExecutable:$('setup-git-exe').value.trim(),dshProfile:$('setup-dsh').value.trim()});configured=true;$('setup-dialog').close();await load({refresh:true});}
  catch(error){$('setup-status').textContent=error.message;}
  finally{$('setup-save').disabled=false;}
};
if(!/^[a-f0-9]{64}$/.test(token)){notice('请通过“启动管理器”重新打开页面。',true);$('items').replaceChildren(el('div','empty','面板尚未连接'));$('refresh').disabled=true;}
else{renderTabs();setup().then(state=>state.configured?load():$('setup-dialog').showModal()).catch(error=>notice(error.message,true));}
