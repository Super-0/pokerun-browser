/* PRK81D: classic worker/Embinder feasibility test, NOT gameplay. */
'use strict';
var alreadyStarted = false;
var completed = false;
function status(stage, extra) { self.postMessage(Object.assign({kind:'stage',stage:stage},extra||{})); }
function fail(stage, error) {
  if(completed) return;
  completed=true;
  self.postMessage({kind:'failed',stage:stage,error:String(error && (error.stack||error.message)||error)});
}
self.addEventListener('error',event=>fail('worker-error',event.error||event.message));
self.addEventListener('unhandledrejection',event=>fail('worker-promise',event.reason));
self.onmessage=function(event) {
 if(!event.data||event.data.kind!=='start'||alreadyStarted) return;
 alreadyStarted=true;
 if(!self.crossOriginIsolated) { fail('isolation','COOP/COEP required'); return; }
 if(typeof importScripts!=='function') { fail('environment','classic worker importScripts missing'); return; }
 status('worker-ready',{isolated:self.crossOriginIsolated});
 const token='prk81d-'+Date.now();
 var Module = {
   locateFile: function(name) { return '/emulators/melonds/'+name+'?v='+token; },
   onAbort: function(reason){fail('native-abort',reason);},
   onRuntimeInitialized: async function() {
      if(completed)return;
      status('wasm-initialized');
      var emulator;
      try {
        var active=self.Module||Module;
        if(typeof active.WasmEmulator!=='function') throw Error('WasmEmulator constructor not exported in worker');
        emulator=new active.WasmEmulator();
        var stamp=Number(await emulator.pokerunRuntimeVersion());
        var budget=Number(await emulator.arm9CallBudget());
        var count=Number(await emulator.prk79ReplyRx());
        if(stamp!==0x50524b47||budget!==1000000||!Number.isSafeInteger(count))
          throw Error('Native values do not match PRK81A runtime: '+stamp.toString(16)+', '+budget+', '+count);
        completed=true;
        self.postMessage({kind:'passed',stamp:stamp,budget:budget,count:count});
      } catch(e) { fail('native-exports',e); }
      finally { try { if(emulator&&emulator.delete)emulator.delete(); }catch(_){} }
   }
 };
 self.Module=Module;
 try {
    status('importing-generated-script');
    importScripts('/emulators/melonds/wasmemulator.js?v='+token);
    if(!completed)status('generated-script-imported');
 }catch(e){fail('importScripts',e);}
};