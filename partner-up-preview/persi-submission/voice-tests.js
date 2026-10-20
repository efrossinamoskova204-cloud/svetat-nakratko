/* Voice logic tests — mock SpeechRecognition + speechSynthesis, assert behavior.
   Run: npm install jsdom && node voice-tests.js
   Requires index.html in the same folder; news-sample.json (the live news JSON) is
   used when present, otherwise a small inline fallback sample is used. */
const fs=require('fs');
const {JSDOM}=require('jsdom');

const html=fs.readFileSync('index.html','utf8').replace(/\r\n/g,'\n');
let pass=0,fail=0;
function check(name,cond){ if(cond){pass++; console.log("PASS:",name);} else {fail++; console.log("FAIL:",name);} }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function buildPage(opts={}){
  const dom=new JSDOM(html,{runScripts:"outside-only",pretendToBeVisual:true,url:opts.url||"https://demo.example.com/"});
  const w=dom.window,doc=w.document;
  Object.defineProperty(w,"isSecureContext",{get:()=>opts.secure!==false});
  function MockRec(){
    this.lang="";this.continuous=false;this.interimResults=false;this.maxAlternatives=1;
    this.aborted=0;this.started=0;this._running=false;
    MockRec.instances.push(this);
    this.start=()=>{ if(this._running) throw new Error("InvalidStateError"); this._running=true; this.started++; };
    this.abort=()=>{ this.aborted++; this._running=false; };
    this.stop=()=>{ this._running=false; };
  }
  MockRec.instances=[];
  w.SpeechRecognition=MockRec;
  const spoken=[];
  w.speechSynthesis={ cancel:()=>{}, speak:(u)=>spoken.push(u) };
  w.SpeechSynthesisUtterance=function(t){this.text=t;};
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  w.eval(script);
  const rec=()=>MockRec.instances[MockRec.instances.length-1];
  const endRec=r=>{r._running=false;r.onend();};
  return {w,doc,rec,spoken,endRec};
}

/* T1: dictation happy path — interim + final, no duplication, button states */
{
  const p=buildPage();
  p.doc.getElementById('voiceTalk').click();
  check("T1 start creates recognizer session", p.rec() && typeof p.rec().onstart==="function");
  p.rec().onstart();
  check("T1 aria-pressed true while listening", p.doc.getElementById('voiceTalk').getAttribute('aria-pressed')==="true");
  p.rec().onresult({results:[[ {transcript:"Здравей"} ]]});
  check("T1 interim text in draft", p.doc.getElementById('voiceDraft').value==="Здравей");
  p.rec().onresult({results:[[ {transcript:"Здравей как си"} ]]});
  check("T1 final replaces interim", p.doc.getElementById('voiceDraft').value==="Здравей как си");
  p.endRec(p.rec());
  check("T1 after onend pressed false", p.doc.getElementById('voiceTalk').getAttribute('aria-pressed')==="false");
}

/* T2: double-click before onstart; late onstart must abort; old session events ignored */
{
  const p=buildPage();
  const talk=p.doc.getElementById('voiceTalk');
  talk.click(); // starting
  talk.click(); // stop -> stopping
  check("T2 stopping message shown", /Спирам микрофона/.test(p.doc.getElementById('voiceStatus').textContent));
  talk.click(); // start attempt during stopping -> refused
  check("T2 restart refused during stopping", /Изчакай миг/.test(p.doc.getElementById('voiceStatus').textContent));
  const rec=p.rec();
  const beforeAbort=rec.aborted;
  rec.onstart(); // late onstart from cancelled session
  check("T2 late onstart triggers abort", rec.aborted===beforeAbort+1);
  check("T2 still stopping after late onstart", /Спирам микрофона|Изчакай миг/.test(p.doc.getElementById('voiceStatus').textContent));
  rec.onresult({results:[[ {transcript:"късно"} ]]});
  check("T2 late result ignored", p.doc.getElementById('voiceDraft').value.indexOf("късно")<0);
  p.endRec(rec); // completes stopping
  check("T2 stopping completed", /Диктовката е спряна/.test(p.doc.getElementById('voiceStatus').textContent));
  talk.click(); p.rec().onstart();
  check("T2 fresh start after stop works", /Слушам/.test(p.doc.getElementById('voiceStatus').textContent));
}

/* T2b: old-session handlers must not touch a NEW session (superseded session) */
{
  const p=buildPage();
  const talk=p.doc.getElementById('voiceTalk');
  talk.click(); p.rec().onstart();
  const oldHandlers={onresult:p.rec().onresult, onend:p.rec().onend};
  talk.click(); // stop
  p.endRec(p.rec()); // complete stopping
  talk.click(); p.rec().onstart(); // new session
  p.rec().onresult({results:[[ {transcript:"нова сесия"} ]]});
  check("T2b new session receives text", p.doc.getElementById('voiceDraft').value==="нова сесия");
  oldHandlers.onresult({results:[[ {transcript:"стара сесия"} ]]}); // stale event
  check("T2b stale result ignored", p.doc.getElementById('voiceDraft').value==="нова сесия");
  oldHandlers.onend(); // stale end must not kill new session
  check("T2b stale onend does not reset state", p.doc.getElementById('voiceTalk').getAttribute('aria-pressed')==="true");
  check("T2b state still listening after stale end", /Слушам|Разпознавам/.test(p.doc.getElementById('voiceStatus').textContent));
}

/* T3: mutual exclusion dictation/read-aloud + TTS supersession */
{
  const p=buildPage();
  const talk=p.doc.getElementById('voiceTalk');
  p.doc.getElementById('voiceDraft').value="текст за прочитане";
  talk.click(); p.rec().onstart();
  p.doc.getElementById('voiceListen').click();
  check("T3 speak refused during dictation", p.spoken.length===0);
  check("T3 instructs to stop dictation first", /спри диктовката/.test(p.doc.getElementById('voiceStatus').textContent));
  talk.click(); p.endRec(p.rec()); // stop and complete
  p.doc.getElementById('voiceListen').click();
  check("T3 speak works after dictation stopped", p.spoken.length===1 && p.spoken[0].text==="текст за прочитане");
  talk.click(); // talk during speaking
  check("T3 talk during speaking stops audio", /Прочитането е спряно/.test(p.doc.getElementById('voiceStatus').textContent));
  // TTS supersession: second read invalidates first; late callbacks from first ignored
  p.doc.getElementById('voiceListen').click(); // read again (state speaking)
  const u1=p.spoken[1];
  p.doc.getElementById('voiceListen').click(); // supersede with a new read
  const u2=p.spoken[2];
  check("T3 second read created new utterance", p.spoken.length===3 && u2 && u2.text==="текст за прочитане");
  u1.onend && u1.onend(); // late end from superseded read — must NOT flip state
  check("T3 stale TTS end does not finish message", !/Прочетено/.test(p.doc.getElementById('voiceStatus').textContent));
  u2.onend(); // current read finishes
  check("T3 current read finish message shown", /Прочетено/.test(p.doc.getElementById('voiceStatus').textContent));
  talk.click(); // state idle now -> starts dictation, not "stops audio"
  check("T3 talk after finish starts dictation", p.rec().started===2);
  // TTS request while stopping dictation must be refused
  talk.click(); p.rec().onstart();
  talk.click(); // -> stopping
  p.doc.getElementById('voiceListen').click();
  check("T3 speak refused during stopping", p.spoken.length===3 && /спри диктовката/.test(p.doc.getElementById('voiceStatus').textContent));
}

/* T4: clear during listening; late result ignored; clear during stopping does NOT free state */
{
  const p=buildPage();
  const talk=p.doc.getElementById('voiceTalk');
  p.doc.getElementById('voiceDraft').value="стар текст";
  talk.click(); p.rec().onstart();
  p.doc.getElementById('voiceClear').click();
  check("T4 draft cleared", p.doc.getElementById('voiceDraft').value==="");
  p.rec().onresult({results:[[ {transcript:"закъснял"} ]]});
  check("T4 late result after clear ignored", p.doc.getElementById('voiceDraft').value==="");
  talk.click(); // stop -> stopping
  check("T4 stopping message", /Спирам микрофона/.test(p.doc.getElementById('voiceStatus').textContent));
  p.doc.getElementById('voiceClear').click(); // clear during stopping -> must NOT complete stop
  talk.click(); // still stopping -> refused
  check("T4 clear during stopping keeps state blocked", /Изчакай миг/.test(p.doc.getElementById('voiceStatus').textContent));
  p.endRec(p.rec()); // actual onend completes
  check("T4 onend completes stopping", /Диктовката е спряна|Готово за нов/.test(p.doc.getElementById('voiceStatus').textContent));
}

/* T5: error keeps state until onend; retry only after onend */
{
  const p=buildPage();
  const talk=p.doc.getElementById('voiceTalk');
  talk.click(); p.rec().onstart();
  p.rec().onerror({error:"not-allowed"});
  check("T5 not-allowed message", /разрешение за микрофона/.test(p.doc.getElementById('voiceStatus').textContent));
  check("T5 pressed false after error", talk.getAttribute('aria-pressed')==="false");
  talk.click(); // retry attempt before onend -> refused
  check("T5 retry refused before onend", /Изчакай миг/.test(p.doc.getElementById('voiceStatus').textContent));
  p.doc.getElementById('voiceDraft').value="текст за прочитане";
  p.doc.getElementById('voiceListen').click(); // TTS also refused
  check("T5 speak refused before onend", p.spoken.length===0 && /спри диктовката/.test(p.doc.getElementById('voiceStatus').textContent));
  p.endRec(p.rec()); // actual onend frees the state
  talk.click(); p.rec().onstart();
  check("T5 retry works after onend", /Слушам/.test(p.doc.getElementById('voiceStatus').textContent));
  p.rec().onerror({error:"no-speech"});
  check("T5 no-speech message", /Не беше разпозната реч/.test(p.doc.getElementById('voiceStatus').textContent));
  p.endRec(p.rec());
}

/* T6: navigation away stops dictation; stale events ignored */
{
  const p=buildPage();
  p.doc.getElementById('voiceTalk').click(); p.rec().onstart();
  p.doc.querySelector('[data-view="news"]').click();
  check("T6 talk reset after leaving home", p.doc.getElementById('voiceTalk').getAttribute('aria-pressed')==="false");
  p.rec().onresult({results:[[ {transcript:"след напускане"} ]]});
  check("T6 stale result after navigation ignored", p.doc.getElementById('voiceDraft').value.indexOf("след напускане")<0);
}

/* T7: no SpeechRecognition API -> disabled + message */
{
  const dom=new JSDOM(html,{runScripts:"outside-only",pretendToBeVisual:true,url:"https://demo.example.com/"});
  const w=dom.window;
  Object.defineProperty(w,"isSecureContext",{get:()=>true});
  w.speechSynthesis={cancel:()=>{},speak:()=>{}};
  w.SpeechSynthesisUtterance=function(t){this.text=t;};
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  w.eval(script);
  check("T7 talk disabled without API", w.document.getElementById('voiceTalk').disabled===true);
  check("T7 fallback message", /не се поддържа/.test(w.document.getElementById('voiceStatus').textContent));
}

/* T8: insecure context -> disabled + guidance */
{
  const dom=new JSDOM(html,{runScripts:"outside-only",pretendToBeVisual:true,url:"http://insecure.example.com/"});
  const w=dom.window;
  w.SpeechRecognition=function(){};
  Object.defineProperty(w,"isSecureContext",{get:()=>false});
  w.speechSynthesis={cancel:()=>{},speak:()=>{}};
  w.SpeechSynthesisUtterance=function(t){this.text=t;};
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  w.eval(script);
  check("T8 talk disabled on http", w.document.getElementById('voiceTalk').disabled===true);
  check("T8 https guidance", /защитен/.test(w.document.getElementById('voiceStatus').textContent));
}

async function main(){
  /* T13: guard timeout does NOT free the state; only onend does */
  {
    const p=buildPage();
    const talk=p.doc.getElementById('voiceTalk');
    talk.click(); // starting
    talk.click(); // -> stopping
    await sleep(1700); // guard timeout fires (message only)
    check("T13 timeout message shown", /Изчаквам спирането на микрофона/.test(p.doc.getElementById('voiceStatus').textContent));
    talk.click(); // still blocked
    check("T13 restart still blocked after timeout", /Изчакай миг|Изчаквам спирането/.test(p.doc.getElementById('voiceStatus').textContent));
    p.doc.getElementById('voiceDraft').value="текст за прочитане";
    p.doc.getElementById('voiceListen').click(); // TTS still blocked
    check("T13 speak still blocked after timeout", p.spoken.length===0 && /спри диктовката/.test(p.doc.getElementById('voiceStatus').textContent));
    p.endRec(p.rec()); // actual onend frees
    talk.click(); p.rec().onstart();
    check("T13 start works after real onend", /Слушам/.test(p.doc.getElementById('voiceStatus').textContent));
  }

  /* T9: news with real JSON (or fallback), preview flow, search hidden */
  let news;
  try{ news=JSON.parse(fs.readFileSync('news-sample.json','utf8')); }
  catch(e){ news={generatedAt:"2026-10-20T15:18:59Z",categories:{"България":[{title:"Проба",link:"https://example.com",pubDate:"2026-10-20T15:00:00Z",source:"БТА"}]}}; }
  const dom=new JSDOM(html,{runScripts:"outside-only",pretendToBeVisual:true,url:"https://demo.example.com/"});
  const w=dom.window,doc=w.document;
  w.fetch=async()=>({ok:true,json:()=>news});
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  w.eval(script);
  Object.defineProperty(w,"isSecureContext",{get:()=>true});
  doc.querySelector('[data-view="news"]').click();
  await sleep(400);
  check("T9 news cards rendered", doc.querySelectorAll('.pu-news-card').length>=1);
  check("T9 news status has category", /България/.test(doc.getElementById('newsStatus').textContent));
  doc.getElementById('voiceDraft').value="проба";
  doc.getElementById('voicePreview').click();
  check("T9 preview shows draft", /проба/.test(doc.getElementById('voicePreviewBox').textContent));
  check("T9 search hidden in demo", doc.getElementById('search').hidden===true);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail?1:0);
}
main();
