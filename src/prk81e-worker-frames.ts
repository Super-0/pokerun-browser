// PRK81E disposable worker frame smoke test. The selected ROM never leaves the browser.
const el=document.querySelector<HTMLPreElement>('#log')
const fileInput=document.querySelector<HTMLInputElement>('#rom')
const runButton=document.querySelector<HTMLButtonElement>('#run')
const log=(s:string)=>{if(el)el.textContent+=(el.textContent?'\n':'')+s;console.info('[PRK81E]',s)}
if(el)el.textContent=''
log('Starting PRK81E native worker frame probe')
log('Cross-origin isolated: '+window.crossOriginIsolated)
if(!window.crossOriginIsolated)throw Error('Cross-origin isolation required.')
const worker=new Worker('/prk81e-worker-frames.js',{type:'classic'})
let ready=false,used=false,heartbeats=0
const pulse=window.setInterval(()=>heartbeats++,10)
const end=(message:string)=>{log(message);window.clearInterval(pulse);worker.terminate();if(runButton)runButton.disabled=true}
worker.onerror=e=>end('FAIL: Worker error: '+e.message)
worker.onmessageerror=()=>end('FAIL: Bad worker message')
worker.onmessage=(event:MessageEvent<{kind:string;stage?:string;stamp?:number;message?:string;count?:number;elapsed?:number;callbacks?:number;saveWrites?:number}>)=>{
  const m=event.data
  if(m.kind==='stage')log('Worker: '+m.stage)
  if(m.kind==='ready'){
    ready=true;log('Runtime stamp: 0x'+Number(m.stamp).toString(16))
    if(runButton)runButton.disabled=!fileInput?.files?.length
  }
  if(m.kind==='frames')log('Native frames: '+m.count+'/60')
  if(m.kind==='error')end('FAIL: '+m.stage+': '+m.message)
  if(m.kind==='passed'){
    log('Native frame callbacks: '+m.callbacks)
    log('In-memory save writes: '+m.saveWrites)
    log('Elapsed: '+Number(m.elapsed).toFixed(1)+' ms')
    log('Browser heartbeats: '+heartbeats)
    end('PASS: 60 genuine melonDS frames executed in a Worker. Radio remains untested.')
  }
}
fileInput?.addEventListener('change',()=>{
  if(runButton)runButton.disabled=!ready||used||!fileInput.files?.length
})
runButton?.addEventListener('click',async()=>{
  if(!ready||used||!fileInput?.files?.length)return
  used=true
  runButton.disabled=true
  const file=fileInput.files[0]
  if(!file.name.toLowerCase().endsWith('.nds')||file.size<1048576||file.size>536870912){
    end('FAIL: Select an uncompressed .nds ROM between 1 MB and 512 MB.')
    return
  }
  log('Selected local ROM ('+file.size+' bytes), no network upload')
  try{
    const bytes=await file.arrayBuffer()
    worker.postMessage({kind:'run',rom:bytes},[bytes])
  }catch(error){end('FAIL: Could not read ROM: '+String(error))}
})
