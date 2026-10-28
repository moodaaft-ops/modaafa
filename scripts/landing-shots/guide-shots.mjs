import { chromium } from '@playwright/test';
const BASE='http://localhost:3100', MOCK='http://127.0.0.1:54331', OUT='/home/claude/guide/out';
import { mkdirSync } from 'node:fs'; mkdirSync(OUT,{recursive:true});
const SESSION = JSON.stringify({access_token:'a.b.c',refresh_token:'r',token_type:'bearer',expires_in:3600,expires_at:Math.floor(Date.now()/1000)+864000,user:{id:'11111111-1111-4111-8111-111111111111',email:'demo@example.com',aud:'authenticated',role:'authenticated'}});
const SHOTS = [
  ['connect','connect','/onboarding',true,'اربط حساب إعلانات قوقل','اضغط هنا، ووافق في شاشة قوقل للنهاية'],
  ['no-account','connect','/onboarding',true,'ما عندي حساب إعلانات','ما عندك حساب؟ اضغط هنا ومُضاعِف يجهزه لك'],
  ['login','','/login',false,'الدخول بـ Google','أسهل طريقة تدخل فيها: حساب قوقل'],
  ['register','','/register',false,'المتابعة بحساب Google','سجّل بحساب قوقل وتبدأ الفحص المجاني'],
  ['approve','demo_home','/home',true,'اعتمد','شوف السبب، وإذا ناسبك اضغط اعتمد'],
  ['undo','undo','/home',true,'رجّعه','أي تعديل نفذته تقدر ترجعه من هنا خلال 30 يوم'],
  ['cancel','pages','/billing',true,'إلغاء الاشتراك','الإلغاء من هنا بضغطة، وبدون التزام'],
];
const only = process.argv.slice(2);
const b = await chromium.launch({executablePath:'/opt/pw-browsers/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell'});
for (const [name,scen,path,auth,target,caption] of SHOTS) {
  if (only.length && !only.includes(name)) continue;
  if (scen) await fetch(`${MOCK}/__scenario?name=${scen}`,{method:'POST'});
  const ctx = await b.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,isMobile:true,hasTouch:true,locale:'ar-SA',timezoneId:'Asia/Riyadh'});
  if (auth) await ctx.addCookies([{name:'sb-127-auth-token',value:encodeURIComponent(SESSION),url:BASE},{name:'modaafa_tour_seen',value:'1',url:BASE}]);
  await ctx.addInitScript(()=>{try{localStorage.setItem('modaafa-install',JSON.stringify({installed:true}))}catch{}});
  const p = await ctx.newPage();
  await p.goto(BASE+path,{waitUntil:'networkidle'});
  await p.addStyleTag({content:'nextjs-portal{display:none!important}'});
  await p.waitForTimeout(3500);
  const el = p.getByText(target,{exact:true}).first();
  await el.scrollIntoViewIfNeeded();
  await p.evaluate(() => window.scrollBy(0, 0));
  const h = await el.evaluateHandle(e => e.closest('button,a,section,[role=button]') || e);
  await h.evaluate((e)=>{ const r=e.getBoundingClientRect(); if (r.top<200||r.bottom>window.innerHeight-160) window.scrollBy(0, r.top - window.innerHeight/2 + r.height/2); });
  await p.waitForTimeout(500);
  await h.evaluate((e, caption) => {
    const r = e.getBoundingClientRect(), pad = 8;
    const box = document.createElement('div');
    Object.assign(box.style,{position:'fixed',left:(r.left-pad)+'px',top:(r.top-pad)+'px',width:(r.width+pad*2)+'px',height:(r.height+pad*2)+'px',
      border:'4px solid #FBBC04',borderRadius:'16px',boxShadow:'0 0 0 9999px rgba(14,20,38,.55)',zIndex:2147483646,pointerEvents:'none'});
    const cap = document.createElement('div');
    cap.textContent = caption;
    const below = r.top < 260;
    Object.assign(cap.style,{position:'fixed',left:'16px',right:'16px',zIndex:2147483647,background:'#FBBC04',color:'#0E1426',
      font:'700 18px/1.5 "IBM Plex Sans Arabic", system-ui, sans-serif',padding:'14px 18px',borderRadius:'14px',direction:'rtl',textAlign:'right',
      boxShadow:'0 8px 24px rgba(0,0,0,.25)'});
    if (below) cap.style.top = (r.bottom + pad + 22) + 'px'; else cap.style.bottom = (window.innerHeight - r.top + pad + 22) + 'px';
    document.body.append(box, cap);
  }, caption);
  await p.waitForTimeout(300);
  await p.screenshot({path:`${OUT}/${name}.png`});
  console.log('saved',name);
  await ctx.close();
}
await b.close();
