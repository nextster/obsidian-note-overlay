const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
class TFile { constructor(path){this.path=path;this.extension='md';} }
class WorkspaceLeaf {
  async openFile(file,options){
    if(this.openFileBehavior)return this.openFileBehavior(file,options);
    this.events.push('open:'+file.path);this.view.file=file;return 'opened';
  }
}
class Plugin {}
class FuzzySuggestModal {}
class Scope {
  constructor(parent){this.parent=parent;this.keys=[];}
  register(modifiers,key,callback){this.keys.push({modifiers,key,callback});}
}
const exported={exports:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('./main.js'),'utf8'),{
  module:exported,require:name=>name==='obsidian'?{Plugin,TFile,WorkspaceLeaf,FuzzySuggestModal,Scope,Notice:class{},setIcon(){}}:require(name),
  console,setTimeout,clearTimeout,Promise,Set,Array,Math,Date
},{filename:'main.js'});
const Panel=exported.exports;
async function waitFor(check){for(let i=0;i<30&&!check();i++)await Promise.resolve();assert.ok(check(),'pending asynchronous step must begin');}
function fixture(files=['qa-one.md','qa-two.md']) {
  const p=new Panel(),events=[];
  const group={type:'tabs',children:[],currentTab:0};
  const container={type:'window',children:[group],win:{},detach(){events.push('detach-window');}};
  const makeLeaf=file=>{
    const leaf=Object.assign(new WorkspaceLeaf(),{events,id:'leaf-'+Math.random(),type:'leaf',parent:group,view:{file:file?new TFile(file):null,save:async()=>events.push('save:'+file),editor:{focus(){}}},
      async setViewState(){events.push('empty');this.view.file=null;},
      detach(){events.push('detach:'+this.id);group.children.splice(group.children.indexOf(this),1);},
      getContainer:()=>container});
    group.children.push(leaf);return leaf;
  };
  files.forEach(makeLeaf);
  const workspace={activeLeaf:group.children[0],setActiveLeaf(leaf){events.push('select:'+leaf.id);this.activeLeaf=leaf;group.currentTab=group.children.indexOf(leaf);},
    createLeafInParent(parent,index){assert.equal(parent,group);assert.equal(index,group.children.length);events.push('create');const leaf=makeLeaf(null);this.activeLeaf=leaf;return leaf;},
    requestSaveLayout(){events.push('layout-save');}};
  p.app={workspace,keymap:{getWindowStack:()=>({scope:null})}};
  p.settings={};p.panelLeafIds=new Set();p.livePanelLeafIds=new Set();
  p.panelContainer=container;p.panelWindow=container.win;p.leaf=group.children[0];
  p.panel={visible:true,isDestroyed:()=>false,isVisible(){return this.visible;},hide(){this.visible=false;events.push('hide');},removeListener(){}};
  p.saveData=async()=>events.push('session');p.ensurePanel=async()=>{};p.showPanel=()=>{p.panel.visible=true;events.push('show');};
  p.syncPanelLeaves();
  return {p,events,group,workspace,makeLeaf};
}
async function externalOpen(p,leaf,file,options){const result=await leaf.openFile(file,options);await p.actionQueue;return result;}
(async()=>{
  {
    const {p,group}=fixture();
    const previous={};let scope;
    p.app.keymap={getWindowStack:()=>({scope:previous}),setWindowBaseScope:(win,value)=>{assert.equal(win,p.panelWindow);scope=value;}};
    let toggles=0;p.toggleSidebar=()=>toggles++;
    p.installPanelKeys();
    assert.equal(scope.parent,previous,'panel shortcuts retain the normal parent scope');
    const sidebarKey=scope.keys.find(binding=>binding.key==='b');
    assert.deepEqual(Array.from(sidebarKey.modifiers),['Mod','Shift']);
    assert.equal(scope.keys.some(binding=>binding.key==='b'&&binding.modifiers.length===1),false,'Cmd+B remains available for editor bold');
    assert.equal(sidebarKey.callback({repeat:false}),false,'sidebar shortcut consumes the event in the panel');
    sidebarKey.callback({repeat:true});
    assert.equal(toggles,1,'holding the shortcut must not repeatedly toggle the sidebar');
    assert.equal(group.children.length,2,'sidebar shortcut does not create tabs');
  }
  {
    const {p}=fixture();let focused=false;
    let state={visible:false,expandedFolders:['folder']};
    p.panelWindow.document={activeElement:{}};
    p.sidebar={getState:()=>state,setVisible:visible=>{state={...state,visible};},element:{contains:()=>focused}};
    let editorFocus=0;p.leaf.view.editor.focus=()=>editorFocus++;
    p.toggleSidebar();assert.equal(state.visible,true);assert.equal(editorFocus,0,'showing sidebar preserves editor focus');
    await p.persistSession();assert.equal(p.settings.sidebar.visible,true);
    focused=true;p.toggleSidebar();assert.equal(state.visible,false);assert.equal(editorFocus,1,'hiding a focused sidebar restores editor focus');
    await p.persistSession();assert.deepEqual(p.settings.sidebar.expandedFolders,['folder']);
  }
  {
    const {p,events,group,workspace}=fixture();
    await p.selectTab(group.children[1]);
    assert.equal(events.filter(x=>x.startsWith('save:')).length,2);
    assert.ok(events.indexOf('save:qa-two.md')<events.findIndex(x=>x.startsWith('select:')));
    assert.deepEqual(JSON.parse(JSON.stringify(p.settings.tabs)),[{file:'qa-one.md'},{file:'qa-two.md'}]);
    assert.equal(p.settings.activeTab,1);
    workspace.activeLeaf={type:'leaf'};
    await p.persistSession();assert.equal(p.settings.activeTab,1,'main window selection must not replace selected panel tab');
  }
  {
    const {p,events,group}=fixture();
    await p.newTab();
    assert.equal(group.children.length,3);
    assert.equal(p.settings.activeTab,2);
    assert.equal(p.settings.tabs[2].file,null);
    assert.ok(events.indexOf('save:qa-two.md')<events.indexOf('create'));
    assert.equal(p.panelLeafIds.size,3,'every native leaf must be excluded from floating saved layout');
    const id=p.leaf.id;await p.closeTab(p.leaf);
    assert.equal(group.children.length,2);assert.equal(p.panelLeafIds.has(id),false);
    assert.equal(p.settings.activeTab,1);
  }
  {
    const {p,events,group}=fixture(['qa-one.md']);
    await p.closeTab(group.children[0]);
    assert.equal(group.children.length,1,'last close leaves a reusable empty panel');
    assert.equal(p.settings.tabs[0].file,null);
    assert.ok(events.indexOf('save:qa-one.md')<events.indexOf('empty'));
    assert.equal(events.at(-1),'hide');
  }
  {
    const {p,events}=fixture();
    await p.openNote(new TFile('qa-replacement.md'));
    assert.ok(events.indexOf('save:qa-two.md')<events.indexOf('open:qa-replacement.md'));
    await p.hidePanel();assert.equal(events.at(-1),'hide');assert.ok(events.lastIndexOf('session')<events.lastIndexOf('hide'));
  }
  {
    const {p,group}=fixture();
    const moved=group.children.shift();p.app.workspace.activeLeaf=group.children[0];
    await p.persistSession();assert.equal(p.panelLeafIds.has(moved.id),false,'a moved-out leaf should become an ordinary window again');
    const native=fixture(['qa-native.md']).group.children[0];group.children.push(native);
    p.queueSessionSave();assert.equal(p.panelLeafIds.has(native.id),true,'layout event marks native-created IDs synchronously');
    clearTimeout(p.sessionTimer);
  }
  {
    const {p,events,workspace}=fixture();
    const original=()=>({});p.originalGetLayout=original;p.filteredGetLayout=()=>({});workspace.getLayout=p.filteredGetLayout;
    p.originalReadWorkspaceFile=original;p.filteredReadWorkspaceFile=async()=>({});workspace.readWorkspaceFile=p.filteredReadWorkspaceFile;
    let saved;p.getPanelLeaves()[0].view.save=()=>new Promise(resolve=>{saved=resolve;events.push('save-pending');});
    const cleanup=p.onunload();
    assert.equal(workspace.getLayout,original,'shared hooks restored before async editor writes complete');
    assert.equal(workspace.readWorkspaceFile,original);
    assert.equal(events.includes('detach-window'),false);
    await waitFor(()=>typeof saved==='function');saved();await cleanup;
    assert.equal(events.includes('detach-window'),true,'window detached only after every editor save');
  }
  {
    const {p,group,workspace}=fixture(['qa-selected.md','qa-background.md','qa-other.md']);
    const selected=group.children[0];
    await p.closeTab(group.children[2]);
    assert.equal(workspace.activeLeaf,selected,'closing a background tab preserves the selected tab');
    assert.equal(p.settings.activeTab,0);
  }
  {
    const {p,events}=fixture();
    let visible=true;
    p.panel.getNativeWindowHandle=()=>Buffer.alloc(1);
    p.panel.hide=()=>{visible=false;events.push('hide');};
    p.showPanel=()=>{visible=true;events.push('show');};
    p.native={inspect:()=>JSON.stringify({visible,onActiveSpace:true})};
    await Promise.all(Array.from({length:20},()=>p.toggle()));
    assert.equal(visible,true,'an even number of simultaneous toggles preserves visibility');
    assert.equal(events.filter(event=>event==='hide').length,10);
    assert.equal(events.filter(event=>event==='show').length,10);
    await Promise.all([p.toggle(),p.toggle(),p.toggle()]);
    assert.equal(visible,false,'an odd number of rapid toggles flips visibility exactly once');
  }
  {
    const {p,events,group}=fixture(['qa-before.md']);
    let finishOpen;
    const leaf=group.children[0];
    leaf.openFile=file=>new Promise(resolve=>{
      events.push('open-start');
      finishOpen=()=>{leaf.view.file=file;events.push('open-finished');resolve();};
    });
    const action=p.openNote(new TFile('qa-after.md'));
    await waitFor(()=>typeof finishOpen==='function');
    const cleanup=p.onunload();
    const later=p.newTab();
    assert.equal(events.includes('detach-window'),false);
    finishOpen();await Promise.all([action,cleanup,later]);
    assert.equal(group.children.length,1,'actions queued after unload cannot create another panel tab');
    assert.equal(p.settings.tabs[0].file,'qa-after.md','unload snapshots the completed in-flight note open');
    assert.ok(events.lastIndexOf('save:qa-before.md')>events.indexOf('open-finished'),'final save runs after the in-flight operation completes');
    assert.ok(events.indexOf('detach-window')>events.lastIndexOf('session'),'final session persists before window detach');
  }
  {
    const {p}=fixture(['qa-partial.md']);
    p.settings={tabs:[{file:'qa-saved-one.md'},{file:'qa-saved-two.md'}],activeTab:1};
    const snapshot=JSON.stringify(p.settings);
    p.sessionReady=false;
    await p.persistSession();
    assert.equal(JSON.stringify(p.settings),snapshot,'interrupted restore must preserve the complete saved tab list');
  }
  {
    const {p,group}=fixture(['qa-remembered.md']);
    await p.persistSession();
    const snapshot=JSON.stringify(p.settings);
    p.panelContainer.win=null;group.children.length=0;
    p.queueSessionSave();
    assert.equal(p.sessionTimer,undefined,'a detached window must not schedule an empty session snapshot');
    await p.persistSession();
    assert.equal(JSON.stringify(p.settings),snapshot,'later main-workspace events must not erase the saved panel session');
  }
  {
    const {p}=fixture();
    p.panel=null;p.manifest={version:'test'};p.native={};
    const status=JSON.stringify(p.status());
    assert.equal(status.includes('qa-one.md'),false);assert.equal(status.includes('floating'),false);
    const request=async(headers,url='/status',method='GET')=>{
      const response={code:200,body:'',writeHead(code){this.code=code;},setHeader(){},end(body=''){this.body=body;}};
      await p.handleRequest({socket:{remoteAddress:'127.0.0.1'},headers,url,method},response);return response;
    };
    assert.equal((await request({host:'evil.example:51235'})).code,403);
    assert.equal((await request({host:'127.0.0.1:51235','sec-fetch-site':'cross-site'})).code,403);
    assert.equal((await request({host:'127.0.0.1:51235',origin:'https://example.com'})).code,403);
    assert.equal((await request({host:'127.0.0.1:51235'})).code,200);
    p.toggle=async()=>{throw new Error('PRIVATE-NOTE.md');};
    const response=await request({host:'127.0.0.1:51235'},'/toggle');
    assert.equal(response.code,500);assert.equal(response.body.includes('PRIVATE-NOTE'),false);assert.equal(response.body.includes('stack'),false);
  }
  {
    const {p,events,group,workspace,makeLeaf}=fixture(['qa-hidden.md']);
    p.installPanelOpenHook();p.panel.visible=false;
    const file=new TFile('qa-external.md');
    assert.equal(await externalOpen(p,group.children[0],file),'opened','openFile preserves the original result');
    assert.equal(p.panel.visible,true,'an external open in the active hidden panel reveals it');
    await p.hidePanel();
    await externalOpen(p,group.children[0],file);
    assert.equal(events.filter(event=>event==='show').length,2,'opening the same file also reveals a hidden panel without workspace events');
    await externalOpen(p,group.children[0],new TFile('qa-visible.md'));
    assert.equal(events.filter(event=>event==='show').length,2,'an already visible panel does not need another show');
    const future=makeLeaf('qa-future.md');workspace.activeLeaf=future;p.panel.visible=false;
    await externalOpen(p,future,new TFile('qa-future-open.md'));
    assert.equal(events.filter(event=>event==='show').length,3,'tabs created after hook installation are covered');
    let completed=false;
    const nested=p.openNote(new TFile('qa-plugin-open.md')).then(()=>{completed=true;});
    await waitFor(()=>completed);await nested;await p.actionQueue;
    assert.equal(future.view.file.path,'qa-plugin-open.md','a plugin action awaiting openFile must not deadlock its own action queue');
    await p.onunload();
  }
  {
    const {p,events,group,workspace}=fixture();
    p.installPanelOpenHook();p.panel.visible=false;
    const shared=group.children[0].view.file;
    const main=Object.assign(new WorkspaceLeaf(),{events,view:{file:shared}});
    workspace.activeLeaf=main;
    await externalOpen(p,main,shared);
    assert.equal(events.includes('show'),false,'opening the same note in the main window must not wake the panel');
    assert.equal(p.actionQueue,undefined,'ordinary windows must not enqueue panel actions');
    workspace.activeLeaf=group.children[0];
    await externalOpen(p,group.children[1],shared);
    assert.equal(events.includes('show'),false,'background panel opens must not wake the panel');
    await externalOpen(p,group.children[0],shared,{active:false});
    assert.equal(events.includes('show'),false,'explicit background opens stay hidden even when the leaf was already active');
    const attachment=new TFile('qa-attachment.txt');attachment.extension='txt';
    await externalOpen(p,group.children[0],attachment);
    assert.equal(events.includes('show'),false,'non-Markdown views do not reveal the panel');
    await p.onunload();
  }
  {
    const {p,events,group,workspace,makeLeaf}=fixture();
    p.installPanelOpenHook();p.panel.visible=false;
    const background=group.children[1];
    let finish;
    background.openFileBehavior=file=>new Promise(resolve=>{finish=()=>{background.view.file=file;resolve();};});
    const opening=background.openFile(new TFile('qa-background-start.md'));
    workspace.activeLeaf=background;
    finish();await opening;await p.actionQueue;
    assert.equal(events.includes('show'),false,'a default background open must not reveal a panel merely because its leaf became active before completion');
    assert.equal(p.actionQueue,undefined,'implicit background opens do not enqueue a reveal');
    const foreground=makeLeaf('qa-new-foreground.md');
    foreground.openFileBehavior=async(file,options)=>{
      assert.equal(options.active,true);foreground.view.file=file;workspace.activeLeaf=foreground;return 'opened';
    };
    await externalOpen(p,foreground,new TFile('qa-explicit-foreground.md'),{active:true});
    assert.equal(events.filter(event=>event==='show').length,1,'an explicitly active open can reveal a new panel leaf after activation');
    await p.onunload();
  }
  for(const guard of ['restoring','sessionReady','unloading']){
    const {p,events,group}=fixture(['qa-guarded.md']);
    p.installPanelOpenHook();p.panel.visible=false;
    p[guard]=guard==='sessionReady'?false:true;
    let finish;
    group.children[0].openFileBehavior=file=>new Promise(resolve=>{finish=()=>{group.children[0].view.file=file;resolve();};});
    const opening=group.children[0].openFile(new TFile('qa-during-restore.md'));
    p[guard]=guard==='sessionReady'?true:false;
    finish();await opening;await p.actionQueue;
    assert.equal(events.includes('show'),false,guard+' at invocation suppresses reveal even if the guard clears before completion');
    await p.onunload();
  }
  for(const guard of ['restoring','sessionReady','unloading','destroyed']){
    const {p,events,group}=fixture(['qa-before-guard.md']);
    p.installPanelOpenHook();p.panel.visible=false;
    let finish;
    group.children[0].openFileBehavior=file=>new Promise(resolve=>{finish=()=>{group.children[0].view.file=file;resolve();};});
    const opening=group.children[0].openFile(new TFile('qa-after-guard.md'));
    if(guard==='destroyed')p.panel.isDestroyed=()=>true;
    else p[guard]=guard==='sessionReady'?false:true;
    finish();await opening;await p.actionQueue;
    assert.equal(events.includes('show'),false,guard+' at completion suppresses reveal');
    if(guard==='destroyed')p.panel.isDestroyed=()=>false;
    await p.onunload();
  }
  for(const changed of ['active-leaf','file','membership','hide-generation']){
    const {p,events,group,workspace}=fixture(['qa-queued.md']);
    p.installPanelOpenHook();p.panel.visible=false;
    let release;
    p.runAction(()=>new Promise(resolve=>{release=resolve;}));
    await waitFor(()=>typeof release==='function');
    const leaf=group.children[0];await leaf.openFile(new TFile('qa-queued-open.md'));
    if(changed==='active-leaf')workspace.activeLeaf={type:'leaf'};
    if(changed==='file')leaf.view.file=new TFile('qa-newer-file.md');
    if(changed==='membership')group.children.splice(0,1);
    if(changed==='hide-generation')await p._hidePanel();
    release();await p.actionQueue;
    assert.equal(events.includes('show'),false,'queued reveal rechecks '+changed);
    await p.onunload();
  }
  {
    const {p,events,group}=fixture(['qa-rejected.md']);
    p.installPanelOpenHook();p.panel.visible=false;
    const error=new Error('open failed');
    group.children[0].openFileBehavior=async()=>{throw error;};
    await assert.rejects(group.children[0].openFile(new TFile('qa-failed-open.md')),caught=>caught===error);
    assert.equal(p.actionQueue,undefined,'a rejected open does not enqueue a reveal');
    assert.equal(events.includes('show'),false);
    await p.onunload();
  }
  {
    const {p,events,group}=fixture(['qa-old-open.md']);
    p.installPanelOpenHook();
    let finish;
    group.children[0].openFileBehavior=file=>new Promise(resolve=>{finish=()=>{group.children[0].view.file=file;resolve();};});
    const opening=group.children[0].openFile(new TFile('qa-delayed-open.md'));
    await p.hidePanel();
    finish();await opening;await p.actionQueue;
    assert.equal(p.panel.visible,false,'completion of an older open cannot undo a newer hide');
    assert.equal(events.includes('show'),false);
    await p.onunload();
  }
  {
    const {p,events,group}=fixture(['qa-hide-start.md']);
    p.installPanelOpenHook();
    let finishSave,first=true;
    group.children[0].view.save=()=>first?(first=false,new Promise(resolve=>{finishSave=resolve;})):Promise.resolve();
    const hiding=p.hidePanel();
    await waitFor(()=>typeof finishSave==='function');
    assert.equal(p.hideGeneration,1,'hide generation advances before editor saves complete');
    await group.children[0].openFile(new TFile('qa-open-after-hide-start.md'));
    finishSave();await hiding;await p.actionQueue;
    assert.equal(p.panel.visible,true,'an open started after hide began is revealed after the queued hide completes');
    assert.ok(events.indexOf('show')>events.indexOf('hide'));
    await p.onunload();
  }
  {
    const {p,group}=fixture(['qa-hook-cleanup.md']);
    const original=WorkspaceLeaf.prototype.openFile;
    p.installPanelOpenHook();
    let finishSave;
    group.children[0].view.save=()=>new Promise(resolve=>{finishSave=resolve;});
    const cleanup=p.onunload();
    assert.equal(WorkspaceLeaf.prototype.openFile,original,'unload restores the shared prototype synchronously');
    await waitFor(()=>typeof finishSave==='function');finishSave();await cleanup;
  }
  {
    const {p}=fixture(['qa-newer-hook.md']);
    const original=WorkspaceLeaf.prototype.openFile;
    p.installPanelOpenHook();
    const installed=WorkspaceLeaf.prototype.openFile;
    const newer=function(...args){return installed.apply(this,args);};
    WorkspaceLeaf.prototype.openFile=newer;
    const cleanup=p.onunload();
    assert.equal(WorkspaceLeaf.prototype.openFile,newer,'unload preserves a newer wrapper installed by another plugin');
    await cleanup;WorkspaceLeaf.prototype.openFile=original;
  }
  console.log('PASS: panel tabs, editor saves, session ownership, external opens including repeats, hide races, hook cleanup and localhost boundaries.');
})().catch(error=>{console.error(error);process.exitCode=1;});
