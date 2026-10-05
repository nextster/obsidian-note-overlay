const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
class TFile { constructor(path){this.path=path;this.extension='md';} }
class Plugin {}
class FuzzySuggestModal {}
class Scope {}
const exported={exports:{}};
vm.runInNewContext(fs.readFileSync(require.resolve('./main.js'),'utf8'),{
  module:exported,require:name=>name==='obsidian'?{Plugin,TFile,FuzzySuggestModal,Scope,Notice:class{},setIcon(){}}:require(name),
  console,setTimeout,clearTimeout,Promise,Set,Array,Math,Date
},{filename:'main.js'});
const Panel=exported.exports;
async function waitFor(check){for(let i=0;i<30&&!check();i++)await Promise.resolve();assert.ok(check(),'pending asynchronous step must begin');}
function fixture(files=['qa-one.md','qa-two.md']) {
  const p=new Panel(),events=[];
  const group={type:'tabs',children:[],currentTab:0};
  const container={type:'window',children:[group],win:{},detach(){events.push('detach-window');}};
  const makeLeaf=file=>{
    const leaf={id:'leaf-'+Math.random(),type:'leaf',parent:group,view:{file:file?new TFile(file):null,save:async()=>events.push('save:'+file),editor:{focus(){}}},
      async openFile(file){events.push('open:'+file.path);this.view.file=file;},
      async setViewState(){events.push('empty');this.view.file=null;},
      detach(){events.push('detach:'+this.id);group.children.splice(group.children.indexOf(this),1);},
      getContainer:()=>container};
    group.children.push(leaf);return leaf;
  };
  files.forEach(makeLeaf);
  const workspace={activeLeaf:group.children[0],setActiveLeaf(leaf){events.push('select:'+leaf.id);this.activeLeaf=leaf;group.currentTab=group.children.indexOf(leaf);},
    createLeafInParent(parent,index){assert.equal(parent,group);assert.equal(index,group.children.length);events.push('create');const leaf=makeLeaf(null);this.activeLeaf=leaf;return leaf;},
    requestSaveLayout(){events.push('layout-save');}};
  p.app={workspace,keymap:{getWindowStack:()=>({scope:null})}};
  p.settings={};p.panelLeafIds=new Set();p.livePanelLeafIds=new Set();
  p.panelContainer=container;p.panelWindow=container.win;p.leaf=group.children[0];
  p.panel={isDestroyed:()=>false,hide(){events.push('hide');},removeListener(){}};
  p.saveData=async()=>events.push('session');p.ensurePanel=async()=>{};p.showPanel=()=>events.push('show');
  p.syncPanelLeaves();
  return {p,events,group,workspace,makeLeaf};
}
(async()=>{
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
  console.log('PASS: panel tabs, editor-save ordering, local session selection, layout ownership, unload cleanup and localhost request boundaries.');
})().catch(error=>{console.error(error);process.exitCode=1;});
