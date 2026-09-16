import {redirect} from 'next/navigation';
import {configured,serverClient} from '../lib/supabase/server';
import AccountWorkspace from '../components/account-workspace';
export default async function Page(){if(!configured())redirect('/login');const client=await serverClient();const {data}=await client.auth.getUser();if(!data.user||data.user.is_anonymous)redirect('/login');return <AccountWorkspace email={data.user.email||''}/>;}
export const dynamic='force-dynamic';
