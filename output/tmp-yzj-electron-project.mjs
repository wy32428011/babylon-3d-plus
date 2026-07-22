import { _electron as electron } from "playwright";
import { resolve } from "node:path";
const cwd=resolve(".");const app=await electron.launch({executablePath:resolve("node_modules/electron/dist/electron.exe"),args:["."],cwd,env:{...process.env,VITE_DEV_SERVER_URL:"http://127.0.0.1:41789",VITE_DEV_SERVER_PORT:"41789"}});
try{
 const win=await app.firstWindow({timeout:30000});await win.waitForLoadState("domcontentloaded");
 await win.getByRole("button",{name:"打开",exact:true}).first().click();
 await win.waitForTimeout(8000);
 const state=await win.evaluate(()=>({title:document.title,bodyText:document.body.innerText.slice(0,20000),buttons:[...document.querySelectorAll("button")].map((el,i)=>({i,text:el.innerText.trim(),aria:el.getAttribute("aria-label"),title:el.getAttribute("title"),className:el.className})).filter((x)=>x.text||x.aria||x.title).slice(0,400),cards:[...document.querySelectorAll('[class*="asset"],[class*="card"],[draggable="true"]')].map((el)=>({tag:el.tagName,text:el.innerText.trim().slice(0,300),className:el.className,draggable:el.getAttribute("draggable")})).filter((x)=>x.text).slice(0,250)}));
 await win.screenshot({path:resolve("output/yzj-electron-project.png")});console.log(JSON.stringify(state,null,2));
}finally{await app.close().catch(()=>{});}
