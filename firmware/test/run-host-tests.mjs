#!/usr/bin/env node
// Builds and runs the firmware's hardware-free tests on this computer. No board and no
// PlatformIO needed, only a C++17 compiler on PATH (g++, c++ or clang++).
//
//   node firmware/test/run-host-tests.mjs
//
// Every test/host/*.cpp is its own small program that includes headers from
// firmware/include and returns non-zero when a check fails. test/host/shim holds a
// stand-in <Arduino.h> for the one test that builds a file from firmware/src.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const hostDir = join(here, "host");
const includeDir = join(here, "..", "include");

function findCompiler() {
  for (const cc of ["g++", "c++", "clang++"]) {
    const r = spawnSync(cc, ["--version"], { encoding: "utf8" });
    if (!r.error && r.status === 0) return cc;
  }
  return null;
}

const cc = findCompiler();
if (!cc) {
  console.error("No C++ compiler found. Put g++, c++ or clang++ on PATH.");
  process.exit(2);
}

const tests = readdirSync(hostDir).filter((f) => f.endsWith(".cpp")).sort();
if (tests.length === 0) {
  console.error(`No tests found in ${hostDir}`);
  process.exit(2);
}

// The binaries go to a temp folder that is removed at the end.
const outDir = mkdtempSync(join(tmpdir(), "vette-host-tests-"));
const exe = process.platform === "win32" ? ".exe" : "";
// MinGW: link the runtime in, so a different libstdc++ DLL earlier on PATH cannot break the run.
const extra = process.platform === "win32" && cc !== "clang++" ? ["-static"] : [];

let failed = 0;
try {
  for (const file of tests) {
    const name = file.replace(/\.cpp$/, "");
    const bin = join(outDir, name + exe);
    const build = spawnSync(
      cc,
      ["-std=c++17", "-Wall", "-Wextra", "-O1", ...extra, "-I", includeDir, "-I", hostDir, "-I", join(hostDir, "shim"), "-o", bin, join(hostDir, file)],
      { encoding: "utf8" },
    );
    if (build.stdout) process.stdout.write(build.stdout);
    if (build.stderr) process.stderr.write(build.stderr);
    if (build.error || build.status !== 0) {
      console.log(`${name}: DID NOT COMPILE`);
      failed++;
      continue;
    }
    const run = spawnSync(bin, [], { encoding: "utf8", timeout: 120000 });
    if (run.stdout) process.stdout.write(run.stdout);
    if (run.stderr) process.stderr.write(run.stderr);
    if (run.error || run.status !== 0) {
      console.log(`${name}: FAILED${run.error ? ` (${run.error.message})` : ""}`);
      failed++;
    }
  }
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} of ${tests.length} host tests FAILED (${cc})` : `\nall ${tests.length} host tests passed (${cc})`);
process.exit(failed ? 1 : 0);
