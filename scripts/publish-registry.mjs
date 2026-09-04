import { execFileSync } from "node:child_process";
import process from "node:process";

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const bucket = option("--bucket") ?? "dominaitrix-registry";
const region = option("--region") ?? "us-east-1";

if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
  throw new Error(`Invalid S3 bucket name: ${bucket}`);
}

run(process.execPath, ["scripts/build-registry.mjs"]);

const destination = `s3://${bucket}`;
const syncArgs = ["s3", "sync", "registry", destination, "--delete", "--region", region];
if (!apply) syncArgs.push("--dryrun");

console.log(apply ? `Publishing registry to ${destination}` : `Previewing registry changes for ${destination}`);
run("aws", syncArgs);

if (apply) {
  run("aws", [
    "s3", "cp", "registry/index.json", `${destination}/index.json`,
    "--region", region,
    "--content-type", "application/json",
    "--cache-control", "no-cache",
  ]);
  console.log(`Published. Registry URL: https://${bucket}.s3.${region}.amazonaws.com/index.json`);
} else {
  console.log("Dry run only. Re-run with --apply to upload these changes.");
}

function option(name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function run(command, commandArgs) {
  execFileSync(command, commandArgs, { stdio: "inherit" });
}
