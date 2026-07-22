import { _electron as electron } from "playwright";
import { resolve } from "node:path";
const cwd=resolve(".");
const app=await electron.launch({
  executablePath: resolve("node_modules/electron/dist/electron.exe"),
  args:["."],cwd,
  env:{...process.env,VITE_DEV_SERVER_URL:"http://127.0.0.1:41789",VITE_DEV_SERVER_PORT:"41789"},
});
try{
  const win=await app.firstWindow({timeout:30000});
  await win.waitForLoadState("domcontentloaded");
  await win.waitForTimeout(6000);
  const state=await win.evaluate(()=>({title:document.title,bodyText:document.body.innerText.slice(0,12000),buttons:[...document.querySelectorAll("button")].map((el)=>({text:el.innerText,aria:el.getAttribute("aria-label"),title:el.getAttribute("title")})).slice(0,200),inputs:[...document.querySelectorAll("input")].map((el)=>({type:el.type,value:el.value,placeholder:el.placeholder,aria:el.getAttribute("aria-label")})).slice(0,100)}));
  await win.screenshot({path:resolve("output/yzj-electron-initial.png")});
  console.log(JSON.stringify(state,null,2));
}finally{await app.close().catch(()=>{});}
