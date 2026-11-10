'use strict';
// PRK81E worker-owned emulator; ephemeral MEMFS ROM, no save import or persistence.
var ready=false, used=false, mod=null, frameCallbacks=0, saveWrites=0;
function send(kind,fields){self.postMessage(Object.assign({kind:kind},fields||{}))}
function fail(stage,e){send('error',{stage:stage,message:String(e&&(e.stack||e.message)||e)})}
function getFS(){
  var fs=self.FS||(mod&&mod.FS);
  if(!fs||typeof fs.writeFile!=='function')throw Error('Emscripten FS is unavailable inside worker');
  return fs;
}
function mkdir(fs,path){try{fs.mkdir(path)}catch(e){if(!fs.analyzePath||!fs.analyzePath(path).exists)throw e}}
self.WebMelon={_internal:{events:{
  onEmulatorFrameUpdate:function(){frameCallbacks++},
  onSaveWrite:function(){saveWrites++},
  onRumbleStart:function(){},onRumbleStop:function(){},onShutdown:function(){}
}}};
var Module={
 locateFile:function(name){return '/emulators/melonds/'+name+'?v=prk81e'},
 onRuntimeInitialized:function(){
  try{
    mod=self.Module||Module;
    var inst=new mod.WasmEmulator();
    var stamp=inst.pokerunRuntimeVersion();
    inst.delete();
    if(stamp!==0x50524b4a)throw Error('Bad runtime stamp 0x'+Number(stamp).toString(16));
    getFS();
    ready=true;send('ready',{stamp:stamp});
  }catch(e){fail('runtime',e)}
 },
 onAbort:function(reason){fail('wasm-abort',reason)}
};
self.Module=Module;
self.addEventListener('error',function(e){fail('worker',e.error||e.message)});
self.addEventListener('unhandledrejection',function(e){fail('promise',e.reason)});
self.onmessage=async function(event){
 var msg=event.data;
 if(!msg||msg.kind!=='run'||!ready||used)return;
 used=true;
 var emu=null,cart=null;
 try{
  if(!(msg.rom instanceof ArrayBuffer)||msg.rom.byteLength<1048576||msg.rom.byteLength>536870912)throw Error('ROM must be 1–512 MB');
  var fs=getFS();
  mkdir(fs,'/pokerun');mkdir(fs,'/pokerun/prk81e');
  fs.writeFile('/pokerun/prk81e/test.nds',new Uint8Array(msg.rom));
  send('stage',{stage:'rom-in-memory'});
  emu=new mod.WasmEmulator();cart=new mod.WasmNdsCart();
  if(!cart.loadFromFile('/pokerun/prk81e/test.nds'))throw Error('ROM rejected');
  emu.setSavePath('/pokerun/prk81e/ephemeral.sav');
  emu.loadFreeBIOS();
  if(!emu.loadRom(cart,false))throw Error('Unable to attach ROM');
  emu.initialize(true);
  send('stage',{stage:'native-boot'});
  var before=performance.now();
  for(var i=0;i<60;i++){
    await emu.processFrame(false);
    if((i+1)%15===0)send('frames',{count:i+1});
    if((i+1)%5===0)await new Promise(function(resolve){setTimeout(resolve,0)});
  }
  send('passed',{frames:60,elapsed:performance.now()-before,callbacks:frameCallbacks,saveWrites:saveWrites});
 }catch(e){fail('frame-execution',e)}
 finally{
   try{if(emu&&emu.delete)emu.delete()}catch(e){}
   try{if(cart&&cart.delete)cart.delete()}catch(e){}
 }
};
try{send('stage',{stage:'loading-runtime'});importScripts('/emulators/melonds/wasmemulator.js?v=prk81e');send('stage',{stage:'script-imported'})}
catch(e){fail('importScripts',e)}
