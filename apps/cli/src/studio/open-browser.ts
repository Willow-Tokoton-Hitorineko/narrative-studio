import {execFile} from 'node:child_process';
import path from 'node:path';

/** Delegate a local Studio URL to Windows' registered browser without cmd/start quoting. */
export async function openStudioBrowser(url:string,execute:typeof execFile=execFile):Promise<void>{
 const parsed=new URL(url);
 if(parsed.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(parsed.hostname)||parsed.username||parsed.password)throw new Error('Only local Studio URLs can be opened');
 const powershell=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
 await new Promise<void>((resolve,reject)=>{
  execute(powershell,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Start-Process -FilePath $env:NS_STUDIO_BROWSER_URL"],{
   env:{...process.env,NS_STUDIO_BROWSER_URL:url},windowsHide:true,timeout:10000,
  },error=>error?reject(error):resolve());
 });
}
