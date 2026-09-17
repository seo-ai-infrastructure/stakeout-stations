import {isDeepStrictEqual} from 'node:util';
import {NextResponse} from 'next/server';
import {authenticated,sameOrigin} from '../../../lib/request';
import {campaignInput} from '../../../lib/campaign-input';
export async function GET(request:Request){
 const auth=await authenticated();if(auth.error)return auth.error;
 const orgId=new URL(request.url).searchParams.get('orgId');if(!orgId)return NextResponse.json({error:'Choose a workspace'},{status:400});
 const {data,error}=await auth.client.from('search_campaigns').select('id,configuration,created_at,status').eq('org_id',orgId).order('created_at',{ascending:false}).limit(200);
 if(error)return NextResponse.json({error:'Campaigns could not be loaded'},{status:500});
 return NextResponse.json({campaigns:data.map(row=>({...row.configuration,id:row.id,createdAt:row.created_at,status:row.status}))},{headers:{'Cache-Control':'private, no-store'}});
}
export async function POST(request:Request){
 if(!sameOrigin(request))return NextResponse.json({error:'Invalid request origin'},{status:403});
 const auth=await authenticated();if(auth.error)return auth.error;
 const raw=await request.text();if(raw.length>50000)return NextResponse.json({error:'Campaign is too large'},{status:413});
 let body;try{body=JSON.parse(raw);}catch{return NextResponse.json({error:'Invalid JSON'},{status:400});}
 const parsed=campaignInput.safeParse(body);if(!parsed.success)return NextResponse.json({error:parsed.error.issues[0].message},{status:400});
 const {id,orgId,...configuration}=parsed.data;
 const {data:membership}=await auth.client.from('org_members').select('role').eq('org_id',orgId).eq('user_id',auth.user.id).single();
 if(!membership||!['owner','admin'].includes(membership.role))return NextResponse.json({error:'Workspace owner or admin access required'},{status:403});
 const {data,error}=await auth.client.from('search_campaigns').insert({id,org_id:orgId,created_by:auth.user.id,configuration}).select('id,configuration,created_at,status').single();
 if(error){if(error.code==='23505'){const {data:existing}=await auth.client.from('search_campaigns').select('id,configuration,created_at,status').eq('id',id).eq('org_id',orgId).single();if(existing&&isDeepStrictEqual(existing.configuration,configuration))return NextResponse.json({campaign:{...existing.configuration,id:existing.id,createdAt:existing.created_at,status:existing.status}});return NextResponse.json({error:'This campaign already exists; refresh to load it.'},{status:409});}return NextResponse.json({error:'Campaign could not be saved'},{status:500});}
 return NextResponse.json({campaign:{...data.configuration,id:data.id,createdAt:data.created_at,status:data.status}},{status:201});
}
