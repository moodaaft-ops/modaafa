import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { saveStoreConnection } from '../lib/stores/connect';
import { merchantPhoneE164 } from '../lib/settings/merchant-phone';
import { assertShiftBudgetsUnchanged } from '../lib/autopilot/shift-live';
import { customerMatchTransport, prepareCustomerMatchMembers, buildIngestRequests, uploadCustomerMatch, PartialAudienceUploadError } from '../lib/audiences/customer-match';
import { isAmbiguousGoogleAdsMutationError } from '../lib/ai/execution-preflight';
import { validateMatchUpload } from '../lib/audiences/match-action';
import { cachedRegionConstants } from '../lib/launch/geo-cache';
import { saveFeedSnapshot } from '../lib/shopping/history';
import { structureCandidates } from '../lib/structure/proposals';
import { deviceImageItem, privateImageInAccount } from '../lib/image-assets/private-storage';
import { zidWebhookDetails, registerZidWebhooks } from '../lib/stores/zid-webhooks';
import { getStoreAccessToken } from '../lib/stores/tokens';
import { encrypt } from '../lib/crypto';
const CID='1234567890', U='11111111-1111-4111-8111-111111111111';

test('Customer Match preserves accepted chunk IDs and locks a partial live upload against whole-card retry',async()=>{
 let calls=0; const members=Array.from({length:10001},()=>({email_sha256:'a'.repeat(64)}));
 await assert.rejects(()=>uploadCustomerMatch(members,{customerId:CID,userListId:'9',consentConfirmed:true,termsConfirmed:true},{async ingest(){calls++;if(calls===1)return{requestId:'accepted-1'};throw new Error('grant lost');}}),
  (e:any)=>e instanceof PartialAudienceUploadError&&e.acceptedRequestIds[0]==='accepted-1'&&isAmbiguousGoogleAdsMutationError(e));
 assert.equal(calls,2);
});
test('Customer Match readback retrieves only request status without resending audience members',async()=>{
 const transport=customerMatchTransport('test',async(url:any,init:any)=>{assert.match(String(url),/requestStatus:retrieve\?requestId=r1/);assert.equal(init.method,undefined);assert.equal(init.body,undefined);return new Response(JSON.stringify({requestStatusPerDestination:[{requestStatus:'PROCESSING'}]}),{status:200});});
 assert.deepEqual(await transport.status!('r1'),['PROCESSING']);
});

test('settings mobile accepts exactly 05XXXXXXXX, converts Arabic digits and stores E.164',()=>{
 assert.equal(merchantPhoneE164('٠٥٥١٢٣٤٥٦٧'),'+966551234567');
 for(const bad of ['+966551234567','551234567','055123456','0651234567','05512345678','055123456a']) assert.equal(merchantPhoneE164(bad),null);
});
test('two owners racing to connect a store cannot overwrite ownership',async()=>{
 const rows=new Map<string,any>();
 const db={from(){return {async insert(row:any){const key=row.platform+':'+row.external_store_id;if(rows.has(key))return {error:{code:'23505'}}; rows.set(key,{...row,id:'c'});return {error:null};},update(patch:any){const filters:any={};const q:any={eq(k:string,v:any){filters[k]=v;return q;},select(){return q;},async maybeSingle(){const row=rows.get(filters.platform+':'+filters.external_store_id);if(row?.user_id!==filters.user_id)return {data:null,error:null};Object.assign(row,patch);return {data:row,error:null};}};return q;}};}};
 const base={platform:'shopify',external_store_id:'shop.myshopify.com'};
 const results=await Promise.all([saveStoreConnection(db,{...base,user_id:'a'}),saveStoreConnection(db,{...base,user_id:'b'})]);
 assert.deepEqual(results,['saved','store_taken']);assert.equal(rows.values().next().value?.user_id,'a');
 assert.equal(await saveStoreConnection(db,{...base,user_id:'a',status:'active'}),'saved');
});
test('shift immediately refuses shared, unreadable or changed budgets before a mutate',async()=>{
 const params={from_budget_resource:`customers/${CID}/campaignBudgets/1`,to_budget_resource:`customers/${CID}/campaignBudgets/2`,from_current_micros:100e6,to_current_micros:100e6};
 const client=(extra:any)=>({query:async()=>[{campaignBudget:{amountMicros:'100000000',referenceCount:'1',explicitlyShared:false,...extra}}]});
 await assertShiftBudgetsUnchanged(client({}),params);
 for(const extra of [{referenceCount:'2'},{explicitlyShared:true},{amountMicros:'110000000'},{referenceCount:undefined}]) await assert.rejects(assertShiftBudgetsUnchanged(client(extra),params),/shared/);
});
test('Shopify offline token does not claim a refresh lease or call its token endpoint',async()=>{
 process.env.ENCRYPTION_KEY=randomBytes(32).toString('base64');
 const q:any={select(){return q;},eq(){return q;},maybeSingle:async()=>({data:{id:'c',status:'active',access_token_encrypted:encrypt('offline-token'),refresh_token_encrypted:null,token_expires_at:null},error:null})};
 assert.equal(await getStoreAccessToken({from:()=>q,rpc:async()=>{throw new Error('must not refresh');}},'c',{platform:'shopify'},{fetchImpl:(async()=>{throw new Error('must not fetch');}) as typeof fetch}),'offline-token');
});
test('geo suggest caches successful public constants and never widens unresolved regions',async()=>{
 let calls=0;const name='اختبار كاش فريد';
 const request=async()=>{calls++;return {geoTargetConstantSuggestions:[{searchTerm:name,geoTargetConstant:{resourceName:'geoTargetConstants/123',countryCode:'SA',status:'ENABLED',targetType:'City'}}]};};
 assert.deepEqual(await cachedRegionConstants([name],request,100),{[name]:'geoTargetConstants/123'});
 await cachedRegionConstants([name],request,200);assert.equal(calls,1);
 await cachedRegionConstants([name],request,100+86400001);assert.equal(calls,2);
 assert.deepEqual(await cachedRegionConstants(['غير محلولة'],async()=>({}),100),{});
});
test('feed history reads exactly yesterday before today and retains 90 calendar days',async()=>{
 const calls:any[]=[];const prior={total:20,not_eligible:1};
 const db={from(table:string){const q:any={select(v:any){calls.push(['select',v]);return q;},eq(k:any,v:any){calls.push(['eq',k,v]);return q;},maybeSingle:async()=>({data:{summary:prior},error:null}),upsert(v:any){calls.push(['upsert',v]);return q;},delete(){calls.push(['delete']);return q;},lt(k:any,v:any){calls.push(['lt',k,v]);return q;},then(resolve:any){resolve({error:null});}};calls.push(table);return q;}};
 const result=await saveFeedSnapshot(db,'a','2026-10-20',{total:25} as any);assert.equal(result,prior);
 assert.ok(calls.some((c:any)=>c[0]==='eq'&&c[2]==='2026-10-19'));
 assert.ok(calls.some((c:any)=>c[0]==='lt'&&c[2]==='2026-07-23'));
 assert.ok(calls.findIndex((c:any)=>c[0]==='select')<calls.findIndex((c:any)=>c[0]==='upsert'));
});
test('device upload refuses cross-account paths, bad ratios, SVG and excessive bytes',()=>{
 const png=new Uint8Array(24);png.set([137,80,78,71],0);png.set([73,72,68,82],12);const view=new DataView(png.buffer);view.setUint32(16,1200);view.setUint32(20,1200);
 const item=deviceImageItem(png,'square',CID,U);assert.ok(item);
 assert.equal(privateImageInAccount(item.url,CID),true);assert.equal(privateImageInAccount(item.url,'9876543210'),false);
 assert.equal(deviceImageItem(png,'marketing',CID,U),null);
 assert.equal(deviceImageItem(Buffer.from('<svg>not png</svg>'),'square',CID,U),null);
 assert.equal(deviceImageItem(new Uint8Array(4000001),'square',CID,U),null);
});
test('Customer Match wire carries only normalized SHA256 identifiers and validates consent',async()=>{
 const prepared=prepareCustomerMatchMembers(Array.from({length:100},(_,i)=>({email:`Person${i}@example.com`,phone:'0551234567'})));
 const requests=buildIngestRequests(prepared.members,{customerId:CID,userListId:'12',consentConfirmed:true,termsConfirmed:true,validateOnly:true});
 let wire='';const transport=customerMatchTransport('fixture-token',(async(url:any,init:any)=>{assert.equal(url,'https://datamanager.googleapis.com/v1/audienceMembers:ingest');wire=init.body;return new Response('{"requestId":"r1"}',{status:200});}) as typeof fetch);
 assert.equal((await transport.ingest(requests[0])).requestId,'r1');assert.doesNotMatch(wire,/Person0@|example\.com|0551234567|966551234567/i);assert.equal(JSON.parse(wire).validateOnly,true);
 const raw={user_list_resource:`customers/${CID}/userLists/12`,members:prepared.members,consent_confirmed:true,terms_confirmed:true};
 assert.ok(validateMatchUpload(raw,CID));assert.equal(validateMatchUpload({...raw,consent_confirmed:false},CID),null);
 assert.equal(validateMatchUpload({...raw,members:[{email_sha256:'unhashed@example.com'}]},CID),null);
 assert.equal(validateMatchUpload(raw,'9876543210'),null);
});
test('Zid uses distinct per-store Basic Auth and idempotent event registration',async()=>{
 const env={NEXT_PUBLIC_APP_URL:'https://ai.modaafa.com',ZID_WEBHOOK_URL_SECRET:'url-fixture',ZID_WEBHOOK_USERNAME:'fixture',ZID_WEBHOOK_PASSWORD:'master-fixture'};
 const details=zidWebhookDetails('store-1',env)!;assert.notEqual(details.password,env.ZID_WEBHOOK_PASSWORD);assert.notEqual(details.password,zidWebhookDetails('store-2',env)!.password);
 const posted:any[]=[];const fetchImpl=(async(_url:any,init:any)=>{if(!init.method)return new Response(JSON.stringify({data:[{event:'order.create',target_url:details.url,active:true}]}));posted.push(JSON.parse(init.body));return new Response('{}');}) as typeof fetch;
 const result=await registerZidWebhooks({storeId:'store-1',accessToken:'fixture',authorization:'fixture',fetchImpl,env});assert.equal(result.status,'registered');assert.equal(posted.length,2);assert.ok(posted.every((p)=>p.password===details.password&&p.target_url===details.url));
});
test('structure proposers fail closed on unhealthy tracking and scope all resources',()=>{
 assert.deepEqual(structureCandidates([],[],false,CID),[]);
 const rows=[{campaign:{resourceName:`customers/${CID}/campaigns/1`,status:'ENABLED',advertisingChannelType:'SEARCH',biddingStrategyType:'MAXIMIZE_CONVERSIONS',aiMaxSetting:{enableAiMax:false}},metrics:{conversions:30}}];
 const result=structureCandidates(rows,[],true,CID);assert.equal(result.length,1);assert.equal(result[0].operation,'set_ai_max');
 assert.deepEqual(structureCandidates(rows,[],true,'9876543210'),[]);
});
