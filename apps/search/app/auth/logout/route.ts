import {NextResponse} from 'next/server';
import {serverClient} from '../../../lib/supabase/server';
import {sameOrigin} from '../../../lib/request';
export async function POST(request:Request){if(!sameOrigin(request))return NextResponse.json({error:'Invalid request origin'},{status:403});const client=await serverClient();const {error}=await client.auth.signOut();if(error)return NextResponse.json({error:'Sign out failed'},{status:500});return NextResponse.redirect(new URL('/login',request.url),303);}
