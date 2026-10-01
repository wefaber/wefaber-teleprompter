/** Arma la página del iPhone en dist-phone/, que sirve src-tauri/src/phone.rs. */

const root = `${import.meta.dir}/../`;

const result = await Bun.build({
  entrypoints: [`${root}phone/main.ts`],
  outdir: `${root}dist-phone`,
  naming: "app.js",
  target: "browser",
  minify: true,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
await Bun.write(`${root}dist-phone/index.html`, Bun.file(`${root}phone/index.html`));
console.log("dist-phone listo");
