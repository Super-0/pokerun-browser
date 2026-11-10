'use strict';
// PRK81F: Native futex wait on shared WASM memory. No real RF and no ROM.
var emulator=null, loaded=false, busy=false;
function send(kind,fields){self.postMessage(Object.assign({kind:kind},fields||{}))}
function failed(stage,e){
  send('error',{stage:stage,message:String((e&&(e.stack||e.message))||e)});
}
var Module={
  locateFile:function(name){return '/emulators/melonds/'+name+'?v=prk81f'},
  onAbort:function(reason){failed('native-abort',reason)},
  onRuntimeInitialized:async function(){
    try{
      var mod=self.Module||Module;
      emulator=new mod.WasmEmulator();
      var stamp=Number(await emulator.pokerunRuntimeVersion());
      if(stamp!==0x50524b4b)throw Error('Expected runtime 0x50524b4b, got 0x'+stamp.toString(16));
      var address=Number(await emulator.prk81fMailboxPtr());
      var heap=self.HEAPU8||mod.HEAPU8;
      if(!(heap instanceof Uint8Array))throw Error('Native heap unavailable in worker');
      if(!(heap.buffer instanceof SharedArrayBuffer))throw Error('WASM heap must be SharedArrayBuffer');
      if(!Number.isSafeInteger(address)||address%4!==0||address<1024||address+96>heap.buffer.byteLength)
        throw Error('Bad native mailbox pointer: '+address);
      if(Atomics.load(new Int32Array(heap.buffer,address,8),0)!==0)
        throw Error('Native mailbox not initially idle');
      loaded=true;
      send('ready',{stamp:stamp,address:address,heap:heap.buffer});
    }catch(e){failed('native-init',e)}
  }
};
self.Module=Module;
self.addEventListener('error',function(e){failed('worker-error',e.error||e.message)});
self.addEventListener('unhandledrejection',function(e){failed('worker-promise',e.reason)});
self.onmessage=async function(event){
  var m=event.data;
  if(!m||m.kind!=='wait'||!loaded||busy)return;
  busy=true;
  try{
    var seq=m.sequence,mode=m.mode;
    if(!Number.isInteger(seq)||seq<1||seq>65535||!['valid','stale','timeout'].includes(mode))
      throw Error('Invalid test case');
    var start=performance.now();
    send('waiting',{sequence:seq,mode:mode});
    // This call blocks the worker while the browser thread remains live.
    var result=Number(await emulator.prk81fWaitForReply(seq,mode==='timeout'?140:1500));
    send('result',{sequence:seq,mode:mode,result:result,waitMs:performance.now()-start});
  }catch(e){failed('native-wait',e)}
  finally{busy=false}
};
try{
 send('stage',{stage:'loading-generated-script'});
 importScripts('/emulators/melonds/wasmemulator.js?v=prk81f');
 send('stage',{stage:'generated-script-imported'});
}catch(e){failed('importScripts',e)}
