#!/usr/bin/env node
// Allow Devin Enterprise's official REST origin (https://api.devinenterprise.com) in
// @buyong/pi-devin/src/core/client.ts. Upstream 0.1.16 only trusts https://api.devin.ai
// and https://server.codeium.com, which makes every pre-request GetUserStatus check fail
// on TEAMS_TIER_DEVIN_ENTERPRISE accounts with:
//   "Unverified REST server. Specify it explicitly with --rest-server."
import fs from "node:fs";

const file = process.argv[2];
if (!file) {
  console.error("usage: devin-enterprise-rest.mjs <client.ts>");
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.log("skip\tno client.ts");
  process.exit(0);
}

const ENTERPRISE_REST_ORIGIN = "https://api.devinenterprise.com";
const source = fs.readFileSync(file, "utf8");

if (source.includes(ENTERPRISE_REST_ORIGIN)) {
  console.log("unchanged\talready allows api.devinenterprise.com");
  process.exit(0);
}

const target = "if (candidate !== restBaseURL && candidate !== transport.baseURL)";
const replacement = `if (candidate !== restBaseURL && candidate !== transport.baseURL && candidate !== "${ENTERPRISE_REST_ORIGIN}")`;

if (!source.includes(target)) {
  console.log("skip\tunrecognized REST origin check in client.ts");
  process.exit(0);
}

const rewritten = source.replace(target, replacement);
fs.writeFileSync(file, rewritten);
console.log("patched\tallowed https://api.devinenterprise.com");
