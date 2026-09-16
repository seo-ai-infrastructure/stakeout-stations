import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'Stakeout Search · Campaign Command Center', description: 'Inspect mobile search observations, compare competitors, and review capture evidence.' };
export default function Layout({children}:{children:React.ReactNode}) { return <html lang="en"><body>{children}</body></html>; }
