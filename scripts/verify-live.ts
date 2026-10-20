/** Real Google Ads validation. Never sends a live mutate, never touches Supabase.
 * npx tsx scripts/verify-live.ts --customer=1234567890 --manager=7561141000
 * Optional --credentials-file=/private/path/.env (never printed), --output=/path/report.json
 */
import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
const arg = (name: string) => process.argv.find((v) => v.startsWith(`--${name}=`))?.slice(name.length+3);
async function main() {
  const path = arg('credentials-file');
  if (path) for (const line of (await readFile(path, 'utf8')).split('\n')) {
    const match = /^([A-Z_0-9]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  process.env.GOOGLE_OAUTH_CLIENT_ID ||= process.env.GOOGLE_ADS_CLIENT_ID;
  process.env.GOOGLE_OAUTH_CLIENT_SECRET ||= process.env.GOOGLE_ADS_CLIENT_SECRET;
  process.env.GOOGLE_OAUTH_REDIRECT_URI ||= 'http://localhost';
  process.env.GOOGLE_ADS_API_VERSION = arg('api-version') ?? 'v23';
  const customerId = String(arg('customer') ?? '').replace(/\D/g, '');
  const manager = String(arg('manager') ?? '7561141000').replace(/\D/g, '');
  if (!/^\d{10}$/.test(customerId) || !process.env.GOOGLE_ADS_REFRESH_TOKEN) throw new Error('Supply --customer and an Ads refresh token via the environment or --credentials-file');
  const root = `customers/${customerId}`; const stamp = Date.now().toString();
  const nativeFetch = globalThis.fetch;
  let validatedRequests = 0;
  let providerErrors: unknown[] = [];
  globalThis.fetch = async (input: any, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.includes('googleads.googleapis.com') && init?.method === 'POST' && !/googleAds:search|geoTargetConstants:suggest/.test(url)) {
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : {};
      if (body.validateOnly !== true) throw new Error('SAFETY: refused a request without validateOnly=true');
      validatedRequests++;
    }
    const response = await nativeFetch(input, init);
    if (!response.ok && url.includes('googleads.googleapis.com')) {
      const data = await response.clone().json().catch(() => ({})) as any;
      providerErrors = (data.error?.details ?? []).flatMap((d: any) => (d.errors ?? []).map((e: any) => ({ code:e.errorCode,message:e.message,location:e.location })));
    }
    return response;
  };
  const [{ getCustomer }, { buildDemandGenPlan }, { buildDemandGenOperations }, { buildLaunchPlan }, { buildPmaxLaunchOperations },
    { planStructure }, { buildUserListOperation }, { experimentCreate }, { pickStr }, { SHOPPING_PRODUCTS_QUERY }] = await Promise.all([
    import('../lib/google-ads/client'), import('../lib/demand-gen/plan'), import('../lib/demand-gen/operations'), import('../lib/launch/plan'), import('../lib/launch/pmax-operations'),
    import('../lib/structure/plan'), import('../lib/audiences/user-lists'), import('../lib/experiments/execute'), import('../lib/growth/types'), import('../lib/shopping/reader'),
  ]);
  const customer: any = getCustomer(customerId, process.env.GOOGLE_ADS_REFRESH_TOKEN!, manager);
  const rows: { check: string; status: 'pass'|'fail'|'blocked'; detail?: string; requests: number }[] = [];
  async function check(name: string, run: () => Promise<unknown>) {
    const before = validatedRequests; providerErrors = [];
    try { await run(); rows.push({ check: name, status: 'pass', requests: validatedRequests-before }); }
    catch (error) { const detail = (error instanceof Error ? error.message : 'unknown') + (providerErrors.length ? ' '+JSON.stringify(providerErrors) : ''); rows.push({ check:name,status:detail.startsWith('BLOCKED:')?'blocked':'fail', detail,requests:validatedRequests-before }); }
    console.log(`${rows.at(-1)!.status.toUpperCase()} ${name}${rows.at(-1)!.detail ? ': '+rows.at(-1)!.detail : ''}`);
  }
  const identity = await customer.query('SELECT customer.id, customer.descriptive_name, customer.currency_code FROM customer LIMIT 1');
  if (pickStr(identity[0], 'customer.currency_code') !== 'SAR' && !process.argv.includes('--allow-non-sar-validation')) throw new Error('Selected account is not SAR; --allow-non-sar-validation validates API shapes only and never relaxes product currency gates');
  const mutate = (operations: unknown[]) => customer.mutateOperations(operations, { validateOnly:true });
  const image = (id: number, w: number, h: number) => ({ asset_operation:{create:{resource_name:`${root}/assets/${id}`,name:`MB validate ${stamp} ${id}`,image_asset:{data:png(w,h).toString('base64')}}} });
  const imageOps = [image(-901,1200,628),image(-902,1200,1200),image(-903,512,512)];
  const images = { marketing_images:[`${root}/assets/1`],square_images:[`${root}/assets/2`],logo_images:[`${root}/assets/3`] };
  function withImages(ops: any[]) { return [...imageOps, ...JSON.parse(JSON.stringify(ops).replaceAll(`${root}/assets/1"`,`${root}/assets/-901"`).replaceAll(`${root}/assets/2"`,`${root}/assets/-902"`).replaceAll(`${root}/assets/3"`,`${root}/assets/-903"`))]; }
  const site = 'https://modaafa.com';
  const headlines = ['إدارة إعلانات قوقل','خطة تسويق لنشاطك','تواصل مع مُضاعفة'];
  const descriptions = ['راجع خطة إعلانات نشاطك مع فريق مُضاعفة','تعرّف على خدمات إدارة إعلانات قوقل لنشاطك'];
  await check('image_asset',async()=>{
    const [{ deviceImageItem }, { validateCreateImageAssets }] = await Promise.all([import('../lib/image-assets/private-storage'), import('../lib/image-assets/execute')]);
    const bytes=png(1200,628); const item=deviceImageItem(bytes,'marketing',customerId,'00000000-0000-4000-8000-000000000000');
    if(!item) throw new Error('Synthetic image failed the product validators');
    return validateCreateImageAssets({images:[item]},customer,{fetchStored:async()=>bytes,resolve:async()=>[],transport:async()=>{throw new Error('Unexpected image network fetch');}} as any);
  });
  const dg = buildDemandGenPlan({name:`MB validate DG ${stamp}`,daily_budget_sar:20,bidding_strategy:'MAXIMIZE_CLICKS',landing_page:site,business_name:'مُضاعفة',headlines,descriptions,...images},{website:site,businessName:'مُضاعفة'});
  await check('demand_gen_campaign_and_image_ad', async()=>{
    if(!dg.executable) throw new Error(JSON.stringify(dg.blockers));
    return mutate(withImages(buildDemandGenOperations(dg,{customerId,campaignName:dg.name,budgetName:dg.name,audienceName:dg.name}).operations));
  });
  const videos = await customer.query("SELECT asset.youtube_video_asset.youtube_video_id FROM asset WHERE asset.type = 'YOUTUBE_VIDEO' LIMIT 1").catch(()=>[]);
  await check('demand_gen_video_ad', async()=>{
    const video = pickStr(videos[0], 'asset.youtube_video_asset.youtube_video_id');
    if (!video) throw new Error('BLOCKED: account has no verified YouTube asset');
    const plan = buildDemandGenPlan({...dgInput(dg),youtube_video:video},{website:site,businessName:'مُضاعفة'});
    if(!plan.executable) throw new Error(JSON.stringify(plan.blockers));
    return mutate(withImages(buildDemandGenOperations(plan,{customerId,campaignName:plan.name,budgetName:plan.name,audienceName:plan.name}).operations));
  });
  const pmax = buildLaunchPlan({ name:`MB validate PMAX ${stamp}`,type:'PMAX',objective:'LEADS',daily_budget_sar:100,language:'ar',landing_page:site,
    ad_groups:[{name:'خدمات',headlines_ar:headlines,descriptions_ar:descriptions}],pmax:{marketing_images:images.marketing_images,square_images:images.square_images,logos:images.logo_images},negative_keywords:[] },
    { brief:'تحقق تقني فقط بدون إنشاء حملة',website:site,businessName:'مُضاعفة',sector:'خدمات',currency:'SAR',signals:{conversions_30d:60,tracking_healthy:true,merchant_center_linked:false,offline_upload_in_place:true},pmaxEnabled:true,
      pmaxInventory:{images:[{resource_name:images.marketing_images[0],width:1200,height:628},{resource_name:images.square_images[0],width:1200,height:1200},{resource_name:images.logo_images[0],width:512,height:512}],videos:[],user_lists:[],custom_audiences:[]} });
  await check('pmax_campaign_asset_group',async()=>{
    if(!pmax.executable) throw new Error(JSON.stringify(pmax.blockers));
    return mutate(withImages(buildPmaxLaunchOperations(pmax,{customerId,campaignName:pmax.name,budgetName:pmax.name}).operations));
  });
  const budgets = await customer.query("SELECT campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.reference_count, campaign_budget.explicitly_shared FROM campaign_budget WHERE campaign_budget.status = 'ENABLED' LIMIT 30");
  const budgetOps = [1,2].map((n)=>({campaign_budget_operation:{create:{resource_name:`${root}/campaignBudgets/-${n+10}`,name:`MB validate ${stamp} ${n}`,amount_micros:100e6,explicitly_shared:false}}}));
  const searchOps = [1,2].map((n)=>({campaign_operation:{create:{resource_name:`${root}/campaigns/-${n+20}`,name:`MB validate Search ${stamp} ${n}`,status:'PAUSED',advertising_channel_type:'SEARCH',campaign_budget:`${root}/campaignBudgets/-${n+10}`,maximize_conversions:{},contains_eu_political_advertising:'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING'}}}));
  const scaffold = [...budgetOps,...searchOps]; const campaign=`${root}/campaigns/-21`; const campaign2=`${root}/campaigns/-22`;
  await check('ai_max',async()=>{
    const search = await customer.query("SELECT campaign.resource_name FROM campaign WHERE campaign.advertising_channel_type = 'SEARCH' AND campaign.status != 'REMOVED' LIMIT 1");
    if (!search[0]) throw new Error('BLOCKED: no Search campaign to validate AI Max update');
    return mutate(planStructure('set_ai_max', { campaign_resource:pickStr(search[0], 'campaign.resource_name'), enabled:true }, { previous:false }).operations);
  });
  await check('shared_budget',()=>mutate([...JSON.parse(JSON.stringify(scaffold).replaceAll('maximize_conversions','target_spend')),...planStructure('create_shared_budget',{name:`MB validate Shared ${stamp}`,amount_micros:200e6},{customer_id:customerId,campaigns:[{resource:campaign,budget:`${root}/campaignBudgets/-11`},{resource:campaign2,budget:`${root}/campaignBudgets/-12`}]}).operations]));
  await check('portfolio_strategy',()=>mutate([...scaffold,...planStructure('create_portfolio_strategy',{name:`MB validate Portfolio ${stamp}`,strategy_type:'MAXIMIZE_CONVERSIONS'},{customer_id:customerId,campaigns:[{resource:campaign,previous:{type:'MAXIMIZE_CONVERSIONS'}},{resource:campaign2,previous:{type:'MAXIMIZE_CONVERSIONS'}}]}).operations]));
  await check('placement_exclusions',()=>mutate(planStructure('add_placement_exclusions',{level:'account'},{to_create:[{kind:'website',value:'example.com'}]}).operations));
  await check('sitelink_and_call_assets',async()=>{
    const { buildAdsStudioOperations }=await import('../lib/ads/studio/execute');
    const build=(type:string,field_type:string,temp:string,spec:any)=>buildAdsStudioOperations({type,params:{campaign_resource:campaign,resolved:{field_type,assets:[{temp,spec}]}}} as any);
    return mutate([...scaffold,...build('add_sitelinks','SITELINK',`${root}/assets/-700`,{final_urls:[`${site}/`],sitelink_asset:{link_text:'خدمات مُضاعفة'}}),
      ...build('add_call_asset','CALL',`${root}/assets/-701`,{call_asset:{country_code:'SA',phone_number:'+966541004029'}})]);
  });
  await check('budget_pair_update',async()=>{
    const { evaluatePairAmounts }=await import('../lib/autopilot/budget-shift');
    const candidates=budgets.filter((b:any)=>Number(b.campaignBudget?.referenceCount)===1 && b.campaignBudget?.explicitlyShared===false);
    let pair:any[]=[],a=0,b=0,shift=0;
    for(let i=0;i<candidates.length&&!pair.length;i++)for(let j=i+1;j<candidates.length;j++){
      const first=candidates[i].campaignBudget,second=candidates[j].campaignBudget;
      const x=Number(first.amountMicros),y=Number(second.amountMicros),move=Math.ceil(Math.max(x,y)*0.05/10000)*10000;
      if(evaluatePairAmounts({from:first.resourceName,to:second.resourceName,fromAmount:x,toAmount:y,shiftMicros:move}).ok){pair=[candidates[i],candidates[j]];a=x;b=y;shift=move;break;}
    }
    if(pair.length<2) throw new Error('BLOCKED: need two single-campaign budgets with a safe 5 to 20 percent paired step');
    const { executeAction }=await import('../lib/ai/optimizer-agent');
    const previous=process.env.AUTONOMY_LEVELS_ENABLED; process.env.AUTONOMY_LEVELS_ENABLED='true';
    try { return await executeAction({type:'shift_budget_pair',params:{from_budget_resource:pair[0].campaignBudget.resourceName,to_budget_resource:pair[1].campaignBudget.resourceName,from_current_micros:a,to_current_micros:b,shift_micros:shift}} as any,customer,{validateOnly:true}); }
    finally { if(previous===undefined)delete process.env.AUTONOMY_LEVELS_ENABLED;else process.env.AUTONOMY_LEVELS_ENABLED=previous; }
  });
  await check('visitor_user_list',()=>mutate([buildUserListOperation({kind:'website_visitors',name:`MB validate visitors ${stamp}`,url_contains:'modaafa.com',lookback_days:30})]));
  const tomorrow=new Date(Date.now()+864e5).toISOString().slice(0,10),end=new Date(Date.now()+60*864e5).toISOString().slice(0,10);
  await check('experiment_create',()=>customer.experiments.mutate([experimentCreate({suffix:' | تحقق',start_date:tomorrow,end_date:end} as any,`MB validate experiment ${stamp}`)],{validateOnly:true}));
  await check('experiment_arms',async()=>{
    const { experimentSetupOperations }=await import('../lib/experiments/execute');
    const search=await customer.query("SELECT campaign.resource_name FROM campaign WHERE campaign.advertising_channel_type = 'SEARCH' AND campaign.status != 'REMOVED' LIMIT 1");
    if(!search[0])throw new Error('BLOCKED: no Search campaign for experiment arms');
    return mutate(experimentSetupOperations({suffix:' | تحقق',start_date:tomorrow,end_date:end,campaign_resource:pickStr(search[0],'campaign.resource_name'),treatment_split:50} as any,`MB validate arms ${stamp}`,customerId));
  });
  await check('experiment_bidding_treatment',async()=>{
    const { treatmentChangeOperations }=await import('../lib/experiments/execute');
    const search=await customer.query("SELECT campaign.resource_name FROM campaign WHERE campaign.advertising_channel_type = 'SEARCH' AND campaign.status != 'REMOVED' LIMIT 1");
    if(!search[0])throw new Error('BLOCKED: no Search campaign for treatment operation shape');
    return mutate(treatmentChangeOperations({change:{type:'bidding',strategy:'MAXIMIZE_CONVERSIONS'}} as any,pickStr(search[0],'campaign.resource_name'),[]));
  });
  await check('experiment_landing_treatment',async()=>{
    const { treatmentChangeOperations }=await import('../lib/experiments/execute');
    const ads=await customer.query("SELECT ad_group_ad.ad.resource_name, ad_group_ad.ad.final_urls FROM ad_group_ad WHERE campaign.advertising_channel_type = 'SEARCH' AND ad_group_ad.status != 'REMOVED' AND ad_group_ad.ad.type = 'RESPONSIVE_SEARCH_AD' LIMIT 1");
    const url=ads[0]?.adGroupAd?.ad?.finalUrls?.[0];
    if(!url)throw new Error('BLOCKED: no Search ad final URL for treatment operation shape');
    return mutate(treatmentChangeOperations({change:{type:'landing_page',final_url:url}} as any,'',[pickStr(ads[0],'ad_group_ad.ad.resource_name')]));
  });
  await check('pmax_listing_groups',async()=>{
    const groups=await customer.query('SELECT asset_group.resource_name FROM asset_group WHERE campaign.advertising_channel_type = \'PERFORMANCE_MAX\' LIMIT 30');
    for(const g of groups){const resource=pickStr(g,'asset_group.resource_name');const roots=await customer.query(`SELECT asset_group_listing_group_filter.resource_name FROM asset_group_listing_group_filter WHERE asset_group_listing_group_filter.asset_group = '${resource}' AND asset_group_listing_group_filter.type = 'UNIT_INCLUDED' LIMIT 1`);if(roots[0]) return mutate(planStructure('subdivide_pmax_listing_group',{asset_group_resource:resource,dimension:'brand',values:['مُضاعفة'],level:1,custom_label_index:null,others:'include'},{customer_id:customerId,asset_group_id:resource.split('/').pop(),root:{resource_name:pickStr(roots[0],'asset_group_listing_group_filter.resource_name')}}).operations);}
    throw new Error('BLOCKED: account has no retail PMax listing group');
  });
  await check('read_policy_topics',()=>customer.query("SELECT ad_group_ad.policy_summary.policy_topic_entries FROM ad_group_ad LIMIT 1"));
  await check('read_shopping_product_fields',()=>customer.query(SHOPPING_PRODUCTS_QUERY));
  await check('read_pmax_url_expansion',()=>customer.query("SELECT campaign.asset_automation_settings FROM campaign WHERE campaign.advertising_channel_type = 'PERFORMANCE_MAX' LIMIT 1"));
  await check('read_expansion_geo',async()=>{ const { readExpansionGeo } = await import('../lib/ai/expansion-geo'); await readExpansionGeo(customer); });
  await check('read_structure_proposals',async()=>{
    const previous = [process.env.STRUCTURE_PROPOSALS_ENABLED, process.env.EXTENDED_ACTIONS_ENABLED];
    process.env.STRUCTURE_PROPOSALS_ENABLED='true'; process.env.EXTENDED_ACTIONS_ENABLED='true';
    try { const { readStructureProposals } = await import('../lib/structure/proposals'); await readStructureProposals(customer, customerId, true); }
    finally { [process.env.STRUCTURE_PROPOSALS_ENABLED, process.env.EXTENDED_ACTIONS_ENABLED] = previous; }
  });
  const adsReader = await import('../lib/ads/assets-reader');
  let readFailures = 0;
  const strictReader = { query: async (sql: string) => {
    try { return await customer.query(sql); }
    catch (error) { readFailures++; throw error; }
  } };
  await check('read_ads_studio_rsa_policy', async () => {
    const before = readFailures;
    const result = await adsReader.readRsaAssets(strictReader);
    if (!result.readable || readFailures !== before) throw new Error('RSA or per-text policy read failed');
  });
  await check('read_ads_studio_extension_coverage', async () => {
    if (await adsReader.readExtensionCoverage(strictReader) === null) throw new Error('Extension coverage read failed');
  });
  await check('read_ads_studio_pmax_assets', async () => {
    if (await adsReader.readAssetGroups(strictReader) === null) throw new Error('PMax asset read failed');
  });
  const report={customerId,manager,apiVersion:process.env.GOOGLE_ADS_API_VERSION,currency:pickStr(identity[0],'customer.currency_code'),identity:pickStr(identity[0],'customer.descriptive_name'),at:new Date().toISOString(),validateOnly:true,liveMutations:0,validatedRequests,checks:rows};
  if(arg('output')) await writeFile(arg('output')!,JSON.stringify(report,null,2));
  if(rows.some((r)=>r.status!=='pass')) process.exitCode=1;
}
function dgInput(p:any){return {name:p.name,daily_budget_sar:p.budget.daily_sar,bidding_strategy:p.bidding.strategy,landing_page:p.final_url,business_name:p.business_name,headlines:p.copy.headlines,long_headlines:['تعرّف على إدارة إعلانات قوقل مع مُضاعفة'],descriptions:p.copy.descriptions,marketing_images:p.images.marketing,square_images:p.images.square,logo_images:p.images.logo};}
function crc(bytes:Buffer){let c=0xffffffff;for(const b of bytes){c^=b;for(let k=0;k<8;k++) c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function png(width:number,height:number){const chunk=(type:string,bytes:Buffer)=>{const t=Buffer.from(type),n=Buffer.alloc(4),c=Buffer.alloc(4);n.writeUInt32BE(bytes.length);c.writeUInt32BE(crc(Buffer.concat([t,bytes])));return Buffer.concat([n,t,bytes,c]);};const ihdr=Buffer.alloc(13);ihdr.writeUInt32BE(width);ihdr.writeUInt32BE(height,4);ihdr[8]=8;ihdr[9]=2;const pixels=Buffer.alloc((width*3+1)*height,100);for(let y=0;y<height;y++)pixels[y*(width*3+1)]=0;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ihdr),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]);}
main().catch((error)=>{console.error(error instanceof Error?error.message:'Verification failed');process.exitCode=1;});
