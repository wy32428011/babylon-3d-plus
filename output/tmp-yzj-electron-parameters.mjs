import { _electron as electron } from "playwright";
import { resolve } from "node:path";
const cwd=resolve(".");const app=await electron.launch({executablePath:resolve("node_modules/electron/dist/electron.exe"),args:["."],cwd,env:{...process.env,VITE_DEV_SERVER_URL:"http://127.0.0.1:41789",VITE_DEV_SERVER_PORT:"41789"}});
const consoleErrors=[];
try{
 const win=await app.firstWindow({timeout:30000});win.on("console",(message)=>{if(message.type()==="error")consoleErrors.push(message.text());});win.on("pageerror",(error)=>consoleErrors.push(error.stack??error.message));await win.waitForLoadState("domcontentloaded");
 await win.getByRole("button",{name:"打开",exact:true}).first().click();await win.waitForTimeout(6500);
 const card=win.locator("button.resource-card").filter({has:win.locator("strong",{hasText:/^YZJ$/})});if(await card.count()!==1)throw new Error(`YZJ card count=${await card.count()}`);await card.click();
 const fieldset=win.locator("fieldset.model-parameters-fieldset");await fieldset.waitFor({state:"visible",timeout:30000});await win.waitForTimeout(7000);
 const readFields=()=>fieldset.evaluate((root)=>[...root.querySelectorAll("label, .texture-parameter-row")].map((row)=>{const label=row.querySelector("span")?.textContent?.trim()??"";const input=row.querySelector("input,select");return{label,type:input?.getAttribute("type")??input?.tagName?.toLowerCase()??null,value:input instanceof HTMLInputElement?(input.type==="checkbox"?input.checked:input.value):input instanceof HTMLSelectElement?input.value:null,disabled:input?.hasAttribute("disabled")??false};}).filter((item)=>item.label));
 const before=await readFields();
 await win.screenshot({path:resolve("output/yzj-electron-parameters-initial.png")});await fieldset.screenshot({path:resolve("output/yzj-electron-inspector-fields.png")});
 const lengthInput=fieldset.getByRole("spinbutton",{name:"长度",exact:true});await lengthInput.fill("2.3");await lengthInput.blur();
 const colorInput=fieldset.getByLabel("主体颜色",{exact:true});await colorInput.fill("#b35f43");await colorInput.blur();
 const motorInput=fieldset.getByRole("checkbox",{name:"显示电机",exact:true});if(await motorInput.isChecked())await motorInput.uncheck();
 await win.waitForTimeout(3500);
 const after=await readFields();
 await win.screenshot({path:resolve("output/yzj-electron-parameters-updated.png")});await win.locator("canvas").first().screenshot({path:resolve("output/yzj-electron-canvas-updated.png")});
 const result={before,after,consoleErrors,checks:{labels:before.map((item)=>item.label),lengthBefore:before.find((item)=>item.label==="长度")?.value,lengthAfter:after.find((item)=>item.label==="长度")?.value,colorBefore:before.find((item)=>item.label==="主体颜色")?.value,colorAfter:after.find((item)=>item.label==="主体颜色")?.value,motorBefore:before.find((item)=>item.label==="显示电机")?.value,motorAfter:after.find((item)=>item.label==="显示电机")?.value}};
 console.log(JSON.stringify(result,null,2));
 if(consoleErrors.length||result.checks.lengthAfter!=="2.3"||String(result.checks.colorAfter).toLowerCase()!=="#b35f43"||result.checks.motorAfter!==false)process.exitCode=2;
}finally{await app.close().catch(()=>{});}
