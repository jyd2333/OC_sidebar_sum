import solid from "@opentui/solid/bun-plugin";

const result = await Bun.build({
  entrypoints: ["./tui.tsx"],
  outdir: "./dist",
  target: "bun",
  packages: "external",
  plugins: [solid],
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
