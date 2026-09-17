import Login from '../../components/login';
import {configured} from '../../lib/supabase/server';
export default function Page(){return <Login enabled={configured()}/>;}
export const dynamic='force-dynamic';
