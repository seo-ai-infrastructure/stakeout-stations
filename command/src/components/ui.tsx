import {useEffect,useRef,type ReactNode} from 'react';
import {X,Smartphone,Crosshair} from 'lucide-react';
export function Brand(){return <div className="brand"><Crosshair size={38} strokeWidth={1.5}/><div>Stakeout<small>COMMAND</small></div></div>;}
export function Badge({status}:{status:string}){return <span className={`badge ${status}`}><i/>{status.replaceAll('_',' ')}</span>;}
export function Phone({small=false}:{small?:boolean}){return <span className={`phone ${small?'small':''}`}><Smartphone size={small?18:27} strokeWidth={1.5}/></span>;}
export function Progress({value}:{value:number}){return <div className="progress"><span style={{width:`${Math.max(0,Math.min(100,value))}%`}}/></div>;}
export function Empty({title,detail,action}:{title:string;detail:string;action?:ReactNode}){return <div className="empty"><Crosshair size={30}/><h3>{title}</h3><p>{detail}</p>{action}</div>;}
export function Modal({title,subtitle,children,onClose,wide=false}:{title:string;subtitle?:string;children:ReactNode;onClose:()=>void;wide?:boolean}){const ref=useRef<HTMLDialogElement>(null);useEffect(()=>{ref.current?.showModal();return()=>ref.current?.close();},[]);return <dialog ref={ref} className={wide?'wide':''} onCancel={onClose} onClick={e=>{if(e.target===e.currentTarget)onClose();}}><div className="modal-head"><div><h2>{title}</h2>{subtitle&&<p>{subtitle}</p>}</div><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}</dialog>;}
export function timeAgo(value:string){const mins=Math.max(0,Math.floor((Date.now()-Date.parse(value))/60000));return mins<1?'Just now':mins<60?`${mins}m ago`:`${Math.floor(mins/60)}h ago`;}
export function formatTime(value:string,zone='America/New_York'){return new Date(value).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit',timeZone:zone});}
