import fs from "node:fs";
import path from "node:path";

const root = "F:/3d-models/models";

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (entry.name.toLowerCase() !== "meta.json") continue;
    try {
      const meta = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      const scripts = [
        ...(meta.parameterScripts ?? []),
        ...(meta.animationScripts ?? []),
      ].map((item) => item.scriptFilename).filter(Boolean).join(",");
      const text = JSON.stringify(meta);
      const interesting = /顶升|移载|一体式|HCTS|WLTS|YZJ|lift|transfer|jacking/i.test(text + fullPath);
      console.log(`${interesting ? "*" : " "} ${path.dirname(fullPath)} | name=${meta.name ?? meta.displayName ?? ""} | title=${meta.title ?? ""} | type=${meta.type ?? ""} | scripts=${scripts}`);
    } catch (error) {
      console.log(`! ${fullPath} | ${error.message}`);
    }
  }
}

walk(root);
