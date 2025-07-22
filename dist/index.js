import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// We want to make sure that Node.js built-in modules are prefixed with 'node:'
function fixNodeImports(content) {
  let fixed = content;

  builtinModules.forEach((module) => {
    const patterns = [
      new RegExp(`require\\(['"]${module}['"]\\)`, "g"),
      new RegExp(`require\\(['"]${module}/`, "g"),
      new RegExp(`from ['"]${module}['"]`, "g"),
      new RegExp(`from ['"]${module}/`, "g"),
      new RegExp(`import\\(['"]${module}['"]\\)`, "g"),
      new RegExp(`import\\(['"]${module}/`, "g"),
    ];

    patterns.forEach((pattern) => {
      fixed = fixed.replace(pattern, (match) => {
        return match
          .replace(`'${module}`, `'node:${module}`)
          .replace(`"${module}`, `"node:${module}`);
      });
    });
  });

  return fixed;
}

async function reassembleParts(dir) {
  console.log("Reassembling parts in: " + dir);
  if (!fs.existsSync(dir)) {
    console.log("No files to reassemble.");
    return;
  }
  let files = fs.readdirSync(dir);
  const partGroups = {};
  files.forEach((file) => {
    console.log("Checking file: " + file);
    const match = file.match(/^(.*)\.part(\d+)$/);
    if (match) {
      const base = match[1];
      if (!partGroups[base]) partGroups[base] = [];
      partGroups[base].push({ file, index: parseInt(match[2], 10) });
    }
  });

  for (const base in partGroups) {
    const parts = partGroups[base].sort((a, b) => a.index - b.index);
    const outPath = path.join(dir, base);
    const writeStream = fs.createWriteStream(outPath);

    for (const part of parts) {
      const partPath = path.join(dir, part.file);
      const data = fs.readFileSync(partPath);
      writeStream.write(data);
    }
    writeStream.end();

    await new Promise((resolve, reject) => {
      writeStream.on("finish", resolve);
      writeStream.on("error", reject);
    });

    parts.forEach((part) => fs.unlinkSync(path.join(dir, part.file)));
    console.log(`Reassembled ${outPath}`);
  }

  files = fs.readdirSync(dir);
  files.forEach((file) => {
    console.log("[POST GENERATION] Checking file: " + file);
    if (file.endsWith(".js") || file.endsWith(".mjs")) {
      console.log(`Fixing Node.js imports in ${file}`);
      const content = fs.readFileSync(file, "utf8");
      const fixedContent = fixNodeImports(content);
      fs.writeFileSync(file, fixedContent, "utf8");
      console.log(`Fixed Node.js imports in ${file}`);
    }
  });

  try {
    await import("./plugin/index.js");
    console.log("Plugin loaded successfully");
  } catch (err) {
    console.error("Failed to load plugin:", err);
  }
}

reassembleParts(path.join(__dirname, "./plugin")).catch((err) => {
  console.error("Error during reassembly:", err);
});
